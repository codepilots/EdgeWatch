'use strict';

// --- Configuration ------------------------------------------------------------
// Default data budget per tab per navigation: 50 MB
const DEFAULT_DATA_BUDGET_BYTES = 50 * 1024 * 1024;
// Each "Allow another 50 MB" click adds this many bytes to the budget
const DATA_BUDGET_INCREMENT_BYTES = 50 * 1024 * 1024;
const REQUEST_BUDGET_INCREMENT = 100;

// Telemetry: set TELEMETRY_ENABLED = true and configure TELEMETRY_ENDPOINT
// to activate anonymous aggregated reporting to a remote server.
const TELEMETRY_ENABLED = false;
const TELEMETRY_ENDPOINT = 'https://example.com/api/telemetry';
const TELEMETRY_INTERVAL_MS = 60_000;

// Subresource types counted for the data budget and blocked by DNR
const SUBRESOURCE_TYPES = [
  'script',
  'image',
  'xmlhttprequest',
  'media',
  'font',
  'stylesheet',
  'sub_frame',
  'other',
];

// DNR session rule IDs: base value + tabId ensures uniqueness
const DNR_RULE_ID_BASE = 10_000;

// --- Cached extension settings -----------------------------------------------
let bgSettings = { maxRequests: 250 };

(async () => {
  const stored = await chrome.storage.local.get('edgewatch_settings').catch(() => ({}));
  if (stored.edgewatch_settings?.maxRequests != null) {
    bgSettings.maxRequests = Number(stored.edgewatch_settings.maxRequests) || 250;
  }
})();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.edgewatch_settings) return;
  const next = changes.edgewatch_settings.newValue;
  if (next?.maxRequests != null) {
    bgSettings.maxRequests = Number(next.maxRequests) || 250;
  }
});

// --- Per-tab state ------------------------------------------------------------
/**
 * @typedef {{ dataUsed: number, dataBudget: number, computeMs: number,
 *   images: number, domNodes: number, workers: number,
 *   pressureMax: number, blocked: boolean, jsDisabled: boolean,
 *   interventions: number, requestCount: number, requestBudget: number,
 *   recentRequests: number[] }} TabState
 */

/** @type {Map<number, TabState>} */
const tabState = new Map();

function defaultState() {
  return {
    dataUsed: 0,
    dataBudget: DEFAULT_DATA_BUDGET_BYTES,
    computeMs: 0,
    images: 0,
    domNodes: 0,
    workers: 0,
    pressureMax: 0,
    blocked: false,
    jsDisabled: false,
    interventions: 0,
    requestCount: 0,
    requestBudget: bgSettings.maxRequests,
    recentRequests: [],
  };
}

/** @param {number} tabId @returns {TabState} */
function getState(tabId) {
  if (!tabState.has(tabId)) {
    tabState.set(tabId, defaultState());
  }
  return tabState.get(tabId);
}

/** Reset all per-tab state and remove any blocking rule. */
async function resetState(tabId) {
  tabState.set(tabId, defaultState());
  await removeBlockingRule(tabId);
  updateBadge(tabId, null);
}

// --- Badge helpers ------------------------------------------------------------
function updateBadge(tabId, state) {
  if (!state || (!state.blocked && !state.jsDisabled)) {
    chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
    return;
  }
  if (state.jsDisabled) {
    chrome.action.setBadgeText({ tabId, text: 'JS' }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#CC0000' }).catch(() => {});
  } else if (state.blocked) {
    chrome.action.setBadgeText({ tabId, text: 'NET' }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#FF8800' }).catch(() => {});
  }
}

// --- DNR session rules --------------------------------------------------------
async function addBlockingRule(tabId) {
  const ruleId = DNR_RULE_ID_BASE + tabId;
  try {
    // Remove first (no-op if absent) then add, to avoid duplicate-ID errors
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
      addRules: [
        {
          id: ruleId,
          priority: 100,
          action: { type: 'block' },
          condition: {
            tabIds: [tabId],
            resourceTypes: SUBRESOURCE_TYPES,
          },
        },
      ],
    });
  } catch (err) {
    console.warn('[EdgeWatch] Failed to add blocking rule:', err);
  }
}

async function removeBlockingRule(tabId) {
  const ruleId = DNR_RULE_ID_BASE + tabId;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
    });
  } catch (err) {
    console.warn('[EdgeWatch] Failed to remove blocking rule:', err);
  }
}

// --- webRequest: count downloaded bytes and request volume per tab -----------
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return; // background / extension-internal request
    if (!SUBRESOURCE_TYPES.includes(details.type)) return;

    const state = getState(details.tabId);
    state.requestCount += 1;

    const clHeader = details.responseHeaders?.find(
      (h) => h.name.toLowerCase() === 'content-length',
    );
    if (clHeader) {
      const bytes = parseInt(clHeader.value, 10);
      if (Number.isFinite(bytes) && bytes > 0) {
        state.dataUsed += bytes;
        if (!state.blocked && state.dataUsed >= state.dataBudget) {
          state.blocked = true;
          state.interventions += 1;
          addBlockingRule(details.tabId);
          updateBadge(details.tabId, state);
        }
      }
    }

    // Check request count budget
    if (!state.blocked && state.requestBudget > 0 &&
      state.requestCount >= state.requestBudget) {
      state.blocked = true;
      state.interventions += 1;
      addBlockingRule(details.tabId);
      updateBadge(details.tabId, state);
    }

    // Track request bursts so the content script can update pressure score
    const now = Date.now();
    state.recentRequests = state.recentRequests.filter((t) => now - t < 1000);
    state.recentRequests.push(now);
    if (state.recentRequests.length >= 5) {
      chrome.tabs.sendMessage(details.tabId, { type: 'NETWORK_BURST' }).catch(() => {});
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders'],
);

// --- Navigation lifecycle -----------------------------------------------------
chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return; // main frame only
  await resetState(details.tabId);
});

// --- Tab cleanup --------------------------------------------------------------
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await removeBlockingRule(tabId);
  tabState.delete(tabId);
});

// --- Message handling ---------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Messages from content scripts carry sender.tab.id;
  // messages from the popup carry an explicit message.tabId.
  const tabId = sender.tab?.id ?? message.tabId;
  if (!tabId) return false;

  const state = getState(tabId);

  switch (message.type) {
    case 'COMPUTE_UPDATE': {
      state.computeMs = message.computeMs;
      break;
    }

    case 'RESOURCE_UPDATE': {
      if (message.images !== undefined) state.images = message.images;
      if (message.domNodes !== undefined) state.domNodes = message.domNodes;
      if (message.workers !== undefined) state.workers = message.workers;
      break;
    }

    case 'PRESSURE_UPDATE': {
      state.pressureMax = Math.max(state.pressureMax, message.pressure ?? 0);
      break;
    }

    case 'DISABLE_JS': {
      state.jsDisabled = true;
      state.interventions += 1;
      updateBadge(tabId, state);
      sendResponse({ ok: true });
      break;
    }

    case 'REENABLE_JS':
    case 'ALLOW_JS_ONCE': {
      // Store a flag so content-main.js skips enforcement on the next load,
      // then reload the tab so the page gets a clean slate.
      state.jsDisabled = false;
      updateBadge(tabId, state);
      chrome.storage.session
        .set({ [`allowJsOnce_${tabId}`]: true })
        .catch(() => {})
        .finally(() => chrome.tabs.reload(tabId).catch(() => {}));
      sendResponse({ ok: true });
      break;
    }

    case 'RESET_DATA_BUDGET': {
      state.dataUsed = 0;
      state.blocked = false;
      removeBlockingRule(tabId);
      updateBadge(tabId, state);
      sendResponse({ ok: true });
      break;
    }

    case 'GET_STATE': {
      sendResponse({
        state: {
          dataUsed: state.dataUsed,
          dataBudget: state.dataBudget,
          computeMs: state.computeMs,
          images: state.images,
          domNodes: state.domNodes,
          workers: state.workers,
          pressureMax: state.pressureMax,
          requestCount: state.requestCount,
          requestBudget: state.requestBudget,
          blocked: state.blocked,
          jsDisabled: state.jsDisabled,
          interventions: state.interventions,
        },
      });
      break;
    }

    case 'GET_ALLOW_ONCE': {
      // Called by the isolated-world content script immediately after load.
      const key = `allowJsOnce_${tabId}`;
      chrome.storage.session
        .get(key)
        .then((stored) => {
          if (stored[key]) {
            chrome.storage.session.remove(key).catch(() => {});
            sendResponse({ allowOnce: true });
          } else {
            sendResponse({ allowOnce: false });
          }
        })
        .catch(() => sendResponse({ allowOnce: false }));
      return true; // async response
    }

    case 'UPDATE_BUDGET': {
      // Options page can call this to adjust per-tab budgets globally.
      if (message.dataBudgetBytes) state.dataBudget = message.dataBudgetBytes;
      sendResponse({ ok: true });
      break;
    }

    case 'INCREASE_METRIC_CAPACITY': {
      if (message.metric === 'networkData') {
        state.dataBudget += message.amountBytes || DATA_BUDGET_INCREMENT_BYTES;
        state.blocked = false;
        removeBlockingRule(tabId);
        updateBadge(tabId, state);
        sendResponse({ ok: true, dataBudget: state.dataBudget });
        break;
      }

      if (message.metric === 'networkRequests') {
        state.requestBudget += message.amount || REQUEST_BUDGET_INCREMENT;
        state.blocked = false;
        removeBlockingRule(tabId);
        updateBadge(tabId, state);
        sendResponse({ ok: true, requestBudget: state.requestBudget });
        break;
      }

      sendResponse({ ok: false });
      break;
    }

    default:
      break;
  }

  return true; // keep channel open for async sendResponse calls
});

// --- Telemetry ----------------------------------------------------------------
if (TELEMETRY_ENABLED) {
  setInterval(async () => {
    const tabs = await chrome.tabs.query({}).catch(() => []);
    for (const tab of tabs) {
      if (!tab.id || !tab.url) continue;
      const state = tabState.get(tab.id);
      if (!state) continue;
      try {
        const url = new URL(tab.url);
        const payload = {
          domain: url.hostname,
          path: url.pathname,
          dataUsedBytes: state.dataUsed,
          computeMs: state.computeMs,
          images: state.images,
          domNodes: state.domNodes,
          workers: state.workers,
          pressureMax: state.pressureMax,
          interventions: state.interventions,
          timestamp: Date.now(),
        };
        await fetch(TELEMETRY_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } catch (_) {
        // Silently ignore telemetry errors to avoid noisy console output
      }
    }
  }, TELEMETRY_INTERVAL_MS);
}
