### Overview

**Goal:** Specify a Microsoft Edge (Chromium, Manifest V3) extension that enforces **per‑tab budgets** for:

- **Network data**
- **JavaScript compute**
- **Resources (DOM/images/workers)**

and optionally reports **aggregated telemetry** to a remote “civility observatory” server.

The spec is written so an LLM can generate the full extension codebase.

---

### Functional requirements

**FR1 – Network data budget**

- **Per‑tab, per‑navigation data cap**, default: **50 MB** of downloaded subresources.
- Count bytes using `webRequest.onHeadersReceived` and the `Content-Length` header.
- Count only subresources (scripts, images, XHR/fetch, media, fonts, stylesheets, subframes, other).
- When a tab exceeds the budget:
  - Block further subresource requests for that tab using `declarativeNetRequest` tab‑scoped rules.
  - Show a **badge** or visual indicator on the extension icon.
- Provide a **popup button**: “Allow another 50 MB for this page”, which:
  - Removes the blocking rule for that tab.
  - Resets that tab’s data counter to 0.

**FR2 – Compute budget (JS execution)**

- Implement a **content script** injected into all pages.
- Wrap key JS scheduling APIs to estimate compute usage:
  - `setTimeout`, `setInterval`, `requestAnimationFrame`, `requestIdleCallback`, `Promise` microtasks (if feasible), and optionally event listeners.
- For each wrapped call:
  - Measure execution time using `performance.now()` before/after the callback.
  - Accumulate a **per‑tab compute usage** value (e.g., total ms).
- Define a **compute budget** per page (e.g., **2000 ms total** per navigation).
- When the compute budget is exceeded:
  - Content script sends a message to the background script.
  - Background script instructs the content script to **disable JS** for that page.

**FR3 – Resource budget (DOM/images/workers)**

- In the content script, track **resource pressure** via proxies:
  - **Image count**:
    - Wrap `Image` constructor.
    - Use a `MutationObserver` to detect added `<img>` elements.
  - **DOM size**:
    - Periodically (e.g., once per second) count `document.getElementsByTagName("*").length`.
  - **Worker count**:
    - Wrap `Worker` constructor and increment a counter.
- Define thresholds, e.g.:
  - `MAX_IMAGES = 200`
  - `MAX_DOM_NODES = 10000`
  - `MAX_WORKERS = 4`
- When any threshold is exceeded:
  - Content script sends a message to background: `RESOURCE_LIMIT_EXCEEDED`.
  - Background responds with `DISABLE_JS` for that tab.

**FR4 – Unified “pressure score” (optional but preferred)**

- Instead of many separate decisions, compute a **single pressure score** in the content script:
  - Long JS task (>50 ms): add +20.
  - Burst of DOM mutations: +10.
  - New worker: +30.
  - 10 new images: +15.
  - 5 network requests in 1 second (reported from background): +10.
- Apply decay each second, e.g.: `pressure = pressure * 0.8`.
- When `pressure > 100`:
  - Trigger `DISABLE_JS` for that tab (same as compute/resource limit exceeded).

**FR5 – JS disablement behaviour**

When JS is disabled for a page (due to compute/resource/pressure):

- In the content script:
  - Replace heavy APIs with inert stubs:
    - `window.setTimeout`, `window.setInterval`, `window.requestAnimationFrame`, `window.requestIdleCallback`.
    - `window.fetch`, `XMLHttpRequest`.
    - `window.Worker`, `SharedWorker`.
  - Optionally block `WebAssembly` and `WebGL` by overriding constructors.
- Inject a **full‑page overlay** informing the user:
  - “This page exceeded its behaviour budget. JavaScript has been paused.”
  - Provide a button: “Temporarily allow this page”.
    - On click, send a message to background to **re‑enable JS** (by reloading the page or by restoring original APIs if stored).

**FR6 – Navigation and tab lifecycle**

- Use `chrome.webNavigation.onCommitted`:
  - On main‑frame navigation (`frameId === 0`):
    - Reset per‑tab data usage.
    - Reset per‑tab compute usage.
    - Reset per‑tab resource counters and pressure score.
    - Remove any tab‑scoped blocking rules.
- On `chrome.tabs.onRemoved`:
  - Clean up all state for that tab (data, compute, resources, pressure, rules).

**FR7 – Popup UI**

- Popup shows, for the **current tab**:
  - Approximate **data used / data budget** (e.g., “32 MB / 50 MB”).
  - **Compute usage** (e.g., “1.4 s / 2.0 s”).
  - **Resource status** (e.g., “Images: 120/200, DOM nodes: 4500/10000, Workers: 1/4”).
  - Current **pressure score** (if implemented).
- Buttons:
  - “Allow another 50 MB for this page” → resets data budget and unblocks network for this tab.
  - “Temporarily allow JS for this page” → clears JS disablement for this navigation (e.g., reloads page with a flag to skip enforcement once).

**FR8 – Telemetry (optional)**

- If enabled via a config flag in the code:
  - Periodically (e.g., every 60 seconds or on navigation end) send **anonymous aggregated telemetry** to a configurable HTTPS endpoint.
  - Payload example:
    ```json
    {
      "domain": "example.com",
      "path": "/some/page",
      "dataUsedBytes": 1234567,
      "computeMs": 1800,
      "images": 150,
      "domNodes": 6000,
      "workers": 2,
      "pressureMax": 120,
      "interventions": 1,
      "timestamp": 1710000000000
    }
    ```
  - No user identifiers, no cookies, no IP logging in the extension.

---

### Non‑functional requirements

- **Manifest:** MV3, compatible with Microsoft Edge (Chromium).
- **Permissions:**
  - `declarativeNetRequest`, `declarativeNetRequestFeedback`
  - `webRequest`, `webRequestBlocking`
  - `tabs`, `storage`, `webNavigation`
  - `scripting` (for content script injection, if needed)
  - `host_permissions: ["<all_urls>"]`
- **Performance:**
  - Content script must be lightweight:
    - Use throttled/interval checks where possible.
    - Avoid heavy DOM scans more than once per second.
  - Background script must avoid excessive logging or storage writes.
- **Privacy:**
  - No user‑identifying data.
  - Telemetry must be optional and easy to disable at build time.
- **Resilience:**
  - All overrides (e.g., `setTimeout`, `Worker`) must be robust against pages redefining them.
  - Extension should fail gracefully if some APIs are unavailable.

---

### File structure (suggested)

- `manifest.json`
- `background.js` (or `background.mjs`)
- `content.js` (content script with compute/resource/pressure logic)
- `popup.html`
- `popup.js`
- `rules_block_all.json` (base DNR rules for blocking subresources)
- `options.html` / `options.js` (optional, for configuring budgets and telemetry endpoint)

---

### Key behaviours to implement

1. **Per‑tab data budget with blocking and reset on navigation.**
2. **Per‑tab compute budget via wrapped JS APIs and disablement.**
3. **Resource budget via image/DOM/worker tracking.**
4. **Optional unified pressure score driving a single intervention decision.**
5. **Popup UI exposing current budgets and manual overrides.**
6. **Optional telemetry to a remote server with aggregated, anonymous metrics.**

Use this specification as the input for the LLM to generate all necessary code and assets for the extension.
