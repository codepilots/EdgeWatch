# EdgeWatch
An edge extension that ensures pages don't overstep their welcome

## Package and Install

### 1. Package the extension

From the project root, create a zip that contains the extension files (with `manifest.json` at the zip root).

PowerShell example:

```powershell
Compress-Archive -Path .\background.js, .\content.js, .\content-main.js, .\popup.html, .\popup.js, .\options.html, .\options.js, .\manifest.json, .\rules_block_all.json, .\icons\* -DestinationPath .\EdgeWatch-1.0.0.zip -Force
```

Notes:
- Do not include build artifacts, local config, or VCS folders in the package.
- Keep `manifest.json` in the top level of the archive.

### 2. Install in Microsoft Edge (recommended for local testing)

1. Open `edge://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this project folder (`EdgeWatch`).

This is the fastest workflow for development because changes can be applied by reloading the extension.

### 3. Install from a packaged file (distribution/testing)

1. Extract `EdgeWatch-1.0.0.zip` to a folder.
2. Open `edge://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the extracted folder.

If you need a signed installable package for broad distribution, publish through the Microsoft Edge Add-ons store.
