import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { DAEMON_ENTRY, HOME_DIR, LOG_FILE, SERVICE_LABEL, SERVICE_PLIST, SOCKET_PATH, TOOL_PATH } from './paths.js';
import { ensurePrivateDir } from './store.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Talk to the local daemon over its owner-only unix socket. Shared by the CLI and the hook handlers. */
export function api(method, route, body, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {};
    let req;
    try {
      req = http.request({ socketPath: SOCKET_PATH, path: route, method, headers, agent: false }, onResponse);
    } catch (e) {
      return reject(e);
    }
    function onResponse(res) {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json;
        try {
          json = JSON.parse(data || '{}');
        } catch {
          return reject(new Error('unreadable reply from the daemon'));
        }
        if (res.statusCode >= 400) reject(Object.assign(new Error(json.error || `daemon error ${res.statusCode}`), { fromDaemon: true }));
        else resolve(json);
      });
    }
    if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error('daemon did not answer in time')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export async function daemonUp() {
  try {
    await api('GET', '/status', null, { timeoutMs: 1500 });
    return true;
  } catch {
    return false;
  }
}

export function spawnDaemon() {
  ensurePrivateDir(HOME_DIR);
  const child = spawn(process.execPath, [DAEMON_ENTRY], { detached: true, stdio: 'ignore', cwd: os.homedir(), env: { ...process.env, PATH: `${TOOL_PATH}:${process.env.PATH || ''}` } });
  child.unref();
}

export async function waitUp(ms) {
  for (let waited = 0; waited < ms; waited += 250) {
    if (await daemonUp()) return true;
    await sleep(250);
  }
  return false;
}

export function logTail(n = 6) {
  try {
    return fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-n).join('\n');
  } catch {
    return '(no log yet)';
  }
}

/** @returns true when it had to start the daemon */
export async function ensureDaemon() {
  if (await daemonUp()) return false;
  if (process.platform === 'darwin' && fs.existsSync(SERVICE_PLIST)) {
    try {
      execFileSync('launchctl', ['kickstart', `gui/${process.getuid()}/${SERVICE_LABEL}`], { stdio: 'ignore' });
    } catch {}
    if (await waitUp(3000)) return true;
  }
  spawnDaemon();
  if (await waitUp(8000)) return true;
  throw new Error(`the bridge daemon did not start. Last log lines:\n${logTail()}`);
}
