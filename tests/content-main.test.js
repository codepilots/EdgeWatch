'use strict';
// tests/content-main.test.js – jsdom environment
// Validates Fix 3: enforcement is suspended (enforcing = false) until the
// first settings_update event arrives.  allowOnce:true keeps it off;
// allowOnce:false enables it.

const EVT = 'edgewatch:';

/** Dispatch a settings_update event on document (mirrors content.js output). */
function sendSettings(opts = {}) {
  document.dispatchEvent(
    new CustomEvent(`${EVT}settings_update`, {
      detail: {
        alwaysVisibleOverlay: false,
        targetedInterventions: false,
        showDisableOverlay: true,
        maxRequests: 250,
        maxVideoStreams: 8,
        ignorePressureSeconds: 0,
        ...opts,
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// Suite A – Enforcement suspended before first settings_update
// ---------------------------------------------------------------------------
describe('content-main.js – enforcement suspended before settings (Fix 3)', () => {
  beforeAll(() => {
    jest.resetModules();
    require('../content-main.js');
  });

  it('does not fire disable_js_request before settings_update arrives', () => {
    const disableEvents = [];
    const onDisable = (ev) => disableEvents.push(ev.detail);
    document.addEventListener(`${EVT}disable_js_request`, onDisable);

    // Fire 30 network bursts (each raises pressure by 10; threshold = 100).
    // With enforcing=false these must all be ignored.
    for (let i = 0; i < 30; i++) {
      document.dispatchEvent(new CustomEvent(`${EVT}network_burst`));
    }

    document.removeEventListener(`${EVT}disable_js_request`, onDisable);
    expect(disableEvents).toHaveLength(0);
  });

  it('keeps enforcement off when settings_update carries allowOnce:true', () => {
    sendSettings({ allowOnce: true });

    const disableEvents = [];
    const onDisable = (ev) => disableEvents.push(ev.detail);
    document.addEventListener(`${EVT}disable_js_request`, onDisable);

    for (let i = 0; i < 30; i++) {
      document.dispatchEvent(new CustomEvent(`${EVT}network_burst`));
    }

    document.removeEventListener(`${EVT}disable_js_request`, onDisable);
    expect(disableEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Suite B – Enforcement enabled after settings_update (allowOnce:false)
// ---------------------------------------------------------------------------
describe('content-main.js – enforcement enabled after settings (Fix 3)', () => {
  beforeAll(() => {
    jest.resetModules();
    require('../content-main.js');

    // Enable enforcement; no allowOnce flag.
    sendSettings({ allowOnce: false });
  });

  it('does NOT treat a second settings_update as another "initial" event', () => {
    const disableEvents = [];
    const onDisable = (ev) => disableEvents.push(ev.detail);
    document.addEventListener(`${EVT}disable_js_request`, onDisable);

    sendSettings({ allowOnce: false });

    document.removeEventListener(`${EVT}disable_js_request`, onDisable);
    expect(disableEvents).toHaveLength(0);
  });

  it('raises pressure when network bursts occur after enforcement is enabled', () => {
    const pressures = [];
    const onPressure = (ev) => pressures.push(ev.detail.pressure);
    document.addEventListener(`${EVT}pressure_update`, onPressure);

    // Fire a few bursts; pressure should rise (each burst adds 10).
    for (let i = 0; i < 5; i++) {
      document.dispatchEvent(new CustomEvent(`${EVT}network_burst`));
    }

    document.removeEventListener(`${EVT}pressure_update`, onPressure);
    expect(pressures.length).toBeGreaterThan(0);
    expect(pressures[pressures.length - 1]).toBeGreaterThan(0);
  });
});
