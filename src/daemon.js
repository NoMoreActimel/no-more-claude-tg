#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { Bridge } from './bridge.js';
import { Caffeinate } from './caffeinate.js';
import { CONFIG_FILE, HOME_DIR, INBOX_DIR, LOG_FILE, OUTBOX_DIR, SOCKET_PATH, STATE_FILE } from './paths.js';
import { DEFAULT_CONFIG, DEFAULT_STATE, ensurePrivateDir, readJson, writeJsonAtomic } from './store.js';
import { Telegram } from './telegram.js';
import { Tunnel } from './tunnel.js';
import { makeTranscriber, voiceSupport } from './voice.js';

process.umask(0o077);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const INBOX_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

ensurePrivateDir(HOME_DIR);
for (const dir of [INBOX_DIR, OUTBOX_DIR]) ensurePrivateDir(dir);

try {
  if (fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) fs.truncateSync(LOG_FILE);
} catch {}

// Message contents are never logged — only what happened.
function log(line) {
  const entry = `${new Date().toISOString()} ${line}\n`;
  try {
    fs.appendFileSync(LOG_FILE, entry, { mode: 0o600 });
  } catch {}
}

function socketAnswers() {
  return new Promise((resolve) => {
    const c = net.connect(SOCKET_PATH);
    c.once('connect', () => (c.destroy(), resolve(true)));
    c.once('error', () => resolve(false));
  });
}

function pruneOldFiles(root, olderThanMs) {
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      pruneOldFiles(p, olderThanMs);
      try {
        fs.rmdirSync(p); // only succeeds when empty
      } catch {}
    } else if (Date.now() - fs.statSync(p).mtimeMs > olderThanMs) {
      fs.rmSync(p, { force: true });
    }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) {
        reject(new Error('request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// The daemon only ever uploads files the CLI staged in the private outbox.
function stagedFile(p) {
  const real = fs.realpathSync(String(p || ''));
  if (!real.startsWith(fs.realpathSync(OUTBOX_DIR) + path.sep)) throw new Error('file is not staged in the outbox');
  return real;
}

async function main() {
  if (await socketAnswers()) {
    console.error('claude-tg daemon is already running');
    process.exit(0);
  }
  fs.rmSync(SOCKET_PATH, { force: true });

  const config = { ...DEFAULT_CONFIG, ...readJson(CONFIG_FILE, {}) };
  const state = { ...DEFAULT_STATE, ...readJson(STATE_FILE, {}) };
  if (!config.token) {
    log('no bot token in config.json — run: tg set-token');
    console.error('no bot token configured — run: tg set-token');
    process.exit(0);
  }
  fs.chmodSync(CONFIG_FILE, 0o600);

  const tg = new Telegram({ token: config.token, apiBase: config.apiBase });
  const caffeinate = new Caffeinate({ log });
  const tunnel = new Tunnel({ log });
  const bridge = new Bridge({
    tg,
    config,
    state,
    log,
    inboxDir: INBOX_DIR,
    saveConfig: () => writeJsonAtomic(CONFIG_FILE, config),
    saveState: () => writeJsonAtomic(STATE_FILE, state),
    transcribe: makeTranscriber(),
    onLiveCountChange: (n) => caffeinate.set(n > 0),
  });

  let running = true;

  const routes = {
    'GET /status': async () => {
      await bridge.topicsEnabled(); // cached; makes sure bot name and thread mode are known right after start
      return { ...bridge.status(), pid: process.pid, caffeinate: caffeinate.on, voice: voiceSupport().ready, links: Boolean(config.tunnel?.enabled) };
    },
    'GET /session': async (_b, q) => bridge.sessionState(q.get('sessionId')),
    'POST /pair': async (b) => {
      const { code, expiresAt } = bridge.startPairing({ reset: Boolean(b.reset) });
      await bridge.topicsEnabled(true);
      return { code, expiresAt, link: bridge.botUsername ? `https://t.me/${bridge.botUsername}?start=${code}` : null, expectedUsername: config.expectedUsername };
    },
    'POST /register': (b) => bridge.register(b),
    'GET /project-emojis': async () => ({ projects: state.projectEmojis }),
    'POST /project-emoji': (b) => bridge.setProjectEmoji(b.project, b.emoji),
    'POST /unregister': async (b) => ({ ended: await bridge.end(b.sessionId, b.reason || 'disconnected at the terminal') }),
    'POST /send': (b) => bridge.sendText(b.sessionId, b.text),
    'POST /ack': (b) => bridge.ack(b.sessionId, b.upTo),
    'POST /send-file': async (b) => {
      const file = stagedFile(b.path);
      try {
        return await bridge.sendFile(b.sessionId, file, { caption: b.caption, kind: b.kind, filename: b.filename });
      } finally {
        fs.rm(path.dirname(file), { recursive: true, force: true }, () => {});
      }
    },
    'POST /publish': async (b) => {
      if (!config.tunnel?.enabled) throw new Error('secret links are disabled (tunnel.enabled=false in config.json)');
      const file = stagedFile(b.path);
      try {
        const { url, expiresAt } = await tunnel.publish(file);
        await bridge.sendText(b.sessionId, `🔗 ${url}\nexpires ${new Date(expiresAt).toLocaleString()}`);
        return { url, expiresAt };
      } finally {
        fs.rm(path.dirname(file), { recursive: true, force: true }, () => {});
      }
    },
    'POST /stop': async () => {
      setTimeout(() => shutdown('stop requested'), 50);
      return { stopping: true };
    },
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://daemon');
    const key = `${req.method} ${url.pathname}`;
    const send = (code, body) => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      if (key === 'GET /listen') {
        const { promise, cancel } = bridge.listen(url.searchParams.get('sessionId'));
        res.on('close', cancel);
        return send(200, await promise);
      }
      const route = routes[key];
      if (!route) return send(404, { error: `unknown route ${key}` });
      const body = req.method === 'POST' ? await readBody(req) : {};
      send(200, (await route(body, url.searchParams)) ?? {});
    } catch (e) {
      log(`api ${key} failed: ${tg.redact(e.message)}`);
      send(400, { error: tg.redact(e.message) });
    }
  });
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 0;
  await new Promise((resolve, reject) => server.once('error', reject).listen(SOCKET_PATH, resolve));
  fs.chmodSync(SOCKET_PATH, 0o600);

  function shutdown(why) {
    if (!running) return;
    running = false;
    log(`shutting down: ${why}`);
    bridge.shutdown();
    caffeinate.set(false);
    tunnel.shutdown();
    server.close();
    fs.rmSync(SOCKET_PATH, { force: true });
    setTimeout(() => process.exit(0), 150);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (e) => log(`uncaught: ${tg.redact(e.stack || e.message)}`));
  process.on('unhandledRejection', (e) => log(`unhandled: ${tg.redact(e?.stack || e)}`));

  log(`daemon up, pid ${process.pid}, ${config.ownerId ? 'paired' : 'NOT paired'}, voice ${voiceSupport().ready ? 'ready' : 'unavailable'}`);

  try {
    await tg.call('deleteWebhook', {});
    await bridge.topicsEnabled(true);
    await tg.call('setMyCommands', {
      commands: [
        { command: 'sessions', description: 'Connected Claude sessions' },
        { command: 'ping', description: 'Is this session alive?' },
        { command: 'end', description: 'Disconnect this session' },
        { command: 'status', description: 'Bridge health' },
        { command: 'clean', description: 'Delete threads of ended sessions' },
        { command: 'help', description: 'How this works' },
      ],
    });
  } catch (e) {
    log(`startup calls failed: ${e.message}`);
  }

  await bridge.sweep();
  caffeinate.set(bridge.liveSessions().length > 0);

  const sweeper = setInterval(() => {
    bridge.sweep().catch((e) => log(`sweep failed: ${e.message}`));
    tunnel.sweep();
  }, 20000);
  sweeper.unref();
  const janitor = setInterval(() => pruneOldFiles(INBOX_DIR, INBOX_KEEP_MS), 60 * 60 * 1000);
  janitor.unref();
  pruneOldFiles(INBOX_DIR, INBOX_KEEP_MS);
  pruneOldFiles(OUTBOX_DIR, 60 * 60 * 1000);

  let backoff = 1000;
  while (running) {
    try {
      const updates = await tg.call('getUpdates', { offset: state.offset, timeout: 50, allowed_updates: ['message', 'callback_query', 'my_chat_member'] }, { timeoutMs: 65000 });
      for (const u of updates) {
        state.offset = u.update_id + 1;
        await bridge.handleUpdate(u);
        writeJsonAtomic(STATE_FILE, state);
      }
      backoff = 1000;
    } catch (e) {
      if (!running) break;
      if (e.code === 401) {
        log('Telegram rejected the bot token (401). Fix it with: tg set-token');
        return shutdown('invalid token');
      }
      log(e.code === 409 ? 'another process is polling this bot token (409) — only one bridge can run per bot' : `poll failed: ${e.message}`);
      await sleep(e.code === 409 ? 30000 : backoff);
      backoff = Math.min(backoff * 2, 30000);
    }
  }
}

main().catch((e) => {
  log(`fatal: ${e.stack || e.message}`);
  console.error(e.message);
  process.exit(1);
});
