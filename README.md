# EdgeWatch
An edge extension that ensures pages don't overstep their welcome

## Development

### Prerequisites

- **Node.js** ≥ 18 (LTS recommended)
- **npm** ≥ 9

```bash
npm install
```

### Available scripts

| Command | Description |
|---|---|
| `npm run lint` | Run ESLint across all source files |
| `npm test` | Run Jest unit/integration tests |
| `npm run build` | Minify & bundle to `dist/` (production) |
| `npm run build:watch` | Incremental rebuild on file changes |

### Project structure

```
├── background.js      # Service-worker (background context)
├── content.js         # Isolated-world bridge content script
├── content-main.js    # Main-world content script
├── popup.js / .html   # Extension popup
├── options.js / .html # Settings page
├── build.js           # esbuild build script
├── eslint.config.js   # ESLint 9 flat config
├── jest.config.js     # Jest 30 configuration
└── tests/             # Unit and integration tests
```

### CI

Every push and pull request runs the **Lint → Test → Build** pipeline via GitHub Actions (`.github/workflows/ci.yml`). A `dist/` artifact is uploaded on each successful run.

---

## Package and Install

### 1. Build the extension

```bash
npm run build
```

This produces a `dist/` directory containing the minified, ready-to-install extension.

### 2. Install in Microsoft Edge (recommended for local testing)

1. Open `edge://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `dist/` folder (or the project root for unminified development).

### 3. Install from a packaged file (distribution/testing)

Zip the contents of `dist/` with `manifest.json` at the archive root and distribute or load via **Load unpacked** from the extracted folder.

```powershell
# PowerShell – package the built output
Compress-Archive -Path .\dist\* -DestinationPath .\EdgeWatch-1.0.0.zip -Force
```

If you need a signed installable package for broad distribution, publish through the Microsoft Edge Add-ons store.
