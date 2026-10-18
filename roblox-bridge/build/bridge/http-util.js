'use strict';

const { URL } = require('node:url');

/**
 * Small helpers shared by the HTTP layer.
 */

/**
 * Send a JSON response.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 * @param {Record<string,string>} [headers]
 */
function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

/**
 * Send a plain-text response.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} body
 * @param {Record<string,string>} [headers]
 */
function sendText(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

/**
 * Read and parse a JSON request body.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<{ok: true, value: any} | {ok: false, error: string, status: number}>}
 */
function readJsonBody(req, maxBytes = 1_048_576) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        finish({ ok: false, error: 'Request body too large', status: 413 });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('error', () => {
      finish({ ok: false, error: 'Could not read request body', status: 400 });
    });

    req.on('end', () => {
      if (settled) return;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        finish({ ok: true, value: {} });
        return;
      }
      try {
        finish({ ok: true, value: JSON.parse(raw) });
      } catch (err) {
        finish({ ok: false, error: `Invalid JSON body: ${err.message}`, status: 400 });
      }
    });
  });
}

/**
 * Parse the request URL into path segments.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {{pathname: string, segments: string[], query: URLSearchParams}}
 */
function parseTarget(req) {
  const url = new URL(req.url || '/', 'http://bridge.invalid');
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const segments = pathname.split('/').filter((segment) => segment.length > 0);
  return { pathname, segments, query: url.searchParams };
}

/**
 * Apply CORS headers when the operator explicitly opted in.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string[]|null} allowOrigin
 */
function applyCors(req, res, allowOrigin) {
  if (!allowOrigin || allowOrigin.length === 0) return;
  const origin = req.headers.origin;
  if (allowOrigin.includes('*')) {
    res.setHeader('access-control-allow-origin', '*');
  } else if (origin && allowOrigin.includes(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
  }
  res.setHeader('access-control-allow-headers', 'authorization, content-type, x-bridge-token');
  res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('access-control-max-age', '600');
}

module.exports = { sendJson, sendText, readJsonBody, parseTarget, applyCors };
