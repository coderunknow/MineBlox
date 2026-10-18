'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BUILD_DIR = path.join(ROOT, 'build');
const ZIP_PATH = path.join(ROOT, 'roblox-bridge.zip');

function packageRelease() {
  console.log('[package] Cleaning build directory...');
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  fs.mkdirSync(BUILD_DIR, { recursive: true });

  console.log('[package] Building plugin...');
  require('../plugin/build').build();

  console.log('[package] Copying files...');
  
  const filesToCopy = [
    'bridge/auth.js',
    'bridge/config.js',
    'bridge/http-util.js',
    'bridge/logger.js',
    'bridge/server.js',
    'bridge/store.js',
    'cli/cli.js',
    'plugin/roblox-bridge.rbxmx',
    'package.json',
    'README.md',
    'INSTALL_WINDOWS.md',
    'tests/bridge.api.test.js',
    'tests/bridge.auth.test.js',
    'tests/bridge.config.test.js',
    'tests/cli.test.js',
  ];

  for (const file of filesToCopy) {
    const src = path.join(ROOT, file);
    if (!fs.existsSync(src)) continue; // README, INSTALL_WINDOWS might be added later
    
    const dst = path.join(BUILD_DIR, file);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }

  // Create zip
  console.log('[package] Creating zip archive...');
  if (fs.existsSync(ZIP_PATH)) {
    fs.unlinkSync(ZIP_PATH);
  }
  
  const res = spawnSync('zip', ['-r', ZIP_PATH, '.'], { cwd: BUILD_DIR, encoding: 'utf8' });
  if (res.status !== 0) {
    console.error('Failed to create zip file:', res.stderr);
    process.exit(1);
  }

  console.log(`[package] Created ${ZIP_PATH}`);
}

if (require.main === module) {
  packageRelease();
}
