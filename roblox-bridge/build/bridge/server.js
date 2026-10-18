'use strict';

const http = require('node:http');
const { randomUUID } = require('node:crypto');

const { loadConfig, ConfigError } = require('./config');
const { Logger } = require('./logger');
const { SessionStore } = require('./store');
const { extractToken, authorize, redactToken } = require('./auth');
const { sendJson, sendText, readJsonBody, parseTarget, applyCors } = require('./http-util');

const NAME = 'roblox-bridge';
const VERSION = require('../package.json').version;
const PROTOCOL_VERSION = 1;

const MAX_CODE_LENGTH = 200_000;
const COMMAND_TYPES = new Set(['exec', 'ping']);

/**
 * Create the bridge HTTP server.
 *
 * @param {object} [options]
 * @param {object} [options.config] Pre-resolved configuration (see bridge/config.js).
 * @param {Logger} [options.logger]
 * @returns {{server: import('node:http').Server, config: object, store: SessionStore, logger: Logger}}
 */
function createServer({ config, logger } = {}) {
  const resolved = config || loadConfig([]).config;
  const log = logger || new Logger({ level: resolved.logLevel });
  const store = new SessionStore({
    sessionTtlMs: resolved.sessionTtlMs,
    commandTimeoutMs: resolved.commandTimeoutMs,
    maxSessions: resolved.maxSessions,
  });

  const startedAt = Date.now();

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} pathname
   * @returns {boolean} true when the request was handled
   */
  function handlePublic(req, res, pathname) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return true;
    }

    if (req.method === 'GET' && (pathname === '/' || pathname === '/api')) {
      sendJson(res, 200, {
        name: NAME,
        version: VERSION,
        protocolVersion: PROTOCOL_VERSION,
        authRequired: resolved.requireToken,
        endpoints: [
          'GET  /api/health',
          'POST /api/plugin/register',
          'POST /api/plugin/poll',
          'POST /api/plugin/result',
          'GET  /api/sessions',
          'GET  /api/sessions/:id',
          'POST /api/sessions/:id/commands',
          'POST /api/sessions/:id/ping',
          'DELETE /api/sessions/:id',
          'GET  /api/commands/:id',
        ],
      });
      return true;
    }

    if (req.method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        name: NAME,
        version: VERSION,
        protocolVersion: PROTOCOL_VERSION,
        authRequired: resolved.requireToken,
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        sessionCount: store.list().length,
        serverTime: new Date().toISOString(),
      });
      return true;
    }

    if (req.method === 'GET' && pathname === '/api/version') {
      sendJson(res, 200, { name: NAME, version: VERSION, protocolVersion: PROTOCOL_VERSION });
      return true;
    }

    return false;
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string[]} segments
   * @returns {Promise<boolean>}
   */
  async function handleApi(req, res, segments) {
    const [, resource, id, sub] = segments;

    if (resource === 'plugin') {
      if (req.method === 'POST' && id === 'register') {
        const body = await readJsonBody(req, resolved.maxBodyBytes);
        if (!body.ok) {
          sendJson(res, body.status, { error: body.error });
          return true;
        }
        const meta = body.value || {};
        const session = store.register({
          name: meta.name,
          placeId: meta.placeId,
          placeName: meta.placeName,
          studioVersion: meta.studioVersion,
          userAgent: meta.userAgent,
        });
        log.info('studio session registered', { sessionId: session.id, name: session.name });
        sendJson(res, 201, {
          sessionId: session.id,
          protocolVersion: PROTOCOL_VERSION,
          pollIntervalMs: resolved.pollIntervalMs,
          commandTimeoutMs: resolved.commandTimeoutMs,
          serverTime: new Date().toISOString(),
        });
        return true;
      }

      if (req.method === 'POST' && id === 'poll') {
        const body = await readJsonBody(req, resolved.maxBodyBytes);
        if (!body.ok) {
          sendJson(res, body.status, { error: body.error });
          return true;
        }
        const sessionId = (body.value || {}).sessionId;
        const session = store.touch(sessionId);
        if (!session) {
          sendJson(res, 404, { error: 'unknown-session', message: `Session "${sessionId}" is not registered.` });
          return true;
        }
        const commands = store.takePending(sessionId).map((command) => ({
          id: command.id,
          type: command.type,
          code: command.code,
          createdAt: command.createdAt,
          timeoutAt: command.timeoutAt,
        }));
        sendJson(res, 200, { commands, serverTime: new Date().toISOString() });
        return true;
      }

      if (req.method === 'POST' && id === 'result') {
        const body = await readJsonBody(req, resolved.maxBodyBytes);
        if (!body.ok) {
          sendJson(res, body.status, { error: body.error });
          return true;
        }
        const payload = body.value || {};
        const command = store.getCommand(payload.commandId);
        if (!command) {
          sendJson(res, 404, { error: 'unknown-command', message: `Command "${payload.commandId}" is not known.` });
          return true;
        }
        if (payload.sessionId && command.sessionId !== payload.sessionId) {
          sendJson(res, 403, { error: 'session-mismatch' });
          return true;
        }
        store.completeCommand(command.id, {
          ok: Boolean(payload.ok),
          output: typeof payload.output === 'string' ? payload.output : '',
          error: payload.error ? String(payload.error) : null,
          durationMs: Number.isFinite(payload.durationMs) ? payload.durationMs : null,
        });
        log.debug('command result received', { commandId: command.id, ok: Boolean(payload.ok) });
        sendJson(res, 200, { ok: true, commandId: command.id });
        return true;
      }

      return false;
    }

    if (resource === 'sessions') {
      if (req.method === 'GET' && !id) {
        sendJson(res, 200, { sessions: store.list() });
        return true;
      }

      if (id) {
        if (req.method === 'GET' && !sub) {
          const session = store.get(id);
          if (!session) {
            sendJson(res, 404, { error: 'unknown-session' });
            return true;
          }
          sendJson(res, 200, { session });
          return true;
        }

        if (req.method === 'POST' && sub === 'ping') {
          const session = store.touch(id);
          if (!session) {
            sendJson(res, 404, { error: 'unknown-session' });
            return true;
          }
          sendJson(res, 200, { ok: true, sessionId: id, serverTime: new Date().toISOString() });
          return true;
        }

        if (req.method === 'POST' && sub === 'commands') {
          const body = await readJsonBody(req, resolved.maxBodyBytes);
          if (!body.ok) {
            sendJson(res, body.status, { error: body.error });
            return true;
          }
          const payload = body.value || {};
          const type = String(payload.type || 'exec');
          if (!COMMAND_TYPES.has(type)) {
            sendJson(res, 400, {
              error: 'unsupported-command-type',
              message: `Unsupported command type "${type}". Supported: ${[...COMMAND_TYPES].join(', ')}.`,
            });
            return true;
          }
          const code = typeof payload.code === 'string' ? payload.code : '';
          if (code.length > MAX_CODE_LENGTH) {
            sendJson(res, 413, { error: 'code-too-large', message: `Code is limited to ${MAX_CODE_LENGTH} characters.` });
            return true;
          }
          let command;
          try {
            command = store.enqueue(id, { type, code, timeoutMs: payload.timeoutMs });
          } catch (err) {
            if (err.code === 'unknown-session') {
              sendJson(res, 404, { error: 'unknown-session' });
              return true;
            }
            throw err;
          }
          log.info('command queued', { commandId: command.id, sessionId: id, type });
          sendJson(res, 202, {
            commandId: command.id,
            sessionId: id,
            status: command.status,
            createdAt: command.createdAt,
            timeoutAt: command.timeoutAt,
          });
          return true;
        }

        if (req.method === 'DELETE' && !sub) {
          const removed = store.remove(id);
          if (!removed) {
            sendJson(res, 404, { error: 'unknown-session' });
            return true;
          }
          log.info('studio session removed', { sessionId: id });
          sendJson(res, 200, { ok: true, sessionId: id });
          return true;
        }
      }

      return false;
    }

    if (resource === 'commands' && req.method === 'GET' && id && !sub) {
      const command = store.getCommand(id);
      if (!command) {
        sendJson(res, 404, { error: 'unknown-command' });
        return true;
      }
      sendJson(res, 200, { command });
      return true;
    }

    return false;
  }

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const { pathname, segments } = parseTarget(req);

    applyCors(req, res, resolved.corsAllowOrigin);

    res.on('finish', () => {
      log.debug('request', {
        method: req.method,
        path: pathname,
        status: res.statusCode,
        ms: Date.now() - started,
      });
    });

    try {
      if (handlePublic(req, res, pathname)) return;

      // Everything below this line is protected when --require-token is on.
      const providedToken = extractToken(req);
      const decision = authorize({
        expectedToken: resolved.token,
        providedToken,
        enforce: resolved.requireToken,
      });

      if (!decision.ok) {
        log.warn('rejected unauthorized request', {
          method: req.method,
          path: pathname,
          reason: decision.reason,
          remote: req.socket.remoteAddress,
        });
        sendJson(
          res,
          401,
          {
            error: 'unauthorized',
            reason: decision.reason,
            message: 'A valid bridge token is required. Send it as "Authorization: Bearer <token>" or "X-Bridge-Token: <token>".',
          },
          { 'www-authenticate': 'Bearer realm="roblox-bridge"' },
        );
        return;
      }

      const handled = await handleApi(req, res, segments);
      if (handled) return;

      sendJson(res, 404, { error: 'not-found', message: `No route for ${req.method} ${pathname}` });
    } catch (err) {
      log.error('unhandled error', { message: err && err.message, stack: err && err.stack });
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'internal-error', message: 'The bridge failed to handle this request.' });
      } else {
        res.end();
      }
    }
  });

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;

  return { server, config: resolved, store, logger: log };
}

/**
 * Start the bridge.
 *
 * @param {string[]} [argv]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{server: import('node:http').Server, config: object, close: () => Promise<void>}>}
 */
async function start(argv = process.argv.slice(2), env = process.env) {
  let loaded;
  try {
    loaded = loadConfig(argv, env);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`\n[${NAME}] Configuration error: ${err.message}\n\n`);
      process.exitCode = err.code || 2;
      throw err;
    }
    throw err;
  }

  const { config, warnings } = loaded;
  const { server, logger } = createServer({ config });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const shownHost = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;

  logger.info(`${NAME} v${VERSION} listening on http://${shownHost}:${port}`);
  logger.info(
    config.requireToken
      ? `token protection: ON (token from ${config.tokenSource}, ${redactToken(config.token)})`
      : 'token protection: OFF - every endpoint is reachable without a token',
  );
  for (const warning of warnings) {
    logger.warn(warning);
  }

  const close = () =>
    new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });

  return { server, config, close, logger };
}

if (require.main === module) {
  start()
    .then(({ close }) => {
      const shutdown = async (signal) => {
        process.stdout.write(`\n[${NAME}] received ${signal}, shutting down\n`);
        await close();
        process.exit(0);
      };
      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));
    })
    .catch((err) => {
      if (err instanceof ConfigError) {
        process.exit(err.code || 2);
      }
      process.stderr.write(`[${NAME}] fatal: ${err && err.stack ? err.stack : err}\n`);
      process.exit(1);
    });
}

module.exports = { createServer, start, NAME, VERSION, PROTOCOL_VERSION };
