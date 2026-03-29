'use strict';

// ─── Defaults ─────────────────────────────────────────────────────────────────
const DEFAULTS = {
  dataBudgetMB:      50,
  computeBudgetMs:   2000,
  maxImages:         200,
  maxDomNodes:       10000,
  maxWorkers:        4,
  telemetryEnabled:  false,
  telemetryEndpoint: '',
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $dataBudget         = document.getElementById('data-budget');
const $computeBudget      = document.getElementById('compute-budget');
const $maxImages          = document.getElementById('max-images');
const $maxDom             = document.getElementById('max-dom');
const $maxWorkers         = document.getElementById('max-workers');
const $telemetryEnabled   = document.getElementById('telemetry-enabled');
const $telemetryEndpoint  = document.getElementById('telemetry-endpoint');
const $btnSave            = document.getElementById('btn-save');
const $btnReset           = document.getElementById('btn-reset');
const $saveMsg            = document.getElementById('save-msg');

// ─── Load saved settings ──────────────────────────────────────────────────────
async function loadSettings() {
  const stored = await chrome.storage.local.get('edgewatch_settings').catch(() => ({}));
  const cfg = { ...DEFAULTS, ...(stored.edgewatch_settings ?? {}) };
  applyToForm(cfg);
}

function applyToForm(cfg) {
  $dataBudget.value         = cfg.dataBudgetMB;
  $computeBudget.value      = cfg.computeBudgetMs;
  $maxImages.value          = cfg.maxImages;
  $maxDom.value             = cfg.maxDomNodes;
  $maxWorkers.value         = cfg.maxWorkers;
  $telemetryEnabled.checked = cfg.telemetryEnabled;
  $telemetryEndpoint.value  = cfg.telemetryEndpoint;
}

function readFromForm() {
  return {
    dataBudgetMB:      Math.max(1, parseInt($dataBudget.value, 10)     || DEFAULTS.dataBudgetMB),
    computeBudgetMs:   Math.max(100, parseInt($computeBudget.value, 10) || DEFAULTS.computeBudgetMs),
    maxImages:         Math.max(1, parseInt($maxImages.value, 10)       || DEFAULTS.maxImages),
    maxDomNodes:       Math.max(100, parseInt($maxDom.value, 10)        || DEFAULTS.maxDomNodes),
    maxWorkers:        Math.max(0, parseInt($maxWorkers.value, 10)      || DEFAULTS.maxWorkers),
    telemetryEnabled:  $telemetryEnabled.checked,
    telemetryEndpoint: $telemetryEndpoint.value.trim(),
  };
}

// ─── Save ─────────────────────────────────────────────────────────────────────
$btnSave.addEventListener('click', async () => {
  const cfg = readFromForm();
  await chrome.storage.local.set({ edgewatch_settings: cfg }).catch(() => {});

  // Show confirmation
  $saveMsg.classList.add('show');
  setTimeout(() => $saveMsg.classList.remove('show'), 2000);
});

// ─── Reset to defaults ────────────────────────────────────────────────────────
$btnReset.addEventListener('click', async () => {
  await chrome.storage.local.remove('edgewatch_settings').catch(() => {});
  applyToForm(DEFAULTS);
  $saveMsg.classList.add('show');
  setTimeout(() => $saveMsg.classList.remove('show'), 2000);
});

// ─── Init ─────────────────────────────────────────────────────────────────────
loadSettings();
