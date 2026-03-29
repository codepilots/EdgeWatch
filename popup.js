'use strict';

const $loading = document.getElementById('loading');
const $content = document.getElementById('content');
const $statusTag = document.getElementById('status-tag');
const $btnShowHud = document.getElementById('btn-show-hud');
const $btnOpts = document.getElementById('btn-opts');
const $exceededList = document.getElementById('exceeded-list');

let activeTabId = null;

function setStatus(status) {
  if (status === 'js-paused') {
    $statusTag.textContent = 'JS paused';
    $statusTag.className = 'alert';
    return;
  }

  if (status === 'net-blocked') {
    $statusTag.textContent = 'NET blocked';
    $statusTag.className = 'warn';
    return;
  }

  $statusTag.textContent = 'OK';
  $statusTag.className = '';
}

function renderExceededMetrics(metrics) {
  if (!metrics.length) {
    $exceededList.innerHTML = '<div class="empty-state">No metrics are currently over their cap.</div>';
    return;
  }

  $exceededList.innerHTML = metrics.map((metric) => `
    <div class="metric-item">
      <div class="metric-top">
        <div class="metric-label">${metric.label}</div>
        <div class="metric-values">${metric.valueText} / ${metric.maxText}</div>
      </div>
      <div class="metric-meta">Increase cap ${metric.incrementText}</div>
      <button type="button" class="btn-increase" data-metric="${metric.id}">Increase ${metric.label}</button>
    </div>
  `).join('');
}

async function sendToTab(message) {
  if (!activeTabId) return null;
  try {
    return await chrome.tabs.sendMessage(activeTabId, message);
  } catch (_) {
    return null;
  }
}

async function loadPopupState() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    $loading.textContent = 'No active tab.';
    return;
  }

  activeTabId = tab.id;
  const resp = await sendToTab({ type: 'POPUP_GET_METRICS' });
  if (!resp?.ok) {
    $loading.textContent = 'Page telemetry unavailable.';
    return;
  }

  $loading.hidden = true;
  $content.hidden = false;
  setStatus(resp.status);
  $btnShowHud.hidden = Boolean(resp.hudVisible);
  renderExceededMetrics(resp.exceededMetrics || []);
}

$btnShowHud.addEventListener('click', async () => {
  if (!activeTabId) return;
  await sendToTab({ type: 'POPUP_SHOW_HUD' });
  window.close();
});

$exceededList.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-metric]');
  if (!button || !activeTabId) return;
  button.disabled = true;
  await sendToTab({
    type: 'POPUP_INCREASE_METRIC_CAPACITY',
    metric: button.getAttribute('data-metric'),
  });
  await loadPopupState();
});

$btnOpts.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

loadPopupState();
