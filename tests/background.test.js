'use strict';
// tests/background.test.js
// Validates the race-condition fix: the DNR blocking rule must be removed in
// webNavigation.onBeforeNavigate (before document_start) so that initial page
// resource requests on a new navigation are not blocked by a rule left from a
// previous navigation.

const DNR_RULE_ID_BASE = 10_000;

// background.js registers listeners synchronously on require; load it once.
let onBeforeNavigateHandler;
let onCommittedHandler;

beforeAll(() => {
  jest.resetModules();

  // Reset mocks so call counts start at zero.
  chrome.declarativeNetRequest.updateSessionRules.mockClear();
  chrome.webNavigation.onBeforeNavigate.addListener.mockClear();
  chrome.webNavigation.onCommitted.addListener.mockClear();

  require('../background.js');

  // Capture the registered handlers.
  onBeforeNavigateHandler =
    chrome.webNavigation.onBeforeNavigate.addListener.mock.calls[0]?.[0];
  onCommittedHandler =
    chrome.webNavigation.onCommitted.addListener.mock.calls[0]?.[0];
});

// ---------------------------------------------------------------------------
describe('webNavigation.onBeforeNavigate (Fix 1 – early DNR rule removal)', () => {
  it('registers an onBeforeNavigate listener', () => {
    expect(onBeforeNavigateHandler).toBeInstanceOf(Function);
  });

  it('removes the DNR blocking rule for the navigating tab on main-frame events', async () => {
    const tabId = 42;
    chrome.declarativeNetRequest.updateSessionRules.mockClear();

    await onBeforeNavigateHandler({ frameId: 0, tabId });

    expect(chrome.declarativeNetRequest.updateSessionRules).toHaveBeenCalledWith(
      expect.objectContaining({ removeRuleIds: [DNR_RULE_ID_BASE + tabId] }),
    );
  });

  it('ignores sub-frame navigation events', async () => {
    chrome.declarativeNetRequest.updateSessionRules.mockClear();

    await onBeforeNavigateHandler({ frameId: 1, tabId: 99 });

    expect(chrome.declarativeNetRequest.updateSessionRules).not.toHaveBeenCalled();
  });

  it('fires before the onCommitted handler so the rule is cleared first', () => {
    // Both listeners must be registered.  The order in the source guarantees
    // onBeforeNavigate is added before onCommitted, matching the event order.
    const beforeNavIdx = chrome.webNavigation.onBeforeNavigate.addListener.mock.invocationCallOrder[0];
    const committedIdx = chrome.webNavigation.onCommitted.addListener.mock.invocationCallOrder[0];
    expect(beforeNavIdx).toBeLessThan(committedIdx);
  });
});

// ---------------------------------------------------------------------------
describe('webNavigation.onCommitted (state reset)', () => {
  it('registers an onCommitted listener', () => {
    expect(onCommittedHandler).toBeInstanceOf(Function);
  });

  it('resets per-tab state and removes the blocking rule on main-frame commit', async () => {
    const tabId = 7;
    chrome.declarativeNetRequest.updateSessionRules.mockClear();

    await onCommittedHandler({ frameId: 0, tabId });

    // resetState calls removeBlockingRule which calls updateSessionRules.
    expect(chrome.declarativeNetRequest.updateSessionRules).toHaveBeenCalledWith(
      expect.objectContaining({ removeRuleIds: [DNR_RULE_ID_BASE + tabId] }),
    );
  });

  it('ignores sub-frame commit events', async () => {
    chrome.declarativeNetRequest.updateSessionRules.mockClear();

    await onCommittedHandler({ frameId: 2, tabId: 99 });

    expect(chrome.declarativeNetRequest.updateSessionRules).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('Message handler – GET_STATE', () => {
  let messageHandler;

  beforeAll(() => {
    messageHandler = chrome.runtime.onMessage.addListener.mock.calls[0]?.[0];
  });

  it('returns default state for an unknown tabId', () => {
    const sendResponse = jest.fn();
    messageHandler(
      { type: 'GET_STATE' },
      { tab: { id: 9999 } },
      sendResponse,
    );
    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({
          dataUsed: 0,
          blocked: false,
          jsDisabled: false,
        }),
      }),
    );
  });
});
