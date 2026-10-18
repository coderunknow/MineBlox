#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const http = require('node:http');
const { parseArgs, readTokenFile } = require('../bridge/config');

const USAGE = `
Usage: rbb <command> [options]

Commands:
  server              Start the bridge HTTP server
  token               Generate a secure token for token-protection
  exec <code>         Send Luau code to Studio for execution
  ping                Ping the connected Studio session

Options for client commands (exec, ping):
  --url <url>         Bridge URL (default: http://127.0.0.1:8787)
  --token <token>     Bridge token
  --token-file <file> File containing the bridge token
  --session <id>      Target specific session ID (default: most recent)
`;

function randomToken() {
  return crypto.randomBytes(24).toString('base64url').replace(/=/g, '');
}

/**
 * @param {string} method
 * @param {string} url
 * @param {object} [body]
 * @param {string} [token]
 * @returns {Promise<object>}
 */
function request(method, url, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      method,
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      headers: {
        'Accept': 'application/json'
      }
    };
    if (token) {
      options.headers['Authorization'] = `Bearer ${token}`;
    }
    if (body) {
      options.headers['Content-Type'] = 'application/json';
    }

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ status: res.statusCode, data: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode, data: raw });
        }
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function getTargetSession(baseUrl, token, explicitSessionId) {
  const res = await request('GET', `${baseUrl}/api/sessions`, null, token);
  if (res.status !== 200) {
    throw new Error(`Failed to list sessions (HTTP ${res.status}): ${JSON.stringify(res.data)}`);
  }
  const sessions = res.data.sessions || [];
  if (sessions.length === 0) {
    throw new Error('No Studio sessions connected to the bridge.');
  }
  if (explicitSessionId) {
    const found = sessions.find(s => s.id === explicitSessionId);
    if (!found) throw new Error(`Session "${explicitSessionId}" not found.`);
    return found;
  }
  
  // Return the most recently active session
  sessions.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  return sessions[0];
}

async function runClientCommand(argv, commandName) {
  const args = parseArgs(argv);
  
  let baseUrl = args.url || process.env.ROBLOX_BRIDGE_URL || 'http://127.0.0.1:8787';
  baseUrl = String(baseUrl).replace(/\/+$/, '');
  
  let token = args.token || process.env.ROBLOX_BRIDGE_TOKEN;
  if (!token && args['token-file']) {
    token = readTokenFile(String(args['token-file']));
  } else if (!token && process.env.ROBLOX_BRIDGE_TOKEN_FILE) {
    token = readTokenFile(process.env.ROBLOX_BRIDGE_TOKEN_FILE);
  }

  const session = await getTargetSession(baseUrl, token, args.session);
  const sessionId = session.id;

  let code = '';
  if (commandName === 'exec') {
    code = argv[1];
    if (!code) {
      if (args.file) {
        code = fs.readFileSync(String(args.file), 'utf8');
      } else {
        throw new Error('exec requires inline code or --file <path>');
      }
    }
  }

  const enqRes = await request('POST', `${baseUrl}/api/sessions/${sessionId}/commands`, {
    type: commandName,
    code: code
  }, token);

  if (enqRes.status !== 202) {
    throw new Error(`Failed to queue command (HTTP ${enqRes.status}): ${JSON.stringify(enqRes.data)}`);
  }

  const commandId = enqRes.data.commandId;
  
  // Poll for completion
  let attempts = 0;
  while (true) {
    await new Promise(r => setTimeout(r, 500));
    attempts++;
    const statusRes = await request('GET', `${baseUrl}/api/commands/${commandId}`, null, token);
    if (statusRes.status === 200) {
      const cmd = statusRes.data.command;
      if (cmd.status === 'completed' || cmd.status === 'failed' || cmd.status === 'timeout') {
        const res = cmd.result || {};
        if (res.output) {
          process.stdout.write(res.output);
          if (!res.output.endsWith('\\n')) process.stdout.write('\\n');
        }
        if (res.error) {
          process.stderr.write(res.error + '\\n');
        }
        
        if (!res.ok) {
          process.exit(1);
        }
        return;
      }
    } else if (statusRes.status !== 404) {
      throw new Error(`Failed to poll command status: ${JSON.stringify(statusRes.data)}`);
    }
    
    if (attempts > 120) {
      throw new Error('Client timed out waiting for result.');
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(USAGE);
    process.exit(0);
  }

  if (cmd === 'token') {
    console.log(randomToken());
    process.exit(0);
  }

  if (cmd === 'server') {
    const { start } = require('../bridge/server');
    await start(argv.slice(1));
    return;
  }

  if (cmd === 'exec' || cmd === 'ping') {
    try {
      await runClientCommand(argv, cmd);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  console.error(USAGE);
  process.exit(1);
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
