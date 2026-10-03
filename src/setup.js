import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { CONFIG_FILE, HOME_DIR, MODELS_DIR, REPO_DIR, SERVICE_LABEL, SERVICE_PLIST, SOCKET_PATH } from './paths.js';
import { DEFAULT_CONFIG, ensurePrivateDir, readJson, writeJsonAtomic } from './store.js';
// (writeJsonAtomic is for files under ~/.config/claude-tg only — it makes the parent private)
import { Telegram } from './telegram.js';
import { MODEL_PATH, MODEL_SHA256, MODEL_URL, voiceSupport, which } from './voice.js';

// Claude Code keeps its settings, skills and the trusted-folder list under this directory.
export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
export const SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');
export const CLAUDE_JSON = process.env.CLAUDE_CONFIG_DIR ? path.join(CLAUDE_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json');
export const SKILL_DIR = path.join(CLAUDE_DIR, 'skills', 'tg');
// Overridable so tests (and odd setups) never touch the real ~/.local/bin.
export const BIN_LINK = process.env.CLAUDE_TG_LINK || path.join(os.homedir(), '.local', 'bin', 'tg');
export const TG_BIN = path.join(REPO_DIR, 'bin', 'tg');

const q = (s) => `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`;

// For files in directories this tool does not own (~/.claude): atomic, but never chmod the parent.
function writeJsonInPlace(file, data, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let keep = mode;
  try {
    keep = fs.statSync(file).mode & 0o777 & mode; // the stricter of what is there and what we ask: never relax, may tighten
  } catch {}
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: keep });
  fs.chmodSync(tmp, keep); // umask may have narrowed it
  fs.renameSync(tmp, file);
}

/** The binary a hook command runs, as written (with $HOME and ~ expanded) and resolved through symlinks; `real` is null when it points at nothing. */
function hookBinary(command) {
  const m = String(command).match(/^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/);
  const written = (m?.[1] ?? m?.[2] ?? m?.[3] ?? '').replace(/^\$HOME(?=\/)/, os.homedir()).replace(/^~(?=\/)/, os.homedir());
  let real = null;
  try {
    real = fs.realpathSync(written);
  } catch {}
  return { written, real };
}

const current = (hook) => hookBinary(hook.command).real === fs.realpathSync(TG_BIN);

/** The hooks that make a connected session reachable from the phone. Each is found again by its marker. */
export const HOOKS = {
  Stop: { marker: /\btg["']?\s+hook-stop\b/, group: () => ({ hooks: [{ type: 'command', command: `${q(TG_BIN)} hook-stop 2>/dev/null || true`, timeout: 5 }] }) },
  PermissionRequest: { marker: /\btg["']?\s+hook-permission\b/, group: () => ({ hooks: [{ type: 'command', command: `${q(TG_BIN)} hook-permission 2>/dev/null || true`, timeout: 600 }] }) },
  Notification: {
    marker: /\btg["']?\s+hook-notify\b/,
    group: () => ({ matcher: 'permission_prompt|idle_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input', hooks: [{ type: 'command', command: `${q(TG_BIN)} hook-notify 2>/dev/null || true`, timeout: 10, async: true }] }),
  },
};

const isOurs = (hook, marker) => typeof hook?.command === 'string' && marker.test(hook.command);

/** Per event: 'ok' (ours, pointing at this install), 'stale' (ours, pointing elsewhere or at nothing), 'missing'. */
export function hookState(settingsFile = SETTINGS_FILE) {
  const settings = readJson(settingsFile, {});
  const state = {};
  for (const [event, { marker }] of Object.entries(HOOKS)) {
    const ours = (settings.hooks?.[event] || []).flatMap((g) => (g.hooks || []).filter((h) => isOurs(h, marker)));
    state[event] = !ours.length ? 'missing' : ours.every(current) ? 'ok' : { stale: ours.filter((h) => !current(h)).map((h) => hookBinary(h.command).written) };
  }
  return state;
}

export function hooksInstalled(settingsFile = SETTINGS_FILE) {
  return Object.fromEntries(Object.entries(hookState(settingsFile)).map(([e, st]) => [e, st === 'ok']));
}

/**
 * Merge our hooks into settings.json, leaving everything else untouched. Idempotent; a hook of ours that
 * points at another (moved, deleted) install is rewritten to this one. Backs the file up once per change.
 */
export function installHooks(settingsFile = SETTINGS_FILE) {
  const settings = readJson(settingsFile, {});
  const state = hookState(settingsFile);
  const added = Object.keys(HOOKS).filter((e) => state[e] === 'missing');
  const rewritten = Object.keys(HOOKS).filter((e) => state[e] !== 'missing' && state[e] !== 'ok');
  if (!added.length && !rewritten.length) return { added, rewritten, backup: null };
  const backup = fs.existsSync(settingsFile) ? `${settingsFile}.bak-${new Date().toISOString().slice(0, 10)}` : null;
  if (backup) fs.copyFileSync(settingsFile, backup);
  settings.hooks = settings.hooks || {};
  for (const event of rewritten) {
    const fresh = HOOKS[event].group().hooks[0];
    for (const g of settings.hooks[event] || []) {
      g.hooks = (g.hooks || []).map((h) => (isOurs(h, HOOKS[event].marker) && !current(h) ? { ...h, ...fresh } : h));
    }
  }
  for (const event of added) {
    settings.hooks[event] = settings.hooks[event] || [];
    settings.hooks[event].push(HOOKS[event].group());
  }
  writeJsonInPlace(settingsFile, settings);
  return { added, rewritten, backup };
}

export function uninstallHooks(settingsFile = SETTINGS_FILE) {
  const settings = readJson(settingsFile, {});
  if (!settings.hooks) return { removed: [] };
  const removed = [];
  for (const [event, { marker }] of Object.entries(HOOKS)) {
    const groups = settings.hooks[event] || [];
    const kept = groups.map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h, marker)) })).filter((g) => g.hooks.length);
    if (kept.length !== groups.length || kept.some((g, i) => g.hooks.length !== (groups[i]?.hooks || []).length)) removed.push(event);
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  writeJsonInPlace(settingsFile, settings);
  return { removed };
}

export function installSkill(dir = SKILL_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(REPO_DIR, 'skill', 'tg', 'SKILL.md'), path.join(dir, 'SKILL.md'));
  return path.join(dir, 'SKILL.md');
}

export function skillUpToDate(dir = SKILL_DIR) {
  try {
    return fs.readFileSync(path.join(dir, 'SKILL.md')).equals(fs.readFileSync(path.join(REPO_DIR, 'skill', 'tg', 'SKILL.md')));
  } catch {
    return false;
  }
}

export function linkCli(link = BIN_LINK, { force = false } = {}) {
  fs.mkdirSync(path.dirname(link), { recursive: true });
  let existing = null;
  try {
    existing = fs.lstatSync(link);
  } catch {}
  if (existing) {
    const target = existing.isSymbolicLink() ? fs.readlinkSync(link) : null;
    if (target === TG_BIN) return { link, onPath: onPath(path.dirname(link)) };
    // `tg` is a common name (telegram-cli, the tg TUI). Only replace what we recognise as ours.
    const ours = target && /[\\/]bin[\\/]tg$/.test(target) && fs.existsSync(path.join(path.dirname(target), '..', 'src', 'cli.js'));
    if (!ours && !force) throw new Error(`${link} already exists and is not this tool${target ? ` (→ ${target})` : ''}; remove it or run with --force`);
    fs.rmSync(link, { force: true });
  }
  fs.symlinkSync(TG_BIN, link);
  return { link, onPath: onPath(path.dirname(link)) };
}

export const onPath = (dir) => (process.env.PATH || '').split(':').includes(dir);

// ------------------------------------------------------------------ prompts

export function askLine(question, { hidden = false, fallback = '' } = {}) {
  if (!process.stdin.isTTY) {
    return new Promise((resolve) => {
      let data = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => (data += c));
      process.stdin.on('end', () => resolve((data.split('\n')[0] || fallback).trim()));
    });
  }
  if (!hidden) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => rl.question(question, (a) => (rl.close(), resolve((a || fallback).trim()))));
  }
  // Hidden input (the bot token): echo nothing, so it stays out of the scrollback and screen recordings.
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    // A pasted token arrives as one chunk ending in \r, so walk the characters rather than compare the chunk.
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(value.trim());
        }
        if (ch === '\u0003') {
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

export async function confirm(question, { fallback = true } = {}) {
  if (!process.stdin.isTTY) return fallback;
  const a = (await askLine(`${question} ${fallback ? '[Y/n]' : '[y/N]'} `)).toLowerCase();
  return a ? a.startsWith('y') : fallback;
}

// ------------------------------------------------------------------ steps

export async function validateToken(token, apiBase) {
  if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) throw new Error('that does not look like a bot token (expected 123456:ABC…, from @BotFather)');
  try {
    return await new Telegram({ token, apiBase }).call('getMe', {}, { timeoutMs: 15000 });
  } catch (e) {
    if (e.code === 'NETWORK') throw new Error(`cannot reach ${apiBase || 'api.telegram.org'} — check the internet connection (or a VPN/firewall), then try again`);
    if (e.code === 401 || e.code === 404) throw new Error('Telegram rejected that token — copy it again from @BotFather (or /revoke for a fresh one)');
    throw e;
  }
}

export function saveConfig(patch) {
  ensurePrivateDir(HOME_DIR);
  const config = { ...DEFAULT_CONFIG, ...readJson(CONFIG_FILE, {}), ...patch };
  writeJsonAtomic(CONFIG_FILE, config);
  return config;
}

/** Local Whisper: Homebrew packages plus the multilingual model. Streams the installer output to the terminal. */
export function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(8 * 1024 * 1024);
  try {
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0; ) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

export function installLocalVoice(out) {
  const brew = which('brew');
  if (!which('ffmpeg') || !which('whisper-cli')) {
    if (!brew) throw new Error('Homebrew is not installed. Install it from https://brew.sh, then run: tg setup voice');
    out('installing ffmpeg and whisper-cpp with Homebrew…');
    const r = spawnSync(brew, ['install', 'ffmpeg', 'whisper-cpp'], { stdio: 'inherit', env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ENV_HINTS: '1' } });
    if (!which('ffmpeg') || !which('whisper-cli')) throw new Error(`brew install failed (exit ${r.status}); fix that, then run: tg setup voice`);
  }
  if (!fs.existsSync(MODEL_PATH)) {
    fs.mkdirSync(MODELS_DIR, { recursive: true });
    out(`downloading the speech model (1.6 GB, one time) to ${MODELS_DIR}…`);
    const part = `${MODEL_PATH}.part`;
    const r = spawnSync(which('curl') || '/usr/bin/curl', ['-L', '--fail', '--retry', '3', '-C', '-', '--progress-bar', '-o', part, MODEL_URL], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('model download failed; run `tg setup voice` again to resume');
    out('checking the download…');
    const got = sha256File(part);
    if (got !== MODEL_SHA256) {
      fs.rmSync(part, { force: true });
      throw new Error(`model checksum mismatch (got ${got.slice(0, 12)}…, expected ${MODEL_SHA256.slice(0, 12)}…); the file was deleted. Run \`tg setup voice\` again`);
    }
    fs.renameSync(part, MODEL_PATH);
  }
  return voiceSupport({}).local;
}

export function serviceInstalled() {
  return fs.existsSync(SERVICE_PLIST);
}

export function serviceLoaded() {
  if (process.platform !== 'darwin') return false;
  try {
    execFileSync('launchctl', ['print', `gui/${process.getuid()}/${SERVICE_LABEL}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Folder trust for `tg spawn`. Claude Code records accepted trust dialogs in ~/.claude.json; there is no
 * documented way to pre-accept one, so this writes the same field the dialog would. Internal format —
 * verified on Claude Code 2.1.x, may change.
 */
const physical = (dir) => {
  try {
    return fs.realpathSync(dir); // Claude Code keys the list by the physical cwd
  } catch {
    return dir;
  }
};

export function folderTrusted(dir) {
  return Boolean(readJson(CLAUDE_JSON, {}).projects?.[physical(dir)]?.hasTrustDialogAccepted);
}

export function trustFolder(dir) {
  // Claude Code writes this file often; read right before writing to keep the lost-update window tiny.
  const key = physical(dir);
  const data = readJson(CLAUDE_JSON, {});
  data.projects = data.projects || {};
  data.projects[key] = { ...(data.projects[key] || {}), hasTrustDialogAccepted: true };
  writeJsonInPlace(CLAUDE_JSON, data, 0o600);
}

// ------------------------------------------------------------------ doctor

export async function doctor({ daemonStatus = null, config = null } = {}) {
  const lines = [];
  const ok = (s) => lines.push(`✅ ${s}`);
  const warn = (s, fix) => lines.push(`⚠️  ${s}${fix ? `\n     → ${fix}` : ''}`);
  const bad = (s, fix) => lines.push(`❌ ${s}${fix ? `\n     → ${fix}` : ''}`);

  const major = Number(process.versions.node.split('.')[0]);
  major >= 22 ? ok(`node ${process.versions.node}`) : bad(`node ${process.versions.node} is too old`, 'install Node 22 or newer');

  const cfg = config || readJson(CONFIG_FILE, null);
  if (!cfg?.token) bad('no bot token configured', 'run: tg setup');
  else {
    try {
      const me = await validateToken(cfg.token, cfg.apiBase);
      ok(`bot token valid — @${me.username}${me.has_topics_enabled ? ', thread mode on' : ', thread mode off (single chat)'}`);
    } catch (e) {
      bad(`bot token rejected: ${e.message}`, 'get a new one from @BotFather, then: pbpaste | tg set-token');
    }
    cfg.ownerId ? ok(`paired with Telegram user ${cfg.ownerId}`) : bad('not paired', 'run: tg pair');
  }

  daemonStatus ? ok(`daemon running (pid ${daemonStatus.pid}, ${daemonStatus.sessions.length} session(s))`) : bad('daemon not running', 'run: tg up');
  if (process.platform === 'darwin') {
    if (!serviceInstalled()) warn('not installed as a login service', 'run: tg service install');
    else serviceLoaded() ? ok('launchd service installed and loaded') : warn('launchd service installed but not loaded', 'run: tg service install');
  }

  let resolved = null;
  try {
    resolved = fs.realpathSync(execFileSync('sh', ['-lc', 'command -v tg'], { encoding: 'utf8' }).trim());
  } catch {}
  if (resolved === fs.realpathSync(TG_BIN)) ok('`tg` on PATH points at this install');
  else if (resolved) warn(`\`tg\` on PATH is a different install: ${resolved}`, `run: ${TG_BIN} install`);
  else bad('`tg` is not on PATH', `add ${path.dirname(BIN_LINK)} to PATH, or run: ${TG_BIN} install`);

  skillUpToDate() ? ok(`/tg skill installed in ${SKILL_DIR}`) : warn('/tg skill missing or outdated', 'run: tg install');
  const state = hookState();
  const missing = Object.keys(state).filter((e) => state[e] === 'missing');
  const stale = Object.keys(state).filter((e) => state[e] !== 'missing' && state[e] !== 'ok');
  if (stale.length) bad(`hooks in ${SETTINGS_FILE} point at another install: ${stale.map((e) => `${e} → ${state[e].stale[0]}`).join(', ')}`, 'run: tg install  (rewrites them to this install)');
  else if (missing.length) warn(`hooks missing in ${SETTINGS_FILE}: ${missing.join(', ')}`, 'run: tg install');
  else ok('Stop, PermissionRequest and Notification hooks installed');

  const v = voiceSupport(cfg || {});
  if (v.ready) ok(`voice: ${v.provider === 'openai' ? 'OpenAI transcription' : 'local Whisper'}`);
  else warn(v.provider === 'openai' ? 'voice: OpenAI selected but no key' : 'voice: not set up (voice notes will be refused)', 'run: tg setup voice');

  const chrome = ['/Applications/Google Chrome.app', '/Applications/Chromium.app', '/Applications/Brave Browser.app', '/Applications/Microsoft Edge.app'].some((p) => fs.existsSync(p));
  chrome ? ok('a Chrome-family browser for report screenshots') : warn('no Chrome-family browser: `tg report` sends the file without a preview');
  if (process.platform !== 'darwin') warn('not macOS: no caffeinate, launchd or `tg spawn`; the daemon must be started by hand (tg up)');

  return { lines, healthy: !lines.some((l) => l.startsWith('❌')) };
}

export const randomCode = () => crypto.randomBytes(3).toString('hex');
export { SOCKET_PATH };
