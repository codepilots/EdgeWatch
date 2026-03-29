'use strict';

// ─── Constants (mirrors background.js defaults) ───────────────────────────────
const DEFAULT_DATA_BUDGET_BYTES = 50 * 1024 * 1024;
const COMPUTE_BUDGET_MS         = 2000;
const MAX_IMAGES                = 200;
const MAX_DOM_NODES             = 10_000;
const MAX_WORKERS               = 4;

// ─── Utility ──────────────────────────────────────────────────────────────────
function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtMs(ms) {
  return `${(ms / 1000).toFixed(2)} s`;
}

function barClass(ratio) {
  if (ratio >= 1)    return 'alert';
  if (ratio >= 0.75) return 'warn';
  return '';
}

function resClass(val, max) {
  if (val >= max)           return 'alert';
  if (val >= max * 0.75)    return 'warn';
  return '';
}

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $loading    = document.getElementById('loading');
const $content    = document.getElementById('content');
const $statusTag  = document.getElementById('status-tag');

const $dataVal    = document.getElementById('data-val');
const $dataBar    = document.getElementById('data-bar');
const $computeVal = document.getElementById('compute-val');
const $computeBar = document.getElementById('compute-bar');
const $resImages  = document.getElementById('res-images');
const $resDom     = document.getElementById('res-dom');
const $resWorkers = document.getElementById('res-workers');
const $pressureVal= document.getElementById('pressure-val');

const $btnData    = document.getElementById('btn-data');
const $btnJs      = document.getElementById('btn-js');
const $btnOpts    = document.getElementById('btn-opts');

// ─── Load state ───────────────────────────────────────────────────────────────
async function loadState() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    $loading.textContent = 'No active tab.';
    return;
  }

  let state;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_STATE', tabId: tab.id });
    state = resp?.state;
  } catch (_) {
    $loading.textContent = 'Extension not ready.';
    return;
  }

  if (!state) {
    $loading.textContent = 'No data for this tab.';
    return;
  }

  // ── Update UI ──────────────────────────────────────────────────────────────
  $loading.hidden  = true;
  $content.hidden  = false;

  // Status tag
  if (state.jsDisabled) {
    $statusTag.textContent = 'JS paused';
    $statusTag.className   = 'alert';
  } else if (state.blocked) {
    $statusTag.textContent = 'NET blocked';
    $statusTag.className   = 'warn';
  } else {
    $statusTag.textContent = 'OK';
    $statusTag.className   = '';
  }

  // Data budget
  const dataRatio = Math.min(state.dataUsed / state.dataBudget, 1);
  $dataVal.textContent    = `${fmtBytes(state.dataUsed)} / ${fmtBytes(state.dataBudget)}`;
  $dataBar.style.width    = `${(dataRatio * 100).toFixed(1)}%`;
  $dataBar.className      = `bar-fill ${barClass(dataRatio)}`;

  // Compute budget
  const computeRatio = Math.min(state.computeMs / COMPUTE_BUDGET_MS, 1);
  $computeVal.textContent = `${fmtMs(state.computeMs)} / ${fmtMs(COMPUTE_BUDGET_MS)}`;
  $computeBar.style.width = `${(computeRatio * 100).toFixed(1)}%`;
  $computeBar.className   = `bar-fill ${barClass(computeRatio)}`;

  // Resources
  $resImages.textContent  = `${state.images} / ${MAX_IMAGES}`;
  $resImages.className    = `res-val ${resClass(state.images, MAX_IMAGES)}`;
  $resDom.textContent     = `${state.domNodes.toLocaleString()} / ${MAX_DOM_NODES.toLocaleString()}`;
  $resDom.className       = `res-val ${resClass(state.domNodes, MAX_DOM_NODES)}`;
  $resWorkers.textContent = `${state.workers} / ${MAX_WORKERS}`;
  $resWorkers.className   = `res-val ${resClass(state.workers, MAX_WORKERS)}`;

  // Pressure score
  const pScore = Math.round(state.pressureMax);
  $pressureVal.textContent = pScore;
  $pressureVal.className   = `pressure-val ${pScore > 100 ? 'alert' : pScore > 60 ? 'warn' : ''}`;

  // Buttons
  $btnData.disabled = false; // always available
  $btnJs.disabled   = !state.jsDisabled; // enabled only when JS is paused

  // Store tabId for button handlers
  $btnData.dataset.tabId = tab.id;
  $btnJs.dataset.tabId   = tab.id;
}

// ─── Button actions ───────────────────────────────────────────────────────────
$btnData.addEventListener('click', async () => {
  const tabId = parseInt($btnData.dataset.tabId, 10);
  if (!tabId) return;
  await chrome.runtime.sendMessage({ type: 'RESET_DATA_BUDGET', tabId }).catch(() => {});
  await loadState();
});

$btnJs.addEventListener('click', async () => {
  const tabId = parseInt($btnJs.dataset.tabId, 10);
  if (!tabId) return;
  await chrome.runtime.sendMessage({ type: 'ALLOW_JS_ONCE', tabId }).catch(() => {});
  // Tab will reload; close popup
  window.close();
});

$btnOpts.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// ─── Init ─────────────────────────────────────────────────────────────────────
loadState();
