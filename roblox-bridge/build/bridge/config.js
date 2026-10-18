'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = Object.freeze({
  port: 8787,
  host: '127.0.0.1',
  requireToken: false,
  logLevel: 'info',
  sessionTtlMs: 120_000,
  commandTimeoutMs: 60_000,
  maxSessions: 32,
  maxBodyBytes: 1_048_576,
  corsAllowOrigin: null,
  pollIntervalMs: 1000,
});

const LOG_LEVELS = Object.freeze({ silent: 0, error: 1, warn: 2, info: 3, debug: 4 });

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

class ConfigError extends Error {
  constructor(message, code = 2) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
  }
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function parseBoolean(value) {
  const normalized = String(value).trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return null;
}

/**
 * @param {string} value
 * @param {string} name
 * @returns {number}
 */
function parseInteger(value, name) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    throw new ConfigError(`Invalid value for ${name}: ${JSON.stringify(value)} (expected an integer)`);
  }
  return parsed;
}

/**
 * Read a shared secret from a file.
 * Trailing newlines are stripped because `echo secret > token.txt` is the
 * most common way people create such a file.
 *
 * @param {string} filePath
 * @returns {string}
 */
function readTokenFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new ConfigError(`Could not read token file "${filePath}": ${err.message}`);
  }
  const token = raw.replace(/\r?\n$/, '').trim();
  if (!token) {
    throw new ConfigError(`Token file "${filePath}" is empty`);
  }
  return token;
}

/**
 * Parse command line arguments.
 *
 * @param {string[]} argv
 * @returns {Record<string, string|boolean|string[]>}
 */
function parseArgs(argv) {
  /** @type {Record<string, string|boolean|string[]>} */
  const out = {};

  const setValue = (key, value) => {
    if (key in out) {
      const current = out[key];
      if (Array.isArray(current)) current.push(value);
      else out[key] = [String(current), value];
    } else {
      out[key] = value;
    }
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      throw new ConfigError(`Unexpected argument "${arg}". All options start with "--".`);
    }

    let name = arg.slice(2);
    let inlineValue;

    const equals = name.indexOf('=');
    if (equals !== -1) {
      inlineValue = name.slice(equals + 1);
      name = name.slice(0, equals);
    }

    if (name.startsWith('no-')) {
      const positive = name.slice(3);
      setValue(positive, 'false');
      continue;
    }

    const takesValue = new Set([
      'port',
      'host',
      'token',
      'token-file',
      'log-level',
      'session-ttl',
      'command-timeout',
      'max-sessions',
      'allow-origin',
      'poll-interval',
    ]);

    if (!takesValue.has(name)) {
      // Boolean flag.
      setValue(name, inlineValue === undefined ? 'true' : inlineValue);
      continue;
    }

    if (inlineValue !== undefined) {
      setValue(name, inlineValue);
      continue;
    }

    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new ConfigError(`Option --${name} requires a value`);
    }
    setValue(name, next);
    i += 1;
  }

  return out;
}

/**
 * @param {string|string[]|undefined} value
 * @returns {string[]}
 */
function toList(value) {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.map(String);
  return [String(value)];
}

/**
 * Resolve the effective configuration from CLI arguments and environment
 * variables. CLI arguments win over environment variables.
 *
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{config: object, warnings: string[]}}
 */
function loadConfig(argv = [], env = process.env) {
  const args = parseArgs(argv);
  const warnings = [];

  const config = { ...DEFAULTS };

  // --- host / port -------------------------------------------------------
  if (args.host !== undefined) config.host = String(args.host);
  else if (env.ROBLOX_BRIDGE_HOST) config.host = env.ROBLOX_BRIDGE_HOST;

  if (args.port !== undefined) config.port = parseInteger(args.port, '--port');
  else if (env.ROBLOX_BRIDGE_PORT) config.port = parseInteger(env.ROBLOX_BRIDGE_PORT, 'ROBLOX_BRIDGE_PORT');

  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new ConfigError(`Invalid port: ${config.port} (expected 0-65535)`);
  }

  // --- logging ------------------------------------------------------------
  if (args['log-level'] !== undefined) config.logLevel = String(args['log-level']);
  else if (env.ROBLOX_BRIDGE_LOG_LEVEL) config.logLevel = env.ROBLOX_BRIDGE_LOG_LEVEL;
  if (!(config.logLevel in LOG_LEVELS)) {
    throw new ConfigError(
      `Invalid log level "${config.logLevel}". Expected one of: ${Object.keys(LOG_LEVELS).join(', ')}`,
    );
  }

  // --- token enforcement --------------------------------------------------
  let requireToken = DEFAULTS.requireToken;
  if (args['require-token'] !== undefined) {
    const parsed = parseBoolean(args['require-token']);
    if (parsed === null) throw new ConfigError(`Invalid value for --require-token: ${args['require-token']}`);
    requireToken = parsed;
  } else if (env.ROBLOX_BRIDGE_REQUIRE_TOKEN !== undefined) {
    const parsed = parseBoolean(env.ROBLOX_BRIDGE_REQUIRE_TOKEN);
    if (parsed === null) {
      throw new ConfigError(`Invalid value for ROBLOX_BRIDGE_REQUIRE_TOKEN: ${env.ROBLOX_BRIDGE_REQUIRE_TOKEN}`);
    }
    requireToken = parsed;
  }
  config.requireToken = requireToken;

  // --- shared secret ------------------------------------------------------
  let token = null;
  let tokenSource = null;

  if (args.token !== undefined) {
    token = String(args.token);
    tokenSource = '--token';
  } else if (env.ROBLOX_BRIDGE_TOKEN) {
    token = env.ROBLOX_BRIDGE_TOKEN;
    tokenSource = 'ROBLOX_BRIDGE_TOKEN';
  } else {
    const tokenFile = args['token-file'] !== undefined ? String(args['token-file']) : env.ROBLOX_BRIDGE_TOKEN_FILE;
    if (tokenFile) {
      token = readTokenFile(path.resolve(tokenFile));
      tokenSource = `--token-file ${tokenFile}`;
    }
  }

  if (token !== null && token.trim() === '') {
    throw new ConfigError('The configured token is empty. Generate one with: node cli/cli.js token');
  }
  if (token !== null) token = token.trim();

  config.token = token;
  config.tokenSource = tokenSource;

  // --- tuning -------------------------------------------------------------
  if (args['session-ttl'] !== undefined) config.sessionTtlMs = parseInteger(args['session-ttl'], '--session-ttl') * 1000;
  else if (env.ROBLOX_BRIDGE_SESSION_TTL) {
    config.sessionTtlMs = parseInteger(env.ROBLOX_BRIDGE_SESSION_TTL, 'ROBLOX_BRIDGE_SESSION_TTL') * 1000;
  }

  if (args['command-timeout'] !== undefined) {
    config.commandTimeoutMs = parseInteger(args['command-timeout'], '--command-timeout') * 1000;
  } else if (env.ROBLOX_BRIDGE_COMMAND_TIMEOUT) {
    config.commandTimeoutMs = parseInteger(env.ROBLOX_BRIDGE_COMMAND_TIMEOUT, 'ROBLOX_BRIDGE_COMMAND_TIMEOUT') * 1000;
  }

  if (args['max-sessions'] !== undefined) config.maxSessions = parseInteger(args['max-sessions'], '--max-sessions');
  else if (env.ROBLOX_BRIDGE_MAX_SESSIONS) {
    config.maxSessions = parseInteger(env.ROBLOX_BRIDGE_MAX_SESSIONS, 'ROBLOX_BRIDGE_MAX_SESSIONS');
  }

  if (args['poll-interval'] !== undefined) {
    config.pollIntervalMs = parseInteger(args['poll-interval'], '--poll-interval');
  } else if (env.ROBLOX_BRIDGE_POLL_INTERVAL) {
    config.pollIntervalMs = parseInteger(env.ROBLOX_BRIDGE_POLL_INTERVAL, 'ROBLOX_BRIDGE_POLL_INTERVAL');
  }
  if (config.pollIntervalMs < 100) {
    throw new ConfigError('--poll-interval must be at least 100 ms (Roblox limits HTTP requests to 500/minute)');
  }

  // --- CORS ---------------------------------------------------------------
  const allowOrigin = toList(args['allow-origin']);
  if (allowOrigin.length > 0) config.corsAllowOrigin = allowOrigin;
  else if (env.ROBLOX_BRIDGE_ALLOW_ORIGIN) {
    config.corsAllowOrigin = env.ROBLOX_BRIDGE_ALLOW_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);
  }

  if (args.cors !== undefined) {
    const parsed = parseBoolean(args.cors);
    if (parsed === null) throw new ConfigError(`Invalid value for --cors: ${args.cors}`);
    if (parsed) config.corsAllowOrigin = ['*'];
  } else if (env.ROBLOX_BRIDGE_CORS) {
    const parsed = parseBoolean(env.ROBLOX_BRIDGE_CORS);
    if (parsed) config.corsAllowOrigin = ['*'];
  }

  // --- consistency checks -------------------------------------------------
  if (config.requireToken && !config.token) {
    throw new ConfigError(
      '--require-token was requested but no token was provided.\n' +
        'Provide one with --token <token>, --token-file <path> or ROBLOX_BRIDGE_TOKEN=<token>.\n' +
        'Generate a strong token with: node cli/cli.js token',
    );
  }

  if (config.token && !config.requireToken) {
    warnings.push(
      'A token is configured but --require-token is NOT set: every API endpoint is currently reachable ' +
        'without authentication. Add --require-token before exposing the bridge through a tunnel.',
    );
  }

  if (!isLoopbackHost(config.host) && !config.requireToken) {
    warnings.push(
      `The bridge is bound to ${config.host} (not a loopback address) without --require-token. ` +
        'Anyone who can reach this port can run code in your Studio session.',
    );
  }

  return { config, warnings };
}

/**
 * @param {string} host
 * @returns {boolean}
 */
function isLoopbackHost(host) {
  const normalized = String(host).trim().toLowerCase();
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1' || normalized === '[::1]';
}

module.exports = { DEFAULTS, LOG_LEVELS, ConfigError, loadConfig, parseArgs, parseBoolean, isLoopbackHost, readTokenFile };
