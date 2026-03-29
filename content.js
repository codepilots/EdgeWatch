'use strict';

// content.js – Isolated-world bridge
// Runs in Chrome's ISOLATED content-script world so it can use chrome.*
// APIs. It relays custom DOM events from content-main.js (MAIN world) to the
// background service worker, and forwards background messages back.

const EVT = 'edgewatch:';
const STATE_SYNC_INTERVAL_MS = 1000;

const DEFAULT_SETTINGS = {
  alwaysVisibleOverlay: false,
  targetedInterventions: false,
  showDisableOverlay: true,
  maxRequests: 250,
  maxVideoStreams: 8,
  ignorePressureSeconds: 0,
};

// ─── Main world → background ───────────────────────────────────────────────
// Maps custom-event names (dispatched on document by content-main.js) to the
// background message objects they should produce.
const EVENT_TO_MESSAGE = {
  compute_update: (d) => ({ type: 'COMPUTE_UPDATE', computeMs: d.computeMs }),
  resource_update: (d) => ({ type: 'RESOURCE_UPDATE', ...d }),
  pressure_update: (d) => ({ type: 'PRESSURE_UPDATE', pressure: d.pressure }),
  increase_metric_capacity_request: (d) => ({ type: 'INCREASE_METRIC_CAPACITY', ...d }),
  disable_js_request: () => ({ type: 'DISABLE_JS' }),
  reenable_js_request: () => ({ type: 'REENABLE_JS' }),
};

for (const [name, toMsg] of Object.entries(EVENT_TO_MESSAGE)) {
  document.addEventListener(`${EVT}${name}`, (ev) => {
    chrome.runtime.sendMessage(toMsg(ev.detail ?? {})).catch(() => {});
  });
}

async function dispatchSettingsToMainWorld() {
  const stored = await chrome.storage.local.get('edgewatch_settings').catch(() => ({}));
  const settings = { ...DEFAULT_SETTINGS, ...(stored.edgewatch_settings ?? {}) };
  document.dispatchEvent(new CustomEvent(`${EVT}settings_update`, { detail: settings }));
}

dispatchSettingsToMainWorld();

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes.edgewatch_settings) return;
  dispatchSettingsToMainWorld();
});

async function dispatchStateToMainWorld() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (!resp?.state) return;
    document.dispatchEvent(
      new CustomEvent(`${EVT}state_update`, {
        detail: {
          dataUsed: resp.state.dataUsed,
          dataBudget: resp.state.dataBudget,
          requestCount: resp.state.requestCount,
          requestBudget: resp.state.requestBudget,
          networkBlocked: resp.state.blocked,
        },
      }),
    );
  } catch (_) {
    // Ignore transient state sync errors
  }
}

dispatchStateToMainWorld();
setInterval(dispatchStateToMainWorld, STATE_SYNC_INTERVAL_MS);

function requestFromMainWorld(action, detail = {}) {
  return new Promise((resolve) => {
    const requestId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const responseEvent = `${EVT}popup_response_${requestId}`;
    let settled = false;

    const complete = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener(responseEvent, onResponse);
      resolve(value);
    };

    const onResponse = (ev) => complete(ev.detail ?? {});
    document.addEventListener(responseEvent, onResponse, { once: true });

    document.dispatchEvent(
      new CustomEvent(`${EVT}popup_request`, {
        detail: { requestId, action, ...detail },
      }),
    );

    setTimeout(() => complete({ ok: false, timeout: true }), 1000);
  });
}

// ─── Background → main world ───────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'NETWORK_BURST') {
    document.dispatchEvent(new CustomEvent(`${EVT}network_burst`));
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'POPUP_GET_METRICS') {
    requestFromMainWorld('get_popup_metrics_state').then(sendResponse);
    return true;
  }

  if (message.type === 'POPUP_SHOW_HUD') {
    requestFromMainWorld('show_hud').then(sendResponse);
    return true;
  }

  if (message.type === 'POPUP_INCREASE_METRIC_CAPACITY') {
    requestFromMainWorld('increase_metric_capacity', { metric: message.metric }).then(sendResponse);
    return true;
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
