'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const CLI_PATH = path.join(__dirname, '../cli/cli.js');

test('cli: token generator', (t) => {
  const result = spawnSync(process.execPath, [CLI_PATH, 'token'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.ok(result.stdout.trim().length >= 32);
});

test('cli: help', (t) => {
  const result = spawnSync(process.execPath, [CLI_PATH, 'help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes('Usage: rbb <command>'));
});
