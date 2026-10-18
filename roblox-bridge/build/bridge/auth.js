'use strict';

const crypto = require('node:crypto');

/**
 * Token extraction and constant-time comparison for the bridge API.
 *
 * The bridge accepts the shared secret in three places, in this order:
 *   1. `Authorization: Bearer <token>`
 *   2. `X-Bridge-Token: <token>`
 *   3. `?token=<token>` (query string - convenient for curl, discouraged because
 *      URLs leak into proxy/access logs)
 */

const BEARER_RE = /^Bearer\s+(.*)$/i;

/**
 * Pull a candidate token out of an incoming request.
 * @param {import('node:http').IncomingMessage} req
 * @returns {string|null}
 */
function extractToken(req) {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string') {
    const match = BEARER_RE.exec(auth.trim());
    if (match) {
      const value = match[1].trim();
      if (value) return value;
    }
  }

  const header = req.headers['x-bridge-token'];
  if (typeof header === 'string') {
    const value = header.trim();
    if (value) return value;
  }

  try {
    const url = new URL(req.url || '/', 'http://bridge.invalid');
    const value = url.searchParams.get('token');
    if (value) return value;
  } catch {
    // Malformed request target: ignore the query-string fallback.
  }

  return null;
}

/**
 * Constant-time string comparison.
 *
 * Both values are hashed first so that `timingSafeEqual` never throws on a
 * length mismatch (which itself would leak the expected length).
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Decide whether a request is allowed to reach a protected endpoint.
 *
 * @param {object} options
 * @param {string|null} options.expectedToken The configured shared secret (null when none is configured).
 * @param {string|null} options.providedToken  The token extracted from the request.
 * @param {boolean} options.enforce           Whether the token is actually required.
 * @returns {{ok: boolean, reason: string}}
 */
function authorize({ expectedToken, providedToken, enforce }) {
  if (!enforce) {
    return { ok: true, reason: 'auth-not-enforced' };
  }
  if (!expectedToken) {
    // This is a misconfiguration, not a client error. The server refuses to
    // start in this state, but stay defensive in case it is ever reached.
    return { ok: false, reason: 'server-has-no-token' };
  }
  if (!providedToken) {
    return { ok: false, reason: 'missing-token' };
  }
  if (!safeEqual(expectedToken, providedToken)) {
    return { ok: false, reason: 'invalid-token' };
  }
  return { ok: true, reason: 'ok' };
}

/**
 * Mask a token for logs: keeps a short prefix so operators can tell two
 * tokens apart without exposing the secret.
 *
 * @param {string|null} token
 * @returns {string}
 */
function redactToken(token) {
  if (!token) return '(none)';
  if (token.length <= 8) return '*'.repeat(token.length);
  return `${token.slice(0, 4)}...${token.slice(-2)} (len=${token.length})`;
}

module.exports = { extractToken, safeEqual, authorize, redactToken };
