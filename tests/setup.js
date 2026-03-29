'use strict';
// tests/setup.js – Global Chrome API mock shared across all test suites.
// Sets up a minimal chrome.* stub on `global` so that extension scripts can
// be required by Jest without throwing ReferenceErrors.
// Also fills in browser globals that jsdom does not provide by default.

// ── Browser globals not present in jsdom ──────────────────────────────────
if (typeof global.fetch === 'undefined') {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(''),
  });
}

if (typeof global.performance === 'undefined') {
  global.performance = { now: () => Date.now() };
}

function makeAddListenerStub() {
  const listeners = [];
  const stub = jest.fn((fn) => listeners.push(fn));
  stub._listeners = listeners;
  stub._call = (...args) => listeners.forEach((fn) => fn(...args));
  return stub;
}

const chromeMock = {
  declarativeNetRequest: {
    updateSessionRules: jest.fn().mockResolvedValue(undefined),
  },
  storage: {
    local: {
      get: jest.fn().mockResolvedValue({}),
      set: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    },
    session: {
      get: jest.fn().mockResolvedValue({}),
      set: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    },
    onChanged: { addListener: makeAddListenerStub() },
  },
  webRequest: {
    onHeadersReceived: { addListener: makeAddListenerStub() },
  },
  webNavigation: {
    onCommitted:     { addListener: makeAddListenerStub() },
    onBeforeNavigate: { addListener: makeAddListenerStub() },
  },
  tabs: {
    onRemoved: { addListener: makeAddListenerStub() },
    sendMessage: jest.fn().mockResolvedValue(undefined),
    reload: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue([]),
  },
  action: {
    setBadgeText:            jest.fn().mockResolvedValue(undefined),
    setBadgeBackgroundColor: jest.fn().mockResolvedValue(undefined),
  },
  runtime: {
    onMessage:   { addListener: makeAddListenerStub() },
    sendMessage: jest.fn().mockResolvedValue({}),
    openOptionsPage: jest.fn(),
  },
};

global.chrome = chromeMock;

// Expose the factory so individual tests can reset listener state cleanly.
global.__makeAddListenerStub = makeAddListenerStub;
global.__chromeMock = chromeMock;
