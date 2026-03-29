'use strict';

// ─── Defaults ─────────────────────────────────────────────────────────────────
const DEFAULTS = {
  dataBudgetMB:      50,
  maxRequests:       250,
  computeBudgetMs:   2000,
  ignorePressureSeconds: 0,
  maxImages:         200,
  maxVideoStreams:   8,
  maxDomNodes:       10000,
  maxWorkers:        4,
  targetedInterventions: false,
  showDisableOverlay: true,
  alwaysVisibleOverlay: false,
  telemetryEnabled:  false,
  telemetryEndpoint: '',
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $dataBudget         = document.getElementById('data-budget');
const $maxRequests        = document.getElementById('max-requests');
const $computeBudget      = document.getElementById('compute-budget');
const $ignorePressureSeconds = document.getElementById('ignore-pressure-seconds');
const $maxImages          = document.getElementById('max-images');
const $maxVideoStreams    = document.getElementById('max-video-streams');
const $maxDom             = document.getElementById('max-dom');
const $maxWorkers         = document.getElementById('max-workers');
const $targetedInterventions = document.getElementById('targeted-interventions');
const $showDisableOverlay = document.getElementById('show-disable-overlay');
const $alwaysVisibleOverlay = document.getElementById('always-visible-overlay');
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
  $maxRequests.value        = cfg.maxRequests;
  $computeBudget.value      = cfg.computeBudgetMs;
  $ignorePressureSeconds.value = cfg.ignorePressureSeconds;
  $maxImages.value          = cfg.maxImages;
  $maxVideoStreams.value    = cfg.maxVideoStreams;
  $maxDom.value             = cfg.maxDomNodes;
  $maxWorkers.value         = cfg.maxWorkers;
  $targetedInterventions.checked = cfg.targetedInterventions;
  $showDisableOverlay.checked = cfg.showDisableOverlay;
  $alwaysVisibleOverlay.checked = cfg.alwaysVisibleOverlay;
  $telemetryEnabled.checked = cfg.telemetryEnabled;
  $telemetryEndpoint.value  = cfg.telemetryEndpoint;
}

function readFromForm() {
  return {
    dataBudgetMB:      Math.max(1, parseInt($dataBudget.value, 10)       || DEFAULTS.dataBudgetMB),
    maxRequests:       Math.max(1, parseInt($maxRequests.value, 10)      || DEFAULTS.maxRequests),
    computeBudgetMs:   Math.max(100, parseInt($computeBudget.value, 10) || DEFAULTS.computeBudgetMs),
    ignorePressureSeconds: Math.max(0, parseInt($ignorePressureSeconds.value, 10) || DEFAULTS.ignorePressureSeconds),
    maxImages:         Math.max(1, parseInt($maxImages.value, 10)       || DEFAULTS.maxImages),
    maxVideoStreams:   Math.max(1, parseInt($maxVideoStreams.value, 10) || DEFAULTS.maxVideoStreams),
    maxDomNodes:       Math.max(100, parseInt($maxDom.value, 10)        || DEFAULTS.maxDomNodes),
    maxWorkers:        Math.max(0, parseInt($maxWorkers.value, 10)      || DEFAULTS.maxWorkers),
    targetedInterventions: $targetedInterventions.checked,
    showDisableOverlay: $showDisableOverlay.checked,
    alwaysVisibleOverlay: $alwaysVisibleOverlay.checked,
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
