'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer } = require('../bridge/server');

/**
 * @param {import('node:http').Server} server 
 * @param {string} method 
 * @param {string} path 
 * @param {object} [body] 
 * @param {Record<string,string>} [headers] 
 * @returns {Promise<{status: number, body: any}>}
 */
function request(server, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const req = http.request({
      method,
      hostname: '127.0.0.1',
      port,
      path,
      headers: { ...headers }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode, body: raw });
        }
      });
    });
    req.on('error', reject);
    if (body) {
      req.setHeader('content-type', 'application/json');
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

test('bridge: api e2e flow', async (t) => {
  const { server } = createServer({ 
    config: { 
      port: 0, 
      host: '127.0.0.1', 
      requireToken: false, 
      logLevel: 'silent',
      sessionTtlMs: 5000,
      commandTimeoutMs: 5000,
      maxSessions: 10
    } 
  });
  
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  t.after(() => {
    server.close();
    server.closeAllConnections?.();
  });

  // 1. Check health
  const health = await request(server, 'GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);

  // 2. Register a session
  const reg = await request(server, 'POST', '/api/plugin/register', { name: 'Test Studio' });
  assert.equal(reg.status, 201);
  const sessionId = reg.body.sessionId;
  assert.ok(sessionId);

  // 3. Check sessions
  const sessions = await request(server, 'GET', '/api/sessions');
  assert.equal(sessions.status, 200);
  assert.equal(sessions.body.sessions.length, 1);
  assert.equal(sessions.body.sessions[0].id, sessionId);

  // 4. Poll (no commands yet)
  const poll1 = await request(server, 'POST', '/api/plugin/poll', { sessionId });
  assert.equal(poll1.status, 200);
  assert.deepEqual(poll1.body.commands, []);

  // 5. Enqueue a command
  const cmd = await request(server, 'POST', `/api/sessions/${sessionId}/commands`, { code: 'print("hello")' });
  assert.equal(cmd.status, 202);
  const commandId = cmd.body.commandId;
  assert.ok(commandId);

  // 6. Poll again (should return the command)
  const poll2 = await request(server, 'POST', '/api/plugin/poll', { sessionId });
  assert.equal(poll2.status, 200);
  assert.equal(poll2.body.commands.length, 1);
  assert.equal(poll2.body.commands[0].id, commandId);
  assert.equal(poll2.body.commands[0].code, 'print("hello")');

  // 7. Complete the command
  const res = await request(server, 'POST', '/api/plugin/result', {
    commandId,
    sessionId,
    ok: true,
    output: 'hello',
    durationMs: 12
  });
  assert.equal(res.status, 200);

  // 8. Check command status
  const getCmd = await request(server, 'GET', `/api/commands/${commandId}`);
  assert.equal(getCmd.status, 200);
  assert.equal(getCmd.body.command.status, 'completed');
  assert.equal(getCmd.body.command.result.output, 'hello');

  // 9. Delete session
  const del = await request(server, 'DELETE', `/api/sessions/${sessionId}`);
  assert.equal(del.status, 200);

  const poll3 = await request(server, 'POST', '/api/plugin/poll', { sessionId });
  assert.equal(poll3.status, 404);
});
