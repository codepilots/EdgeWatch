'use strict';
// tests/content.test.js – jsdom environment
// Validates Fix 2: dispatchSettingsToMainWorld(true) fetches the allow-once
// flag in parallel with settings and embeds it in the settings_update event so
// content-main.js receives both atomically before any enforcement can fire.

const EVT = 'edgewatch:';

/** Collect all settings_update events dispatched on document. */
function collectSettingsEvents(count = 1) {
  const received = [];
  return new Promise((resolve) => {
    const handler = (ev) => {
      received.push(ev.detail);
      if (received.length >= count) {
        document.removeEventListener(`${EVT}settings_update`, handler);
        resolve(received);
      }
    };
    document.addEventListener(`${EVT}settings_update`, handler);
  });
}

// ---------------------------------------------------------------------------
describe('content.js – initial settings dispatch (Fix 2)', () => {
  beforeEach(() => {
    jest.resetModules();
    chrome.storage.local.get.mockClear();
    chrome.runtime.sendMessage.mockClear();
    chrome.storage.onChanged.addListener.mockClear();
  });

  it('dispatches settings_update with allowOnce:true when background grants it', async () => {
    chrome.storage.local.get.mockResolvedValue({
      edgewatch_settings: { maxRequests: 100 },
    });
    chrome.runtime.sendMessage.mockResolvedValue({ allowOnce: true });

    const promise = collectSettingsEvents(1);
    require('../content.js');
    const [detail] = await promise;

    expect(detail.allowOnce).toBe(true);
    expect(detail.maxRequests).toBe(100);
  });

  it('dispatches settings_update with allowOnce:false when flag is not set', async () => {
    chrome.storage.local.get.mockResolvedValue({});
    chrome.runtime.sendMessage.mockResolvedValue({ allowOnce: false });

    const promise = collectSettingsEvents(1);
    require('../content.js');
    const [detail] = await promise;

    expect(detail.allowOnce).toBe(false);
  });

  it('uses default settings when storage is empty', async () => {
    chrome.storage.local.get.mockResolvedValue({});
    chrome.runtime.sendMessage.mockResolvedValue({});

    const promise = collectSettingsEvents(1);
    require('../content.js');
    const [detail] = await promise;

    // DEFAULT_SETTINGS.maxRequests is 250
    expect(detail.maxRequests).toBe(250);
    expect(detail.alwaysVisibleOverlay).toBe(false);
  });

  it('fetches settings and allow-once in parallel (GET_ALLOW_ONCE message sent)', async () => {
    chrome.storage.local.get.mockResolvedValue({});
    chrome.runtime.sendMessage.mockResolvedValue({});

    const promise = collectSettingsEvents(1);
    require('../content.js');
    await promise;

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'GET_ALLOW_ONCE' });
  });

  it('settings_update on storage change does NOT include allowOnce', async () => {
    chrome.storage.local.get.mockResolvedValue({});
    chrome.runtime.sendMessage.mockResolvedValue({});

    // Consume the initial event.
    const initial = collectSettingsEvents(1);
    require('../content.js');
    await initial;

    chrome.runtime.sendMessage.mockClear();

    // Simulate a storage change event.
    const onChanged = chrome.storage.onChanged.addListener.mock.calls[0]?.[0];
    expect(onChanged).toBeInstanceOf(Function);

    chrome.storage.local.get.mockResolvedValue({ edgewatch_settings: { maxRequests: 99 } });

    const update = collectSettingsEvents(1);
    onChanged(
      { edgewatch_settings: { newValue: { maxRequests: 99 } } },
      'local',
    );
    const [detail] = await update;

    // allowOnce must NOT be present on settings-change dispatches.
    expect(Object.prototype.hasOwnProperty.call(detail, 'allowOnce')).toBe(false);
    // GET_ALLOW_ONCE must NOT be sent again.
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'GET_ALLOW_ONCE' }),
    );
  });
});
