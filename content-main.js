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
  const METRICS_REFRESH_MS = 1000;
  const DEFAULT_DATA_BUDGET_BYTES = 50 * 1024 * 1024;
  const NETWORK_REQUESTS_REFERENCE = 250;
  const VIDEO_STREAMS_REFERENCE = 8;
  const MAX_CONSOLE_LOGS = 500;
  const MAX_CONSOLE_WARNINGS = 200;
  const MAX_CONSOLE_ERRORS = 100;
  const NETWORK_DATA_INCREMENT_BYTES = 50 * 1024 * 1024;
  const NETWORK_REQUESTS_INCREMENT = 100;
  const COMPUTE_INCREMENT_MS = 1000;
  const IMAGES_INCREMENT = 50;
  const VIDEO_STREAMS_INCREMENT = 2;
  const DOM_NODES_INCREMENT = 1000;
  const WORKERS_INCREMENT = 1;
  const CONSOLE_LOGS_INCREMENT = 100;
  const CONSOLE_WARNINGS_INCREMENT = 50;
  const CONSOLE_ERRORS_INCREMENT = 25;
  const PRESSURE_INCREMENT = 250;
  const CAPACITY_OVERRIDES_STORAGE_KEY = 'edgewatch_capacity_overrides';
  const HUD_EXPANDED_STORAGE_KEY = 'edgewatch_hud_expanded';

  // ─── State ─────────────────────────────────────────────────────────────────
  // Start suspended: enforcement is enabled only after the first settings_update
  // event arrives (which also carries the allow-once flag).  This prevents any
  // budget check from firing during the async window between document_start and
  // the settings/allow-once response, eliminating the page-load race condition.
  let enforcing  = false;
  let jsDisabled = false;
  let computeMs  = 0;
  let imageCount = 0;
  let workerCount = 0;
  let pressure   = 0;
  let alwaysVisibleOverlay = false;
  let targetedInterventions = false;
  let showDisableOverlay = false;
  let settingsReady = false;
  let dataUsedBytes = 0;
  let dataBudgetBytes = DEFAULT_DATA_BUDGET_BYTES;
  let networkRequestCount = 0;
  let maxNetworkRequests = NETWORK_REQUESTS_REFERENCE;
  let computeBudgetLimitMs = COMPUTE_BUDGET_MS;
  let imageLimit = MAX_IMAGES;
  let videoStreamCount = 0;
  let maxVideoStreams = VIDEO_STREAMS_REFERENCE;
  let domNodesLimit = MAX_DOM_NODES;
  let workersLimit = MAX_WORKERS;
  let ignorePressureSeconds = 0;
  const pageStartAtMs = performance.now();
  let pressureThresholdLimit = PRESSURE_THRESHOLD;
  let networkBlocked = false;
  let imagesDisabled = false;
  let videosDisabled = false;
  let consoleLogCount = 0;
  let consoleWarningCount = 0;
  let consoleErrorCount = 0;
  let consoleLogsLimit = MAX_CONSOLE_LOGS;
  let consoleWarningsLimit = MAX_CONSOLE_WARNINGS;
  let consoleErrorsLimit = MAX_CONSOLE_ERRORS;
  let hudForcedVisible = false;

  const trackedImages = new WeakSet();
  const imageLastSource = new WeakMap();
  const trackedVideos = new WeakSet();
  const videoLastSource = new WeakMap();
  let latestSettings = {};
  let capacityOverrides = loadCapacityOverrides();
  let hudExpandedByUser = loadHudExpandedPreference();
  let hudAutoExpanded = false;
  let lastExceededState = false;

  /** @type {HTMLDivElement|null} */
  let overlay = null;
  /** @type {HTMLDivElement|null} */
  let metricsHud = null;

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
  const _elementSetAttribute  = Element.prototype.setAttribute;
  const _imgSrcDescriptor     = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  const _imgSrcsetDescriptor  = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'srcset');
  const _videoSrcDescriptor   = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'src');
  const _videoLoad            = HTMLVideoElement.prototype.load;
  const _mediaSrcObjectDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
  const BLANK_IMAGE_DATA_URL  = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
  const _consoleLog   = console.log.bind(console);
  const _consoleWarn  = console.warn.bind(console);
  const _consoleError = console.error.bind(console);
  const _consoleInfo  = console.info.bind(console);
  const _consoleDebug = console.debug.bind(console);

  // ─── Console interception ──────────────────────────────────────────────────
  function loadCapacityOverrides() {
    try {
      return JSON.parse(sessionStorage.getItem(CAPACITY_OVERRIDES_STORAGE_KEY) || '{}');
    } catch (_) {
      return {};
    }
  }

  function loadHudExpandedPreference() {
    try {
      return sessionStorage.getItem(HUD_EXPANDED_STORAGE_KEY) === '1';
    } catch (_) {
      return false;
    }
  }

  function saveHudExpandedPreference() {
    try {
      sessionStorage.setItem(HUD_EXPANDED_STORAGE_KEY, hudExpandedByUser ? '1' : '0');
    } catch (_) {
      // Ignore storage failures; in-memory state is enough.
    }
  }

  function saveCapacityOverrides() {
    try {
      sessionStorage.setItem(CAPACITY_OVERRIDES_STORAGE_KEY, JSON.stringify(capacityOverrides));
    } catch (_) {
      // In-memory fallback is acceptable if sessionStorage is unavailable.
    }
  }

  function getCapacityOverride(metric) {
    const value = Number(capacityOverrides[metric]);
    return Number.isFinite(value) ? value : 0;
  }

  function increaseCapacityOverride(metric, amount) {
    capacityOverrides[metric] = getCapacityOverride(metric) + amount;
    saveCapacityOverrides();
  }

  function applyMetricLimits(settings = latestSettings) {
    latestSettings = settings;
    const nextComputeBudget = Number(settings.computeBudgetMs);
    const nextMaxImages = Number(settings.maxImages);
    const nextMaxVideoStreams = Number(settings.maxVideoStreams);
    const nextMaxDomNodes = Number(settings.maxDomNodes);
    const nextMaxWorkers = Number(settings.maxWorkers);

    computeBudgetLimitMs = (Number.isFinite(nextComputeBudget) && nextComputeBudget > 0 ? nextComputeBudget : COMPUTE_BUDGET_MS) + getCapacityOverride('compute');
    imageLimit = (Number.isFinite(nextMaxImages) && nextMaxImages > 0 ? nextMaxImages : MAX_IMAGES) + getCapacityOverride('images');
    maxVideoStreams = (Number.isFinite(nextMaxVideoStreams) && nextMaxVideoStreams > 0 ? nextMaxVideoStreams : VIDEO_STREAMS_REFERENCE) + getCapacityOverride('videoStreams');
    domNodesLimit = (Number.isFinite(nextMaxDomNodes) && nextMaxDomNodes > 0 ? nextMaxDomNodes : MAX_DOM_NODES) + getCapacityOverride('domNodes');
    workersLimit = (Number.isFinite(nextMaxWorkers) && nextMaxWorkers >= 0 ? nextMaxWorkers : MAX_WORKERS) + getCapacityOverride('workers');
    consoleLogsLimit = MAX_CONSOLE_LOGS + getCapacityOverride('consoleLogs');
    consoleWarningsLimit = MAX_CONSOLE_WARNINGS + getCapacityOverride('consoleWarnings');
    consoleErrorsLimit = MAX_CONSOLE_ERRORS + getCapacityOverride('consoleErrors');
    pressureThresholdLimit = PRESSURE_THRESHOLD + getCapacityOverride('pressure');
  }

  function countConsoleEvent(kind) {
    consoleLogCount += 1;
    if (kind === 'warn') {consoleWarningCount += 1;}
    if (kind === 'error') {consoleErrorCount += 1;}

    // Every 50 logs adds a small pressure bump for spammy pages
    if (consoleLogCount % 50 === 0) {
      addPressure(5, 'console spam');
    }
  }

  function onConsoleCall(native, kind, args) {
    countConsoleEvent(kind);
    return native(...args);
  }

  console.log   = (...a) => onConsoleCall(_consoleLog, 'log', a);
  console.warn  = (...a) => onConsoleCall(_consoleWarn, 'warn', a);
  console.error = (...a) => onConsoleCall(_consoleError, 'error', a);
  console.info  = (...a) => onConsoleCall(_consoleInfo, 'info', a);
  console.debug = (...a) => onConsoleCall(_consoleDebug, 'debug', a);

  // Catch browser-reported runtime/resource failures that may never invoke
  // console.error directly (e.g., blocked image/script requests).
  window.addEventListener('error', (event) => {
    if (!event) {return;}
    // Resource load error (IMG, SCRIPT, LINK, etc.)
    if (event.target && event.target !== window) {
      countConsoleEvent('error');
      return;
    }
    // Regular runtime error event on window
    if (event.message || event.error) {
      countConsoleEvent('error');
    }
  }, true);

  window.addEventListener('unhandledrejection', () => {
    countConsoleEvent('error');
  });

  // Browser-originated warning-like events that may bypass console.warn.
  window.addEventListener('rejectionhandled', () => {
    countConsoleEvent('warn');
  });

  window.addEventListener('securitypolicyviolation', () => {
    countConsoleEvent('warn');
  });

  window.addEventListener('messageerror', () => {
    countConsoleEvent('warn');
  });

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
    if (!enforcing || jsDisabled) {return;}
    computeMs += ms;
    sendToIsolated('compute_update', { computeMs });

    // Long task (>50 ms) increases pressure score
    if (ms > 50) {
      addPressure(20, 'long_task');
    }

    if (computeMs >= computeBudgetLimitMs) {
      handleOverload('compute', 'compute budget exceeded');
    }
  }

  // ─── Pressure score ─────────────────────────────────────────────────────────
  function getPressureIgnoreRemainingMs() {
    if (ignorePressureSeconds <= 0) {return 0;}
    const windowMs = ignorePressureSeconds * 1000;
    return Math.max(0, windowMs - (performance.now() - pageStartAtMs));
  }

  function isPressureIgnoredNow() {
    return getPressureIgnoreRemainingMs() > 0;
  }

  function addPressure(amount, reason) {
    if (!enforcing || jsDisabled) {return;}
    if (isPressureIgnoredNow()) {return;}
    pressure += amount;
    sendToIsolated('pressure_update', { pressure: Math.round(pressure) });
    if (pressure > pressureThresholdLimit) {
      handleOverload('pressure', `pressure threshold exceeded (${reason})`);
    }
  }

  function triggerDisableJS(reason) {
    if (jsDisabled) {return;}
    jsDisabled = true;
    sendToIsolated('disable_js_request', { reason });
    disableJS();
  }

  function disableImageLoading() {
    if (imagesDisabled) {return;}
    imagesDisabled = true;

    if (_Image) {
      window.Image = class {
        constructor(width, height) {
          const img = new _Image(width, height);
          try {
            if (_imgSrcDescriptor?.set) {
              _imgSrcDescriptor.set.call(img, BLANK_IMAGE_DATA_URL);
            } else {
              img.src = BLANK_IMAGE_DATA_URL;
            }
          } catch (_) {}
          return img;
        }
      };
    }

    try {
      if (_imgSrcDescriptor?.configurable) {
        Object.defineProperty(HTMLImageElement.prototype, 'src', {
          configurable: true,
          enumerable: _imgSrcDescriptor.enumerable,
          get: _imgSrcDescriptor.get
            ? function () { return _imgSrcDescriptor.get.call(this); }
            : function () { return this.getAttribute('src') || ''; },
          set() {},
        });
      }
      if (_imgSrcsetDescriptor?.configurable) {
        Object.defineProperty(HTMLImageElement.prototype, 'srcset', {
          configurable: true,
          enumerable: _imgSrcsetDescriptor.enumerable,
          get: _imgSrcsetDescriptor.get
            ? function () { return _imgSrcsetDescriptor.get.call(this); }
            : function () { return this.getAttribute('srcset') || ''; },
          set() {},
        });
      }
    } catch (_) {
      // Some pages lock down prototypes; this is best-effort.
    }

    applyElementAttributeBlockers();

    for (const img of document.images) {
      try {
        _elementSetAttribute.call(img, 'src', BLANK_IMAGE_DATA_URL);
        _elementSetAttribute.call(img, 'srcset', '');
      } catch (_) {}
    }

    refreshMetricsUI();
  }

  function disableVideoStreams() {
    if (videosDisabled) {return;}
    videosDisabled = true;

    try {
      if (_videoSrcDescriptor?.configurable) {
        Object.defineProperty(HTMLVideoElement.prototype, 'src', {
          configurable: true,
          enumerable: _videoSrcDescriptor.enumerable,
          get: _videoSrcDescriptor.get
            ? function () { return _videoSrcDescriptor.get.call(this); }
            : function () { return this.getAttribute('src') || ''; },
          set() {},
        });
      }

      if (_mediaSrcObjectDescriptor?.configurable) {
        Object.defineProperty(HTMLVideoElement.prototype, 'srcObject', {
          configurable: true,
          enumerable: _mediaSrcObjectDescriptor.enumerable,
          get: _mediaSrcObjectDescriptor.get
            ? function () { return _mediaSrcObjectDescriptor.get.call(this); }
            : function () { return null; },
          set() {},
        });
      }
    } catch (_) {
      // Best-effort only when prototypes are locked down.
    }

    HTMLVideoElement.prototype.play = function () {
      return Promise.reject(new Error('[EdgeWatch] Video streams blocked.'));
    };

    applyElementAttributeBlockers();

    for (const video of document.querySelectorAll('video')) {
      try {
        video.pause();
        if (video.srcObject !== undefined) {
          video.srcObject = null;
        }
        video.removeAttribute('src');
        for (const srcNode of video.querySelectorAll('source')) {
          srcNode.removeAttribute('src');
        }
        _videoLoad.call(video);
      } catch (_) {}
    }

    refreshMetricsUI();
  }

  function applyElementAttributeBlockers() {
    Element.prototype.setAttribute = function (name, value) {
      if (typeof name === 'string') {
        const attr = name.toLowerCase();

        if (
          imagesDisabled &&
          this instanceof HTMLImageElement &&
          (attr === 'src' || attr === 'srcset')
        ) {
          return;
        }

        if (
          videosDisabled &&
          this instanceof HTMLVideoElement &&
          (attr === 'src' || attr === 'poster')
        ) {
          return;
        }

        if (
          videosDisabled &&
          this instanceof HTMLSourceElement &&
          this.parentElement instanceof HTMLVideoElement &&
          attr === 'src'
        ) {
          return;
        }
      }

      return _elementSetAttribute.call(this, name, value);
    };
  }

  function handleOverload(kind, reason) {
    if (!enforcing) {return;} // Don't intervene while enforcement is suspended

    if (kind === 'images' && targetedInterventions) {
      disableImageLoading();
      return;
    }

    if (kind === 'videos' && targetedInterventions) {
      disableVideoStreams();
      return;
    }

    triggerDisableJS(reason);
  }

  // ─── Wrap scheduling APIs ────────────────────────────────────────────────────
  /** Returns a wrapped version of fn that measures its execution time. */
  function wrapCallback(fn) {
    if (typeof fn !== 'function') {return fn;}
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
    if (jsDisabled) {return 0;}
    return _setTimeout(wrapCallback(fn), delay, ...rest);
  };

  window.setInterval = function (fn, delay, ...rest) {
    if (jsDisabled) {return 0;}
    return _setInterval(wrapCallback(fn), delay, ...rest);
  };

  window.clearTimeout  = _clearTimeout;
  window.clearInterval = _clearInterval;

  window.requestAnimationFrame = function (fn) {
    if (jsDisabled) {return 0;}
    return _rAF(wrapCallback(fn));
  };

  if (_rIC) {
    window.requestIdleCallback = function (fn, opts) {
      if (jsDisabled) {return 0;}
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
        if (workerCount > workersLimit) {
          handleOverload('workers', 'worker limit exceeded');
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
        if (workerCount > workersLimit) {
          handleOverload('workers', 'worker limit exceeded');
        }
        return new Target(...args);
      },
    });
  }

  // ─── Image constructor tracking ──────────────────────────────────────────────
  function imageSourceKey(img) {
    return (img.currentSrc || img.src || img.getAttribute('srcset') || '').trim();
  }

  function trackImageElement(img, allowSourceChange = false) {
    if (!(img instanceof HTMLImageElement)) {return 0;}

    if (!trackedImages.has(img)) {
      trackedImages.add(img);
      imageLastSource.set(img, imageSourceKey(img));
      return 1;
    }

    if (allowSourceChange) {
      const prev = imageLastSource.get(img) || '';
      const next = imageSourceKey(img);
      if (next && next !== prev) {
        imageLastSource.set(img, next);
        return 1;
      }
    }

    return 0;
  }

  function applyImageDelta(delta, reason) {
    if (delta <= 0) {return;}
    const prevTens = Math.floor(imageCount / 10);
    imageCount += delta;
    const nextTens = Math.floor(imageCount / 10);

    if (nextTens > prevTens) {
      addPressure(15, reason);
    }

    sendToIsolated('resource_update', { images: imageCount });

    if (imageCount > imageLimit) {
      handleOverload('images', 'image limit exceeded');
    }
  }

  function seedExistingImages() {
    let seeded = 0;
    for (const img of document.images) {
      seeded += trackImageElement(img);
    }
    applyImageDelta(seeded, 'initial DOM images');
  }

  function videoSourceKey(video) {
    return (video.currentSrc || video.src || '').trim();
  }

  function trackVideoElement(video, allowSourceChange = false) {
    if (!(video instanceof HTMLVideoElement)) {return 0;}

    if (!trackedVideos.has(video)) {
      trackedVideos.add(video);
      videoLastSource.set(video, videoSourceKey(video));
      return 1;
    }

    if (allowSourceChange) {
      const prev = videoLastSource.get(video) || '';
      const next = videoSourceKey(video);
      if (next && next !== prev) {
        videoLastSource.set(video, next);
        return 1;
      }
    }

    return 0;
  }

  function applyVideoDelta(delta, reason) {
    if (delta <= 0) {return;}
    const prevBucket = Math.floor(videoStreamCount / 3);
    videoStreamCount += delta;
    const nextBucket = Math.floor(videoStreamCount / 3);

    if (nextBucket > prevBucket) {
      addPressure(10, reason);
    }

    if (videoStreamCount > maxVideoStreams) {
      handleOverload('videos', 'video stream limit exceeded');
    }
  }

  function seedExistingVideos() {
    let seeded = 0;
    for (const video of document.querySelectorAll('video')) {
      seeded += trackVideoElement(video, true);
    }
    applyVideoDelta(seeded, 'initial DOM videos');
  }

  if (_Image) {
    window.Image = new Proxy(_Image, {
      construct(Target, args) {
        const img = new Target(...args);
        const delta = trackImageElement(img, true);
        applyImageDelta(delta, 'new Image()');
        return img;
      },
    });
  }

  // ─── MutationObserver: track <img> elements added to the DOM ───────────────
  const mutationObserver = new MutationObserver((mutations) => {
    if (!enforcing || jsDisabled) {return;}
    let newImages = 0;
    let newVideos = 0;
    let addedNodes = 0;
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        addedNodes += mutation.addedNodes.length;
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) {continue;} // Element nodes only
          if (node.tagName === 'IMG') {
            newImages += trackImageElement(node);
          } else if (node.tagName === 'VIDEO') {
            newVideos += trackVideoElement(node, true);
          }
          const descendants = node.querySelectorAll?.('img') ?? [];
          for (const img of descendants) {
            newImages += trackImageElement(img);
          }
          const videoDescendants = node.querySelectorAll?.('video') ?? [];
          for (const video of videoDescendants) {
            newVideos += trackVideoElement(video, true);
          }
        }
      } else if (mutation.type === 'attributes' && mutation.target?.tagName === 'IMG') {
        newImages += trackImageElement(mutation.target, true);
      } else if (mutation.type === 'attributes' && mutation.target?.tagName === 'VIDEO') {
        newVideos += trackVideoElement(mutation.target, true);
      }
    }
    applyImageDelta(newImages, 'dynamic ad/image updates');
    applyVideoDelta(newVideos, 'dynamic video updates');

    // Burst of DOM mutations adds pressure
    if (addedNodes > 10) {
      addPressure(10, 'burst of DOM mutations');
    }
  });

  function startMutationObserver() {
    const target = document.body || document.documentElement;
    if (target) {
      mutationObserver.observe(target, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'srcset', 'poster'],
      });
    }
    seedExistingImages();
    seedExistingVideos();
  }

  if (document.body) {
    startMutationObserver();
  } else {
    document.addEventListener('DOMContentLoaded', startMutationObserver);
  }

  // ─── Periodic DOM node count (once per second) ──────────────────────────────
  _setInterval(() => {
    if (!enforcing || jsDisabled) {return;}
    const domNodes = document.getElementsByTagName('*').length;
    sendToIsolated('resource_update', { domNodes });
    if (domNodes > domNodesLimit) {
      handleOverload('dom', 'DOM node limit exceeded');
    }
  }, DOM_CHECK_INTERVAL_MS);

  // ─── Pressure decay (once per second) ───────────────────────────────────────
  _setInterval(() => {
    if (!enforcing || jsDisabled) {return;}
    if (isPressureIgnoredNow()) {
      if (pressure !== 0) {
        pressure = 0;
        sendToIsolated('pressure_update', { pressure: 0 });
      }
      return;
    }
    pressure *= PRESSURE_DECAY_FACTOR;
    sendToIsolated('pressure_update', { pressure: Math.round(pressure) });
  }, PRESSURE_DECAY_INTERVAL_MS);

  // ─── Listen for events from the isolated world ──────────────────────────────
  // Network burst reported by background (5+ requests in 1 s)
  document.addEventListener(`${EVT}network_burst`, () => {
    addPressure(10, 'network request burst');
  });

  document.addEventListener(`${EVT}settings_update`, (ev) => {
    const isInitial = !settingsReady;
    settingsReady = true;

    if (isInitial) {
      // On the first settings delivery (which now also carries the allow-once
      // flag), decide whether enforcement should be active for this navigation.
      // This runs before any budget check could fire, closing the race window.
      if (ev.detail?.allowOnce) {
        enforcing = false;
        if (jsDisabled) {
          jsDisabled = false;
          hideOverlay();
        }
      } else {
        enforcing = true;
      }
    }

    alwaysVisibleOverlay = Boolean(ev.detail?.alwaysVisibleOverlay);
    targetedInterventions = Boolean(ev.detail?.targetedInterventions);
    showDisableOverlay = ev.detail?.showDisableOverlay !== false;
    const mr = Number(ev.detail?.maxRequests);
    const ips = Number(ev.detail?.ignorePressureSeconds);
    if (Number.isFinite(mr) && mr > 0) {maxNetworkRequests = mr;}
    applyMetricLimits(ev.detail ?? {});
    if (Number.isFinite(ips) && ips >= 0) {ignorePressureSeconds = ips;}
    if (!showDisableOverlay && overlay?.isConnected) {
      hideOverlay();
    } else if (showDisableOverlay && jsDisabled && !overlay?.isConnected) {
      showOverlay();
    }
    if (videoStreamCount > maxVideoStreams) {
      handleOverload('videos', 'video stream limit exceeded');
    }
    refreshMetricsUI();
  });

  document.addEventListener(`${EVT}state_update`, (ev) => {
    const nextDataUsed = Number(ev.detail?.dataUsed);
    const nextBudget = Number(ev.detail?.dataBudget);
    const nextRequestCount = Number(ev.detail?.requestCount);
    const nextRequestBudget = Number(ev.detail?.requestBudget);
    if (Number.isFinite(nextDataUsed) && nextDataUsed >= 0) {dataUsedBytes = nextDataUsed;}
    if (Number.isFinite(nextBudget) && nextBudget > 0) {dataBudgetBytes = nextBudget;}
    if (Number.isFinite(nextRequestCount) && nextRequestCount >= 0) {
      networkRequestCount = nextRequestCount;
    }
    if (Number.isFinite(nextRequestBudget) && nextRequestBudget > 0) {
      maxNetworkRequests = nextRequestBudget;
    }
    networkBlocked = Boolean(ev.detail?.networkBlocked);
    refreshMetricsUI();
  });

  // ─── JS disablement ──────────────────────────────────────────────────────────
  function disableJS() {
    // Replace scheduling APIs with inert stubs
    window.setTimeout           = () => 0;
    window.setInterval          = () => 0;
    window.requestAnimationFrame = () => 0;
    if (_rIC) {window.requestIdleCallback = () => 0;}

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

    // Wait for settings before deciding whether the full-screen overlay is allowed.
    if (settingsReady && showDisableOverlay) {
      showOverlay();
    }
  }

  // ─── Overlay ──────────────────────────────────────────────────────────────────
  function asPercent(value, max) {
    if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) {return 0;}
    return Math.max(0, Math.min(100, (value / max) * 100));
  }

  function metricBarMarkup(metric, label, value, max, unit = '') {
    const pct = asPercent(value, max);
    const statusColor = pct >= 100 ? '#ef4444' : pct >= 75 ? '#f59e0b' : '#22c55e';
    const displayValue = Number.isFinite(value) ? Math.round(value) : 0;
    const displayMax = Number.isFinite(max) ? Math.round(max) : 0;
    const suffix = unit ? ` ${unit}` : '';
    const buttonLabel = pct >= 100 ? 'Allow more' : '+ Cap';
    return `
      <div style="margin:0 0 12px;">
        <div style="display:flex;justify-content:space-between;gap:12px;font-size:12px;opacity:0.95;margin-bottom:5px;align-items:center;">
          <span>${label}</span>
          <div style="display:flex;align-items:center;gap:8px;">
            <span>${displayValue}${suffix} / ${displayMax}${suffix}</span>
            <button type="button" data-edgewatch-action="allow-more" data-edgewatch-metric="${metric}" style="appearance:none;-webkit-appearance:none;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;margin:0;min-height:0;height:auto;line-height:1;font-family:inherit;font-weight:600;white-space:nowrap;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.14);color:#fff;border-radius:6px;padding:4px 7px;font-size:11px;cursor:pointer;pointer-events:auto;vertical-align:middle;">${buttonLabel}</button>
          </div>
        </div>
        <div style="height:8px;background:rgba(255,255,255,0.16);border-radius:999px;overflow:hidden;">
          <div style="height:100%;width:${pct.toFixed(1)}%;background:${statusColor};transition:width 180ms ease;"></div>
        </div>
      </div>
    `;
  }

  function buildMetricsMarkup() {
    const domNodesNow = document.getElementsByTagName('*').length;
    const usedMb = dataUsedBytes / (1024 * 1024);
    const budgetMb = dataBudgetBytes / (1024 * 1024);
    const pressureIgnoreRemainingSeconds = Math.ceil(getPressureIgnoreRemainingMs() / 1000);
    return [
      metricBarMarkup('networkData', 'Network Data', usedMb, budgetMb, 'MB'),
      metricBarMarkup('networkRequests', 'Network Requests', networkRequestCount, maxNetworkRequests),
      metricBarMarkup('compute', 'Compute', computeMs, computeBudgetLimitMs, 'ms'),
      metricBarMarkup('images', 'Images', imageCount, imageLimit),
      metricBarMarkup('videoStreams', 'Video Streams', videoStreamCount, maxVideoStreams),
      metricBarMarkup('domNodes', 'DOM Nodes', domNodesNow, domNodesLimit),
      metricBarMarkup('workers', 'Workers', workerCount, workersLimit),
      metricBarMarkup('consoleLogs', 'Console Logs', consoleLogCount, consoleLogsLimit),
      metricBarMarkup('consoleWarnings', 'Console Warnings', consoleWarningCount, consoleWarningsLimit),
      metricBarMarkup('consoleErrors', 'Console Errors', consoleErrorCount, consoleErrorsLimit),
      metricBarMarkup('pressure', 'Pressure', pressure, pressureThresholdLimit),
      pressureIgnoreRemainingSeconds > 0
        ? `<div style="font-size:12px;opacity:0.92;color:#60a5fa;margin:2px 0 10px;">Pressure metric ignored for ${pressureIgnoreRemainingSeconds}s after page load.</div>`
        : '',
      imagesDisabled
        ? '<div style="font-size:12px;opacity:0.92;color:#f59e0b;margin:2px 0 10px;">Image loading has been disabled for this page.</div>'
        : '',
      videosDisabled
        ? '<div style="font-size:12px;opacity:0.92;color:#f59e0b;margin:2px 0 10px;">Video streams have been disabled for this page.</div>'
        : '',
      networkBlocked
        ? '<div style="font-size:12px;opacity:0.92;color:#ef4444;margin:2px 0 10px;">Network connections have been blocked for this page.</div>'
        : '',
    ].join('');
  }

  function hasAnyMetricExceeded() {
    const domNodesNow = document.getElementsByTagName('*').length;
    return (
      dataUsedBytes >= dataBudgetBytes ||
      networkRequestCount >= maxNetworkRequests ||
      computeMs >= computeBudgetLimitMs ||
      imageCount >= imageLimit ||
      videoStreamCount >= maxVideoStreams ||
      domNodesNow >= domNodesLimit ||
      workerCount >= workersLimit ||
      consoleLogCount >= consoleLogsLimit ||
      consoleWarningCount >= consoleWarningsLimit ||
      consoleErrorCount >= consoleErrorsLimit ||
      pressure >= pressureThresholdLimit ||
      networkBlocked ||
      imagesDisabled ||
      videosDisabled
    );
  }

  function buildCollapsedHudMarkup() {
    const pressureIgnoreRemainingSeconds = Math.ceil(getPressureIgnoreRemainingMs() / 1000);
    return `
      ${metricBarMarkup('pressure', 'Pressure', pressure, pressureThresholdLimit)}
      ${pressureIgnoreRemainingSeconds > 0
        ? `<div style="font-size:11px;opacity:0.85;color:#60a5fa;margin:2px 0 8px;">Ignoring pressure for ${pressureIgnoreRemainingSeconds}s.</div>`
        : ''}
    `;
  }

  function getPopupMetricState() {
    const domNodesNow = document.getElementsByTagName('*').length;
    const usedMb = dataUsedBytes / (1024 * 1024);
    const budgetMb = dataBudgetBytes / (1024 * 1024);
    return {
      ok: true,
      status: jsDisabled ? 'js-paused' : networkBlocked ? 'net-blocked' : 'ok',
      hudVisible: Boolean(metricsHud?.isConnected) && !jsDisabled,
      canCloseHud: Boolean(metricsHud?.isConnected) && !alwaysVisibleOverlay && !jsDisabled,
      exceededMetrics: [
        { id: 'networkData', label: 'Network Data', valueText: `${usedMb.toFixed(1)} MB`, maxText: `${budgetMb.toFixed(1)} MB`, incrementText: '+50 MB', exceeded: dataUsedBytes >= dataBudgetBytes },
        { id: 'networkRequests', label: 'Network Requests', valueText: `${networkRequestCount}`, maxText: `${maxNetworkRequests}`, incrementText: '+100', exceeded: networkRequestCount >= maxNetworkRequests },
        { id: 'compute', label: 'Compute', valueText: `${Math.round(computeMs)} ms`, maxText: `${Math.round(computeBudgetLimitMs)} ms`, incrementText: '+1000 ms', exceeded: computeMs >= computeBudgetLimitMs },
        { id: 'images', label: 'Images', valueText: `${imageCount}`, maxText: `${imageLimit}`, incrementText: '+50', exceeded: imageCount >= imageLimit },
        { id: 'videoStreams', label: 'Video Streams', valueText: `${videoStreamCount}`, maxText: `${maxVideoStreams}`, incrementText: '+2', exceeded: videoStreamCount >= maxVideoStreams },
        { id: 'domNodes', label: 'DOM Nodes', valueText: `${domNodesNow.toLocaleString()}`, maxText: `${domNodesLimit.toLocaleString()}`, incrementText: '+1000', exceeded: domNodesNow >= domNodesLimit },
        { id: 'workers', label: 'Workers', valueText: `${workerCount}`, maxText: `${workersLimit}`, incrementText: '+1', exceeded: workerCount >= workersLimit },
        { id: 'consoleLogs', label: 'Console Logs', valueText: `${consoleLogCount}`, maxText: `${consoleLogsLimit}`, incrementText: '+100', exceeded: consoleLogCount >= consoleLogsLimit },
        { id: 'consoleWarnings', label: 'Console Warnings', valueText: `${consoleWarningCount}`, maxText: `${consoleWarningsLimit}`, incrementText: '+50', exceeded: consoleWarningCount >= consoleWarningsLimit },
        { id: 'consoleErrors', label: 'Console Errors', valueText: `${consoleErrorCount}`, maxText: `${consoleErrorsLimit}`, incrementText: '+25', exceeded: consoleErrorCount >= consoleErrorsLimit },
        { id: 'pressure', label: 'Pressure', valueText: `${Math.round(pressure)}`, maxText: `${Math.round(pressureThresholdLimit)}`, incrementText: '+250', exceeded: pressure >= pressureThresholdLimit },
      ].filter((metric) => metric.exceeded),
    };
  }

  function isHudExpanded() {
    return hudExpandedByUser || hudAutoExpanded;
  }

  function getHudToggleLabel() {
    return isHudExpanded() ? 'Collapse' : 'Expand';
  }

  function shouldShowHudCloseButton() {
    return !alwaysVisibleOverlay;
  }

  function ensureMetricsHud() {
    if (metricsHud?.isConnected || (!(alwaysVisibleOverlay || hudForcedVisible)) || jsDisabled) {return;}
    metricsHud = null; // clear any stale detached reference

    metricsHud = document.createElement('div');
    metricsHud.id = 'edgewatch-metrics-hud';
    metricsHud.setAttribute('style', [
      'position:fixed',
      'top:12px',
      'right:12px',
      'width:min(320px,calc(100vw - 24px))',
      'background:rgba(12,15,24,0.86)',
      'backdrop-filter:blur(4px)',
      'color:#fff',
      'padding:10px 10px 2px',
      'border-radius:10px',
      'border:1px solid rgba(255,255,255,0.1)',
      'box-shadow:0 6px 24px rgba(0,0,0,0.35)',
      'z-index:2147483646',
      'font-family:system-ui,-apple-system,sans-serif',
      'font-size:12px',
      'line-height:1.3',
      'pointer-events:auto',
    ].join(';'));

    metricsHud.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 8px;">
        <div style="font-size:11px;opacity:0.85;letter-spacing:0.04em;text-transform:uppercase;">
          EdgeWatch Metrics
        </div>
        <div style="display:flex;align-items:center;gap:6px;">
          <button type="button" data-edgewatch-action="toggle-hud" style="appearance:none;-webkit-appearance:none;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;margin:0;min-height:0;height:auto;line-height:1;font-family:inherit;font-weight:600;white-space:nowrap;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.14);color:#fff;border-radius:6px;padding:4px 7px;font-size:11px;cursor:pointer;pointer-events:auto;vertical-align:middle;">${getHudToggleLabel()}</button>
          ${shouldShowHudCloseButton() ? '<button type="button" data-edgewatch-action="close-hud" aria-label="Close HUD" style="appearance:none;-webkit-appearance:none;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;margin:0;min-height:0;height:auto;line-height:1;font-family:inherit;font-weight:700;white-space:nowrap;background:rgba(239,68,68,0.14);border:1px solid rgba(239,68,68,0.35);color:#fff;border-radius:6px;padding:4px 7px;font-size:11px;cursor:pointer;pointer-events:auto;vertical-align:middle;">Close</button>' : ''}
        </div>
      </div>
      <div id="edgewatch-metrics-hud-bars"></div>
    `;

    metricsHud.addEventListener('click', onMetricsActionClick);

    const attachHud = () => {
      (document.documentElement || document.body).appendChild(metricsHud);
      updateMetricsHud();
    };

    if (document.body) {
      attachHud();
    } else {
      document.addEventListener('DOMContentLoaded', attachHud, { once: true });
    }
  }

  function removeMetricsHud() {
    metricsHud?.remove();
    metricsHud = null;
  }

  function updateMetricsHud() {
    if (!metricsHud) {return;}
    const exceeded = hasAnyMetricExceeded();
    if (exceeded && !lastExceededState) {
      hudAutoExpanded = true;
    } else if (!exceeded) {
      hudAutoExpanded = false;
    }
    lastExceededState = exceeded;

    const close = metricsHud.querySelector('[data-edgewatch-action="close-hud"]');
    const toggle = metricsHud.querySelector('[data-edgewatch-action="toggle-hud"]');
    const bars = metricsHud.querySelector('#edgewatch-metrics-hud-bars');
    if (close) {close.hidden = !shouldShowHudCloseButton();}
    if (toggle) {toggle.textContent = getHudToggleLabel();}
    if (bars) {bars.innerHTML = isHudExpanded() ? buildMetricsMarkup() : buildCollapsedHudMarkup();}
  }

  function updateOverlayMetrics() {
    if (!overlay) {return;}
    const bars = overlay.querySelector('#edgewatch-overlay-metrics');
    if (bars) {bars.innerHTML = buildMetricsMarkup();}
  }

  function onMetricsActionClick(event) {
    const close = event.target.closest('[data-edgewatch-action="close-hud"]');
    if (close) {
      event.preventDefault();
      event.stopPropagation();
      hudForcedVisible = false;
      hudExpandedByUser = false;
      hudAutoExpanded = false;
      saveHudExpandedPreference();
      refreshMetricsUI();
      return;
    }

    const toggle = event.target.closest('[data-edgewatch-action="toggle-hud"]');
    if (toggle) {
      event.preventDefault();
      event.stopPropagation();
      if (isHudExpanded()) {
        hudExpandedByUser = false;
        hudAutoExpanded = false;
      } else {
        hudExpandedByUser = true;
      }
      saveHudExpandedPreference();
      updateMetricsHud();
      return;
    }

    const button = event.target.closest('[data-edgewatch-action="allow-more"]');
    if (!button) {return;}
    event.preventDefault();
    event.stopPropagation();
    handleAllowMore(button.getAttribute('data-edgewatch-metric'));
  }

  function handleAllowMore(metric) {
    switch (metric) {
      case 'networkData':
        sendToIsolated('increase_metric_capacity_request', {
          metric,
          amountBytes: NETWORK_DATA_INCREMENT_BYTES,
        });
        networkBlocked = false;
        refreshMetricsUI();
        return;
      case 'networkRequests':
        sendToIsolated('increase_metric_capacity_request', {
          metric,
          amount: NETWORK_REQUESTS_INCREMENT,
        });
        networkBlocked = false;
        refreshMetricsUI();
        return;
      case 'compute':
        increaseCapacityOverride(metric, COMPUTE_INCREMENT_MS);
        break;
      case 'images':
        increaseCapacityOverride(metric, IMAGES_INCREMENT);
        break;
      case 'videoStreams':
        increaseCapacityOverride(metric, VIDEO_STREAMS_INCREMENT);
        break;
      case 'domNodes':
        increaseCapacityOverride(metric, DOM_NODES_INCREMENT);
        break;
      case 'workers':
        increaseCapacityOverride(metric, WORKERS_INCREMENT);
        break;
      case 'consoleLogs':
        increaseCapacityOverride(metric, CONSOLE_LOGS_INCREMENT);
        break;
      case 'consoleWarnings':
        increaseCapacityOverride(metric, CONSOLE_WARNINGS_INCREMENT);
        break;
      case 'consoleErrors':
        increaseCapacityOverride(metric, CONSOLE_ERRORS_INCREMENT);
        break;
      case 'pressure':
        increaseCapacityOverride(metric, PRESSURE_INCREMENT);
        break;
      default:
        return;
    }

    applyMetricLimits();
    refreshMetricsUI();

    if (jsDisabled || imagesDisabled || videosDisabled) {
      location.reload();
    }
  }

  document.addEventListener(`${EVT}popup_request`, (ev) => {
    const requestId = ev.detail?.requestId;
    const action = ev.detail?.action;
    if (!requestId || !action) {return;}

    let response = { ok: false };

    if (action === 'get_popup_metrics_state') {
      response = getPopupMetricState();
    } else if (action === 'show_hud') {
      hudForcedVisible = true;
      hudExpandedByUser = true;
      saveHudExpandedPreference();
      refreshMetricsUI();
      response = { ok: true };
    } else if (action === 'increase_metric_capacity') {
      handleAllowMore(ev.detail?.metric);
      response = { ok: true };
    }

    document.dispatchEvent(
      new CustomEvent(`${EVT}popup_response_${requestId}`, { detail: response }),
    );
  });

  function refreshMetricsUI() {
    if ((alwaysVisibleOverlay || hudForcedVisible) && !jsDisabled) {
      ensureMetricsHud();
    } else {
      removeMetricsHud();
    }
    updateMetricsHud();
    updateOverlayMetrics();
  }

  function showOverlay() {
    if (overlay?.isConnected) {return;}
    overlay = null; // clear any stale detached reference

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
      'overflow:auto',
    ].join(';'));

    overlay.innerHTML = `
      <div style="width:min(560px,92vw);background:rgba(255,255,255,0.07);border-radius:12px;padding:28px 24px;box-shadow:0 8px 32px rgba(0,0,0,0.5);">
        <div style="font-size:52px;margin-bottom:16px;">⚠️</div>
        <h2 style="margin:0 0 12px;font-size:22px;font-weight:700;letter-spacing:-0.01em;">
          Behaviour Budget Exceeded
        </h2>
        <p style="margin:0 0 18px;opacity:0.8;line-height:1.6;">
          This page exceeded its behaviour budget.<br>
          JavaScript has been paused to protect your browser.
        </p>
        <div style="text-align:left;margin:0 0 22px;padding:14px 14px 8px;border-radius:10px;background:rgba(0,0,0,0.22);border:1px solid rgba(255,255,255,0.08);">
          <div style="font-size:12px;opacity:0.85;letter-spacing:0.04em;text-transform:uppercase;margin:0 0 10px;">
            Monitored Metrics
          </div>
          <div id="edgewatch-overlay-metrics"></div>
        </div>
        <button id="edgewatch-allow-btn" style="
          appearance:none;
          -webkit-appearance:none;
          display:inline-flex;
          align-items:center;
          justify-content:center;
          box-sizing:border-box;
          margin:0;
          min-height:0;
          height:auto;
          line-height:1.1;
          font-family:inherit;
          background:#22c55e;
          border:none;color:#fff;
          padding:12px 28px;
          font-size:15px;
          font-weight:600;
          border-radius:8px;
          cursor:pointer;
          letter-spacing:0.01em;
          white-space:nowrap;
          vertical-align:middle;
          box-shadow:0 2px 8px rgba(34,197,94,0.4);
        ">Temporarily allow this page</button>
      </div>
    `;

    function attachOverlay() {
      (document.documentElement || document.body).appendChild(overlay);
      updateOverlayMetrics();
      overlay.addEventListener('click', onMetricsActionClick);
      document.getElementById('edgewatch-allow-btn')?.addEventListener('click', () => {
        sendToIsolated('reenable_js_request', {});
      });
    }

    if (document.body) {
      attachOverlay();
    } else {
      document.addEventListener('DOMContentLoaded', attachOverlay, { once: true });
    }
  }

  function hideOverlay() {
    overlay?.remove();
    overlay = null;
    refreshMetricsUI();
  }

  _setInterval(() => {
    refreshMetricsUI();
  }, METRICS_REFRESH_MS);
})();
