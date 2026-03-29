'use strict';

// content-main.js – Main-world content script
// Runs in Chrome's MAIN JavaScript world so it can intercept and wrap the
// page's own scheduling APIs, constructors, and network APIs.
// Communicates with content.js (isolated world) via CustomEvents on document.

(function () {
  // ─── Constants ─────────────────────────────────────────────────────────────
  const EVT = 'edgewatch:';

  const COMPUTE_BUDGET_MS = 2000;   // 2 s total JS execution per navigation
  const MAX_IMAGES        = 200;
  const MAX_DOM_NODES     = 10_000;
  const MAX_WORKERS       = 4;
  const PRESSURE_THRESHOLD = 100;
  const DOM_CHECK_INTERVAL_MS = 1000;
  const PRESSURE_DECAY_INTERVAL_MS = 1000;
  const PRESSURE_DECAY_FACTOR = 0.8;

  // ─── State ─────────────────────────────────────────────────────────────────
  let enforcing  = true;   // false while "allow once" is active
  let jsDisabled = false;
  let computeMs  = 0;
  let imageCount = 0;
  let workerCount = 0;
  let pressure   = 0;

  /** @type {HTMLDivElement|null} */
  let overlay = null;

  // ─── Preserve native APIs before any page script can redefine them ─────────
  const _setTimeout           = window.setTimeout.bind(window);
  const _setInterval          = window.setInterval.bind(window);
  const _clearTimeout         = window.clearTimeout.bind(window);
  const _clearInterval        = window.clearInterval.bind(window);
  const _rAF                  = window.requestAnimationFrame.bind(window);
  const _rIC                  = window.requestIdleCallback
                                  ? window.requestIdleCallback.bind(window)
                                  : null;
  const _Worker               = window.Worker;
  const _SharedWorker         = window.SharedWorker;
  const _Image                = window.Image;
  const _fetch                = window.fetch.bind(window);
  const _XMLHttpRequest       = window.XMLHttpRequest;

  // ─── Communication helpers ─────────────────────────────────────────────────
  /** Dispatch a custom event on document so content.js (isolated world) can
   *  pick it up and forward it to the background service worker. */
  function sendToIsolated(name, detail) {
    document.dispatchEvent(
      new CustomEvent(`${EVT}${name}`, { detail: detail ?? {} }),
    );
  }

  // ─── Compute budget ─────────────────────────────────────────────────────────
  function accumulateCompute(ms) {
    if (!enforcing || jsDisabled) return;
    computeMs += ms;
    sendToIsolated('compute_update', { computeMs });

    // Long task (>50 ms) increases pressure score
    if (ms > 50) {
      addPressure(20, 'long_task');
    }

    if (computeMs >= COMPUTE_BUDGET_MS) {
      triggerDisableJS('compute budget exceeded');
    }
  }

  // ─── Pressure score ─────────────────────────────────────────────────────────
  function addPressure(amount, reason) {
    if (!enforcing || jsDisabled) return;
    pressure += amount;
    sendToIsolated('pressure_update', { pressure: Math.round(pressure) });
    if (pressure > PRESSURE_THRESHOLD) {
      triggerDisableJS(`pressure threshold exceeded (${reason})`);
    }
  }

  function triggerDisableJS(reason) {
    if (jsDisabled) return;
    jsDisabled = true;
    sendToIsolated('disable_js_request', { reason });
    disableJS();
  }

  // ─── Wrap scheduling APIs ────────────────────────────────────────────────────
  /** Returns a wrapped version of fn that measures its execution time. */
  function wrapCallback(fn) {
    if (typeof fn !== 'function') return fn;
    return function (...args) {
      const start = performance.now();
      try {
        return fn.apply(this, args);
      } finally {
        accumulateCompute(performance.now() - start);
      }
    };
  }

  window.setTimeout = function (fn, delay, ...rest) {
    if (jsDisabled) return 0;
    return _setTimeout(wrapCallback(fn), delay, ...rest);
  };

  window.setInterval = function (fn, delay, ...rest) {
    if (jsDisabled) return 0;
    return _setInterval(wrapCallback(fn), delay, ...rest);
  };

  window.clearTimeout  = _clearTimeout;
  window.clearInterval = _clearInterval;

  window.requestAnimationFrame = function (fn) {
    if (jsDisabled) return 0;
    return _rAF(wrapCallback(fn));
  };

  if (_rIC) {
    window.requestIdleCallback = function (fn, opts) {
      if (jsDisabled) return 0;
      return _rIC(wrapCallback(fn), opts);
    };
  }

  // ─── Worker tracking (Proxy for correct prototype chain) ────────────────────
  if (_Worker) {
    window.Worker = new Proxy(_Worker, {
      construct(Target, args) {
        workerCount++;
        addPressure(30, 'new Worker');
        sendToIsolated('resource_update', { workers: workerCount });
        if (workerCount > MAX_WORKERS) {
          triggerDisableJS('worker limit exceeded');
        }
        return new Target(...args);
      },
    });
  }

  if (_SharedWorker) {
    window.SharedWorker = new Proxy(_SharedWorker, {
      construct(Target, args) {
        workerCount++;
        addPressure(30, 'new SharedWorker');
        sendToIsolated('resource_update', { workers: workerCount });
        if (workerCount > MAX_WORKERS) {
          triggerDisableJS('worker limit exceeded');
        }
        return new Target(...args);
      },
    });
  }

  // ─── Image constructor tracking ──────────────────────────────────────────────
  if (_Image) {
    window.Image = new Proxy(_Image, {
      construct(Target, args) {
        imageCount++;
        if (imageCount % 10 === 0) {
          addPressure(15, '10 new images');
        }
        sendToIsolated('resource_update', { images: imageCount });
        if (imageCount > MAX_IMAGES) {
          triggerDisableJS('image limit exceeded');
        }
        return new Target(...args);
      },
    });
  }

  // ─── MutationObserver: track <img> elements added to the DOM ───────────────
  const mutationObserver = new MutationObserver((mutations) => {
    if (!enforcing || jsDisabled) return;
    let newImages = 0;
    let addedNodes = 0;
    for (const mutation of mutations) {
      addedNodes += mutation.addedNodes.length;
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue; // Element nodes only
        if (node.tagName === 'IMG') newImages++;
        newImages += node.querySelectorAll?.('img').length ?? 0;
      }
    }
    if (newImages > 0) {
      imageCount += newImages;
      if (imageCount % 10 === 0) addPressure(15, '10 new images via DOM');
      sendToIsolated('resource_update', { images: imageCount });
      if (imageCount > MAX_IMAGES) {
        triggerDisableJS('image limit exceeded via DOM');
      }
    }
    // Burst of DOM mutations adds pressure
    if (addedNodes > 10) {
      addPressure(10, 'burst of DOM mutations');
    }
  });

  function startMutationObserver() {
    const target = document.body || document.documentElement;
    if (target) {
      mutationObserver.observe(target, { childList: true, subtree: true });
    }
  }

  if (document.body) {
    startMutationObserver();
  } else {
    document.addEventListener('DOMContentLoaded', startMutationObserver);
  }

  // ─── Periodic DOM node count (once per second) ──────────────────────────────
  _setInterval(() => {
    if (!enforcing || jsDisabled) return;
    const domNodes = document.getElementsByTagName('*').length;
    sendToIsolated('resource_update', { domNodes });
    if (domNodes > MAX_DOM_NODES) {
      triggerDisableJS('DOM node limit exceeded');
    }
  }, DOM_CHECK_INTERVAL_MS);

  // ─── Pressure decay (once per second) ───────────────────────────────────────
  _setInterval(() => {
    if (!enforcing || jsDisabled) return;
    pressure *= PRESSURE_DECAY_FACTOR;
    sendToIsolated('pressure_update', { pressure: Math.round(pressure) });
  }, PRESSURE_DECAY_INTERVAL_MS);

  // ─── Listen for events from the isolated world ──────────────────────────────
  // "allow once": skip enforcement for this navigation
  document.addEventListener(`${EVT}allow_once`, () => {
    enforcing = false;
    if (jsDisabled) {
      jsDisabled = false;
      hideOverlay();
    }
  });

  // Network burst reported by background (5+ requests in 1 s)
  document.addEventListener(`${EVT}network_burst`, () => {
    addPressure(10, 'network request burst');
  });

  // ─── JS disablement ──────────────────────────────────────────────────────────
  function disableJS() {
    // Replace scheduling APIs with inert stubs
    window.setTimeout           = () => 0;
    window.setInterval          = () => 0;
    window.requestAnimationFrame = () => 0;
    if (_rIC) window.requestIdleCallback = () => 0;

    // Replace network APIs with stubs that fail immediately
    window.fetch = () =>
      Promise.reject(new Error('[EdgeWatch] JavaScript execution paused.'));
    window.XMLHttpRequest = class {
      open()            {}
      send()            {}
      abort()           {}
      addEventListener(){}
      removeEventListener(){}
      setRequestHeader(){}
      get readyState()  { return 0; }
      get status()      { return 0; }
    };

    // Replace Worker / SharedWorker with inert stubs
    window.Worker = class {
      constructor()     {}
      postMessage()     {}
      terminate()       {}
      addEventListener(){}
      removeEventListener(){}
    };
    if (_SharedWorker) {
      window.SharedWorker = class {
        constructor() {}
        get port()    { return { postMessage() {}, start() {} }; }
      };
    }

    // Block WebAssembly and WebGL context creation
    if (window.WebAssembly) {
      window.WebAssembly = {
        compile:       () => Promise.reject(new Error('[EdgeWatch] paused')),
        instantiate:   () => Promise.reject(new Error('[EdgeWatch] paused')),
        compileStreaming:   () => Promise.reject(new Error('[EdgeWatch] paused')),
        instantiateStreaming: () => Promise.reject(new Error('[EdgeWatch] paused')),
      };
    }
    const origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') {
        return null;
      }
      return origGetContext.call(this, type, ...args);
    };

    // Stop observers to avoid further callbacks
    mutationObserver.disconnect();

    // Show full-page overlay
    showOverlay();
  }

  // ─── Overlay ──────────────────────────────────────────────────────────────────
  function showOverlay() {
    if (overlay) return;

    overlay = document.createElement('div');
    overlay.id = 'edgewatch-overlay';
    overlay.setAttribute('style', [
      'position:fixed',
      'inset:0',
      'width:100%',
      'height:100%',
      'background:rgba(15,15,15,0.92)',
      'color:#fff',
      'z-index:2147483647',
      'display:flex',
      'flex-direction:column',
      'align-items:center',
      'justify-content:center',
      'font-family:system-ui,-apple-system,sans-serif',
      'font-size:16px',
      'text-align:center',
      'padding:20px',
      'box-sizing:border-box',
    ].join(';'));

    overlay.innerHTML = `
      <div style="max-width:480px;background:rgba(255,255,255,0.07);border-radius:12px;padding:32px 28px;box-shadow:0 8px 32px rgba(0,0,0,0.5);">
        <div style="font-size:52px;margin-bottom:16px;">⚠️</div>
        <h2 style="margin:0 0 12px;font-size:22px;font-weight:700;letter-spacing:-0.01em;">
          Behaviour Budget Exceeded
        </h2>
        <p style="margin:0 0 28px;opacity:0.8;line-height:1.6;">
          This page exceeded its behaviour budget.<br>
          JavaScript has been paused to protect your browser.
        </p>
        <button id="edgewatch-allow-btn" style="
          background:#22c55e;
          border:none;color:#fff;
          padding:12px 28px;
          font-size:15px;
          font-weight:600;
          border-radius:8px;
          cursor:pointer;
          letter-spacing:0.01em;
          box-shadow:0 2px 8px rgba(34,197,94,0.4);
        ">Temporarily allow this page</button>
      </div>
    `;

    function attachOverlay() {
      (document.body || document.documentElement).appendChild(overlay);
      document.getElementById('edgewatch-allow-btn')?.addEventListener('click', () => {
        sendToIsolated('reenable_js_request', {});
      });
    }

    if (document.body) {
      attachOverlay();
    } else {
      document.addEventListener('DOMContentLoaded', attachOverlay);
    }
  }

  function hideOverlay() {
    overlay?.remove();
    overlay = null;
  }
})();
