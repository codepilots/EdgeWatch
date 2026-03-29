'use strict';

// content.js – Isolated-world bridge
// Runs in Chrome's ISOLATED content-script world so it can use chrome.*
// APIs. It relays custom DOM events from content-main.js (MAIN world) to the
// background service worker, and forwards background messages back.

const EVT = 'edgewatch:';

// ─── Main world → background ───────────────────────────────────────────────
// Maps custom-event names (dispatched on document by content-main.js) to the
// background message objects they should produce.
const EVENT_TO_MESSAGE = {
  compute_update: (d) => ({ type: 'COMPUTE_UPDATE', computeMs: d.computeMs }),
  resource_update: (d) => ({ type: 'RESOURCE_UPDATE', ...d }),
  pressure_update: (d) => ({ type: 'PRESSURE_UPDATE', pressure: d.pressure }),
  disable_js_request: () => ({ type: 'DISABLE_JS' }),
  reenable_js_request: () => ({ type: 'REENABLE_JS' }),
};

for (const [name, toMsg] of Object.entries(EVENT_TO_MESSAGE)) {
  document.addEventListener(`${EVT}${name}`, (ev) => {
    chrome.runtime.sendMessage(toMsg(ev.detail ?? {})).catch(() => {});
  });
}

// ─── Background → main world ───────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'NETWORK_BURST') {
    document.dispatchEvent(new CustomEvent(`${EVT}network_burst`));
  }
  sendResponse({ ok: true });
  return true;
});

// ─── Allow-once check on navigation ───────────────────────────────────────
// The background sets allowJsOnce_<tabId> before reloading the tab.
// We ask the background if the flag is set for our tab (the background
// resolves sender.tab.id automatically), then notify content-main.js.
(async () => {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_ALLOW_ONCE' });
    if (resp?.allowOnce) {
      document.dispatchEvent(new CustomEvent(`${EVT}allow_once`));
    }
  } catch (_) {
    // Non-critical; page may not be reachable yet or extension context invalid
  }
})();
