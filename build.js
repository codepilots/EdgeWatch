#!/usr/bin/env node
// build.js – esbuild-based minification and packaging for EdgeWatch.
//
// Each JS file is a separate entry point (no cross-script imports), so they
// are minified individually rather than merged into a single bundle.
//
// Usage:
//   node build.js           # one-shot production build
//   node build.js --watch   # incremental rebuild on source changes
'use strict';

const esbuild  = require('esbuild');
const fs       = require('fs');
const path     = require('path');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');

const WATCH = process.argv.includes('--watch');

// JavaScript entry points – each is a standalone browser script.
const JS_ENTRIES = [
  'background.js',
  'content.js',
  'content-main.js',
  'popup.js',
  'options.js',
];

// Static assets copied verbatim into dist/.
const STATIC_FILES = [
  'manifest.json',
  'popup.html',
  'options.html',
  'rules_block_all.json',
];

// Icon directory (copied recursively).
const ICON_DIR = 'icons';

// ── Helpers ────────────────────────────────────────────────────────────────

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function copyDir(srcDir, destDir) {
  ensureDir(destDir);
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath  = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      copyFile(srcPath, destPath);
    }
  }
}

function copyStatics() {
  for (const file of STATIC_FILES) {
    copyFile(path.join(ROOT, file), path.join(DIST, file));
  }
  copyDir(path.join(ROOT, ICON_DIR), path.join(DIST, ICON_DIR));
}

// ── Build ──────────────────────────────────────────────────────────────────

/** esbuild plugin that copies static assets after every build. */
const copyStaticsPlugin = {
  name: 'copy-statics',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length === 0) {
        copyStatics();
        console.log(`[EdgeWatch] Build complete → ${DIST}`);
      }
    });
  },
};

const buildOptions = {
  entryPoints: JS_ENTRIES.map((f) => path.join(ROOT, f)),
  outdir: DIST,
  bundle: false,      // Scripts rely on browser globals, not ES module imports
  minify: true,
  sourcemap: false,
  target: ['chrome120', 'edge120'],
  format: 'iife',
  platform: 'browser',
  plugins: [copyStaticsPlugin],
};

(async () => {
  ensureDir(DIST);

  if (WATCH) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log('[EdgeWatch] Watching for changes…');
  } else {
    await esbuild.build(buildOptions);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
