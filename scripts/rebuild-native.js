#!/usr/bin/env node
/**
 * rebuild-native.js
 *
 * Downloads prebuilt native binaries for Electron (no Visual Studio needed).
 * Currently handles: better-sqlite3
 *
 * Usage: node scripts/rebuild-native.js
 */

'use strict';

const { execSync } = require('child_process');
const path = require('path');
const electronVersion = require('electron/package.json').version;

const modules = [
  { name: 'better-sqlite3', dir: 'node_modules/better-sqlite3' },
];

// Cross-platform packaging (e.g. building the Windows target from Linux) needs the
// prebuilt binary for the TARGET platform, not whatever this script's own host is -
// prebuild-install defaults to the current host otherwise, silently bundling the
// wrong OS's .node file (only fails at runtime on the target machine, not here).
// Set npm_config_platform/npm_config_arch (standard node-gyp/prebuild-install
// convention) to override, e.g.: npm_config_platform=win32 npm_config_arch=x64
const targetPlatform = process.env.npm_config_platform || process.platform;
const targetArch = process.env.npm_config_arch || process.arch;

for (const mod of modules) {
  const cwd = path.resolve(__dirname, '..', mod.dir);
  console.log(`\n🔧 Rebuilding ${mod.name} for Electron ${electronVersion} (${targetPlatform}/${targetArch})...`);

  try {
    execSync(`npx prebuild-install --runtime electron --target ${electronVersion} --platform ${targetPlatform} --arch ${targetArch}`, {
      cwd,
      stdio: 'inherit',
    });
    console.log(`✅ ${mod.name} rebuilt successfully`);
  } catch (err) {
    console.error(`❌ Failed to rebuild ${mod.name}:`, err.message);
    process.exit(1);
  }
}

console.log('\n✅ All native modules rebuilt for Electron');
