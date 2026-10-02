/**
 * build-bridge-e2ee.js - Cross-platform Go bridge build script.
 *
 * Detects the current platform and builds the appropriate binary:
 *   Windows  → fbchat-bridge-e2ee.exe
 *   Linux    → fbchat-bridge-e2ee
 *   macOS    → fbchat-bridge-e2ee
 *
 * Also handles cloning the mautrix/meta dependency if not present.
 *
 * Usage:
 *   node scripts/build-bridge-e2ee.js
 *
 * Exit codes:
 *   0 - success
 *   1 - failure (caller handles via || in npm scripts)
 */

'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const BRIDGE_DIR = path.resolve(__dirname, '..', 'src', 'bridge-e2ee');
const META_DIR = path.join(BRIDGE_DIR, 'meta');
const BUILD_DIR = path.join(BRIDGE_DIR, 'build');
const META_REPO = 'https://github.com/mautrix/meta.git';
// Ghim commit của mautrix/meta để build lặp lại được: HEAD của họ đổi API thường xuyên
// (ví dụ 09/2026 cần bản beeper/req mới hơn bản ghim trong go.mod) và làm build hỏng.
// Khi nâng commit này, chạy `go mod tidy` và cập nhật dòng `replace github.com/imroc/req/v3`
// trong src/bridge-e2ee/go.mod cho khớp với `replace` trong meta/go.mod.
const META_COMMIT = 'e012f9f83ee0abd332b6160f57ecd07014c2d445';
const BINARY_NAME = process.platform === 'win32'
  ? 'fbchat-bridge-e2ee.exe'
  : 'fbchat-bridge-e2ee';

function run(cmd, opts = {}) {
  const cwd = opts.cwd || BRIDGE_DIR;
  console.log(`[build-bridge] $ ${cmd}  (cwd: ${path.relative(process.cwd(), cwd)})`);
  execSync(cmd, { cwd, stdio: 'inherit', ...opts });
}

function isGoInstalled() {
  try {
    execSync('go version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function main() {
  // ── 0. Prerequisites ──────────────────────────────────────────────────
  if (!isGoInstalled()) {
    console.error('[build-bridge] ❌ Go is not installed. Install Go ≥ 1.24 from https://go.dev/dl/');
    process.exit(1);
  }

  if (!fs.existsSync(BRIDGE_DIR)) {
    console.error(`[build-bridge] ❌ Bridge directory not found: ${BRIDGE_DIR}`);
    process.exit(1);
  }

  // ── 1. Fetch mautrix/meta at the pinned commit ────────────────────────
  const metaGoMod = path.join(META_DIR, 'go.mod');
  let metaHead = '';
  if (fs.existsSync(metaGoMod)) {
    try {
      metaHead = execSync('git rev-parse HEAD', { cwd: META_DIR }).toString().trim();
    } catch {
      metaHead = '';
    }
  }
  if (metaHead === META_COMMIT) {
    console.log(`[build-bridge] ✅ meta/ already at ${META_COMMIT.slice(0, 7)}`);
  } else {
    console.log(`[build-bridge] 📥 fetching mautrix/meta @ ${META_COMMIT.slice(0, 7)}...`);
    if (fs.existsSync(META_DIR)) {
      fs.rmSync(META_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(META_DIR, { recursive: true });
    run('git init -q', { cwd: META_DIR });
    run(`git remote add origin ${META_REPO}`, { cwd: META_DIR });
    run(`git fetch -q --depth=1 origin ${META_COMMIT}`, { cwd: META_DIR });
    run('git checkout -q FETCH_HEAD', { cwd: META_DIR });
    console.log('[build-bridge] ✅ meta/ ready');
  }

  // ── 2. Ensure build/ directory ────────────────────────────────────────
  if (!fs.existsSync(BUILD_DIR)) {
    fs.mkdirSync(BUILD_DIR, { recursive: true });
  }

  // ── 3. go mod tidy ────────────────────────────────────────────────────
  console.log('[build-bridge] 📦 go mod tidy...');
  run('go mod tidy');

  // ── 4. go build ───────────────────────────────────────────────────────
  const outputPath = path.join(BUILD_DIR, BINARY_NAME);
  // Use forward slashes in the output path to avoid shell escaping issues on Windows
  const escapedOutput = outputPath.replace(/\\/g, '/');
  console.log(`[build-bridge] 🔨 Building: ${BINARY_NAME}`);
  run(`go build -ldflags="-s -w" -o "${escapedOutput}" .`);

  const fileSize = fs.statSync(outputPath).size;
  console.log(`[build-bridge] ✅ Built: ${BINARY_NAME} (${(fileSize / 1024 / 1024).toFixed(1)} MB)`);
}

try {
  main();
} catch (err) {
  console.error(`[build-bridge] ❌ Failed: ${err.message}`);
  process.exit(1);
}
