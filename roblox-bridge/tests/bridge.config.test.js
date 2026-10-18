'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, ConfigError } = require('../bridge/config');

test('config: defaults', (t) => {
  const { config, warnings } = loadConfig([], {});
  assert.equal(config.port, 8787);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.requireToken, false);
  assert.equal(config.token, null);
  // Unprotected non-loopback generates a warning, but 127.0.0.1 shouldn't
  assert.equal(warnings.length, 0);
});

test('config: arguments and environment', (t) => {
  const { config } = loadConfig(['--port', '9000', '--host', '0.0.0.0'], {
    ROBLOX_BRIDGE_PORT: '8000', // CLI overrides env
    ROBLOX_BRIDGE_REQUIRE_TOKEN: '1',
    ROBLOX_BRIDGE_TOKEN: 'secret',
  });
  
  assert.equal(config.port, 9000);
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.requireToken, true);
  assert.equal(config.token, 'secret');
});

test('config: bad arguments', (t) => {
  assert.throws(() => loadConfig(['--port']), ConfigError);
  assert.throws(() => loadConfig(['--port', 'abc']), ConfigError);
  assert.throws(() => loadConfig(['--log-level', 'fatal']), ConfigError);
});

test('config: warnings', (t) => {
  const { warnings } = loadConfig(['--host', '0.0.0.0'], {});
  assert.ok(warnings.some(w => w.includes('without --require-token')));
  
  const { warnings: w2 } = loadConfig(['--token', 'abc'], {});
  assert.ok(w2.some(w => w.includes('is NOT set')));
});
