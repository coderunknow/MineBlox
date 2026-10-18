'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractToken, safeEqual, authorize, redactToken } = require('../bridge/auth');

test('auth: extractToken', (t) => {
  assert.equal(extractToken({ headers: {} }), null);
  assert.equal(extractToken({ headers: { authorization: 'Bearer secret-123' } }), 'secret-123');
  assert.equal(extractToken({ headers: { authorization: 'bearer    secret-456  ' } }), 'secret-456');
  assert.equal(extractToken({ headers: { 'x-bridge-token': 'secret-789' } }), 'secret-789');
  
  // X-Bridge-Token beats Authorization if both exist (though order doesn't matter too much in practice, but per spec Auth is first? Wait, looking at auth.js, Auth is first.)
  assert.equal(extractToken({ headers: { authorization: 'Bearer 1', 'x-bridge-token': '2' } }), '1');

  // fallback to query
  assert.equal(extractToken({ headers: {}, url: '/api?token=secret-query' }), 'secret-query');
  assert.equal(extractToken({ headers: {}, url: '/api?other=1' }), null);
});

test('auth: safeEqual', (t) => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'def'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', ''), true);
  assert.equal(safeEqual(null, 'abc'), false);
  assert.equal(safeEqual('abc', undefined), false);
});

test('auth: authorize', (t) => {
  // Not enforced
  assert.deepEqual(authorize({ enforce: false }), { ok: true, reason: 'auth-not-enforced' });

  // Enforced but missing token in config
  assert.deepEqual(authorize({ enforce: true, expectedToken: null }), { ok: false, reason: 'server-has-no-token' });

  // Enforced but missing in request
  assert.deepEqual(authorize({ enforce: true, expectedToken: 'foo', providedToken: null }), { ok: false, reason: 'missing-token' });

  // Enforced and wrong
  assert.deepEqual(authorize({ enforce: true, expectedToken: 'foo', providedToken: 'bar' }), { ok: false, reason: 'invalid-token' });

  // Enforced and correct
  assert.deepEqual(authorize({ enforce: true, expectedToken: 'foo', providedToken: 'foo' }), { ok: true, reason: 'ok' });
});

test('auth: redactToken', (t) => {
  assert.equal(redactToken(null), '(none)');
  assert.equal(redactToken(''), '(none)');
  assert.equal(redactToken('12345'), '*****');
  assert.equal(redactToken('12345678'), '********');
  assert.equal(redactToken('123456789'), '1234...89 (len=9)');
});
