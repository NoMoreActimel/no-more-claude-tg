import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_FILE, DAEMON_ENTRY, HOME_DIR, OUTBOX_DIR, REPO_DIR, SERVICE_LABEL, SERVICE_PLIST, TOOL_PATH } from './paths.js';
import { api, daemonUp, ensureDaemon, logTail, waitUp } from './client.js';
import { safeFileName, validateName } from './format.js';
import { hookNotify, hookPermission, readStdinJson } from './hooks.js';
import { BIN_LINK, SETTINGS_FILE, SKILL_DIR, askLine, confirm, doctor, folderTrusted, hooksInstalled, installHooks, installLocalVoice, installSkill, linkCli, saveConfig, trustFolder, uninstallHooks, validateToken } from './setup.js';
import { voiceSupport } from './voice.js';
import { findLocalRefs, screenshot } from './report.js';
import { DEFAULT_CONFIG, ensurePrivateDir, readJson, writeJsonAtomic } from './store.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (s = '') => process.stdout.write(`${s}\n`);

class UsageError extends Error {}

// ------------------------------------------------------------------ plumbing

function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split(/=(.*)/s);
      const next = argv[i + 1];
      let v = true;
      if (inline !== undefined) v = inline;
      else if (next !== undefined && !next.startsWith('--')) v = argv[++i];
      if (k in flags) flags[k] = [].concat(flags[k], v);
      else flags[k] = v;
    } else rest.push(a);
  }
  return { flags, rest };
}

function sessionId(flags) {
  const id = flags.session || process.env.CLAUDE_CODE_SESSION_ID;
  if (!id) throw new UsageError('no session id: run this from inside a Claude Code session, or pass --session <id>');
  return String(id);
}

// tg runs as: claude -> shell -> tg. Remember claude's pid so the bridge notices when it exits.
function findClaudePid() {
  let pid = process.ppid;
  for (let hops = 0; hops < 10 && pid > 1; hops++) {
    let row;
    try {
      row = execFileSync('ps', ['-o', 'ppid=,comm=,args=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    } catch {
      return null;
    }
    const m = row.match(/^(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) return null;
    const [, ppid, comm, args] = m;
    const argv0 = path.basename(args.split(/\s+/)[0]);
    if (argv0 === 'claude' || path.basename(comm) === 'claude' || /\/claude\/versions\//.test(comm)) return pid;
    pid = Number(ppid);
  }
  return null;
}

function projectRoot(flags) {
  const dir = flags.project ? path.resolve(String(flags.project)) : process.cwd();
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    // worktrees share one common dir, so every worktree of a repo maps to the same project emoji
    const common = git('rev-parse', '--path-format=absolute', '--git-common-dir');
    return path.basename(common) === '.git' ? path.dirname(common) : git('rev-parse', '--show-toplevel');
  } catch {
    return dir;
  }
}

function stage(sourcePath, name) {
  const src = path.resolve(sourcePath);
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) throw new UsageError(`not a file: ${sourcePath}`);
  const dir = path.join(OUTBOX_DIR, crypto.randomBytes(8).toString('hex'));
  ensurePrivateDir(OUTBOX_DIR);
  ensurePrivateDir(dir);
  const dest = path.join(dir, name || path.basename(src));
  fs.copyFileSync(src, dest);
  return dest;
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

// ------------------------------------------------------------------ commands

function printStatus(st, mySession) {
  out(`bridge: running (pid ${st.pid}, up ${Math.round(st.uptimeSec / 60)} min) · bot @${st.bot || '?'}`);
  out(`paired: ${st.paired ? 'yes' : 'NO — run `tg pair`'} · threads: ${st.threadMode ? 'on' : 'off (single chat)'} · voice: ${st.voice ? 'ready' : 'off'} · caffeinate: ${st.caffeinate ? 'on' : 'off'} · links: ${st.links ? 'on' : 'off'}`);
  if (!st.sessions.length) out('sessions: none');
  for (const s of st.sessions) out(`  ${s.listening ? '🟢' : '🟡'} ${s.signature}${s.id === mySession ? '  ← this session' : ''}${s.queued ? `  (${s.queued} queued)` : ''}  [${path.basename(s.project)}]`);
}

async function printPairing(reset) {
  const p = await api('POST', '/pair', { reset });
  out('');
  out('PAIRING — the bot answers nobody until this is done.');
  out(`Ask the user to open this link on their phone and press START:`);
  out(`  ${p.link || '(bot username unknown — send the code to the bot manually)'}`);
  out(`or send this code to the bot as a message:  ${p.code}`);
  out(`Valid 10 minutes${p.expectedUsername ? `, only from @${p.expectedUsername}` : ''}. The account that sends it becomes the only one the bot will ever talk to.`);
}

async function setupVoice(flags) {
  if (flags.openai) {
    const key = flags['key-stdin'] ? (await readStdin()).trim() : await askLine('OpenAI API key (nothing is echoed): ', { hidden: true });
    if (!/^sk-/.test(key)) throw new UsageError('that does not look like an OpenAI API key');
    saveConfig({ voice: { provider: 'openai', apiKey: key, model: flags.model ? String(flags.model) : undefined } });
    return out('voice: OpenAI transcription (about $0.003 per minute of audio). Takes effect on the next voice note.');
  }
  installLocalVoice(out);
  saveConfig({ voice: { provider: 'local' } });
  out('voice: local Whisper ready');
}

const commands = {
  async up() {
    const started = await ensureDaemon();
    if (started) out('started the bridge daemon');
    const st = await api('GET', '/status');
    printStatus(st, process.env.CLAUDE_CODE_SESSION_ID);
    if (!st.paired) await printPairing(false);
  },

  async status() {
    if (!(await daemonUp())) return out('bridge: not running (start it with `tg up`)');
    printStatus(await api('GET', '/status'), process.env.CLAUDE_CODE_SESSION_ID);
  },

  async pair({ flags }) {
    await ensureDaemon();
    await printPairing(Boolean(flags.reset));
  },

  async register({ flags }) {
    await ensureDaemon();
    if (!flags.name || !flags.emoji) throw new UsageError('usage: tg register --name "2-3 words" --emoji <task emoji> --project-emoji <project emoji>');
    const r = await api('POST', '/register', {
      sessionId: sessionId(flags),
      name: flags.name,
      emoji: flags.emoji,
      projectEmoji: flags['project-emoji'],
      project: projectRoot(flags),
      pid: findClaudePid(),
    });
    out(`registered as: ${r.signature}   (${r.threadMode ? 'own Telegram thread' : 'single-chat mode'})`);
    if (r.projectEmojiReused) out(`note: this project already uses ${r.projectEmoji}, so that was kept.`);
    out('next: run `tg listen` with run_in_background: true');
  },

  // Start a brand-new interactive Claude Code session in a Terminal window and have it connect itself.
  // Lives in the CLI on purpose: the daemon (the part that talks to Telegram) can never start a process;
  // only a session the owner already connected can, and it could run shell commands anyway.
  async spawn({ flags }) {
    if (process.platform !== 'darwin') throw new UsageError('tg spawn needs macOS Terminal');
    if (!flags.project || !flags.name) throw new UsageError('usage: tg spawn --project <dir> --name "2-3 words" [--task "what to start on"]');
    const dir = path.resolve(String(flags.project).replace(/^~(?=$|\/)/, os.homedir()));
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new UsageError(`not a directory: ${dir}`);
    const name = validateName(flags.name);
    await ensureDaemon();

    if (!folderTrusted(dir) && !flags['dry-run']) {
      // Claude Code would stop at its "Do you trust the files in this folder?" dialog, which nobody can answer
      // from a phone. Ask the owner on Telegram instead; only their tap launches.
      const r = await api('POST', '/ask', { sessionId: sessionId(flags), text: `📁 \`${dir}\` was never opened in Claude Code. Trust the files in it and start a session there?`, options: ['Trust and launch', 'Cancel'], allowText: false, timeoutMs: 10 * 60 * 1000 }, { timeoutMs: 0 });
      if (r.choice !== 'Trust and launch') {
        out(r.timeout ? 'no answer from the user within 10 minutes; not launched' : 'the user did not approve trusting that folder; not launched');
        process.exitCode = 3;
        return;
      }
      trustFolder(dir);
      out(`trusted ${dir} (recorded in Claude Code's own project list)`);
    }

    const launchDir = path.join(HOME_DIR, 'launch');
    ensurePrivateDir(launchDir);
    const stem = path.join(launchDir, `${safeFileName(path.basename(dir))}-${safeFileName(name.replace(/\s+/g, '-'))}-${Date.now()}`);
    const next = flags.task ? `Then start on this task: ${flags.task}` : 'Once connected, tell me on Telegram that you are ready, then wait for my instructions there.';
    fs.writeFileSync(`${stem}.prompt`, `I am away from the laptop and started you remotely. Connect this session to Telegram now with the tg skill: read ~/.claude/skills/tg/SKILL.md and follow it. Use the session name "${name}". ${next}`, { mode: 0o600 });
    // the prompt travels in a file, so nothing the user wrote is ever interpreted by the shell
    const q = (s) => `'${s.replaceAll("'", "'\\''")}'`;
    fs.writeFileSync(`${stem}.command`, `#!/bin/zsh -l\nexport PATH="$HOME/.local/bin:${TOOL_PATH}:$PATH"\ncd ${q(dir)} || exit 1\nexec claude "$(cat ${q(`${stem}.prompt`)})"\n`, { mode: 0o700 });

    if (flags['dry-run']) return out(`dry run — would open: ${stem}.command`);
    const before = new Set((await api('GET', '/status')).sessions.map((s) => s.id));
    execFileSync('open', ['-a', 'Terminal', `${stem}.command`]);
    out(`opened a new Terminal window: claude in ${dir}`);
    try {
      for (let waited = 0; waited < 150000; waited += 3000) {
        await sleep(3000);
        const fresh = (await api('GET', '/status')).sessions.find((s) => !before.has(s.id));
        if (fresh) return out(`connected as: ${fresh.signature}  (after ${Math.round((waited + 3000) / 1000)}s). With several sessions connected, the user reaches it by replying to its messages or via /sessions.`);
      }
      out('the window opened, but no new session registered within 150s — it may be waiting on a prompt at the laptop. Check `tg status` later.');
      process.exitCode = 3;
    } finally {
      // the task text is read by claude at start; nothing needs these files afterwards
      for (const f of [`${stem}.prompt`, `${stem}.command`]) fs.rm(f, { force: true }, () => {});
    }
  },

  async 'project-emoji'({ flags, rest }) {
    await ensureDaemon();
    if (!rest[0]) {
      const { projects } = await api('GET', '/project-emojis');
      const rows = Object.entries(projects);
      return out(rows.length ? rows.map(([p, e]) => `${e}  ${p}`).join('\n') : 'no project emojis set yet');
    }
    const r = await api('POST', '/project-emoji', { project: projectRoot(flags), emoji: rest[0] });
    out(`${r.emoji}  ${r.project}${r.renamed.length ? `\nrenamed connected sessions: ${r.renamed.join(', ')}` : ''}`);
  },

  async bye({ flags }) {
    if (!(await daemonUp())) return out('bridge is not running; nothing to disconnect');
    const r = await api('POST', '/unregister', { sessionId: sessionId(flags) });
    out(r.ended ? 'disconnected from Telegram. Stop any running `tg listen`; do not re-arm it.' : 'this session was not connected');
  },

  async send({ flags, rest }) {
    let text = rest.join(' ');
    if (!text || text === '-') text = await readStdin();
    if (!text.trim()) throw new UsageError('usage: tg send "short message"   (or pipe text on stdin)');
    await ensureDaemon();
    await api('POST', '/send', { sessionId: sessionId(flags), text });
    out('sent');
  },

  async 'send-file'({ flags, rest }) {
    if (!rest[0]) throw new UsageError('usage: tg send-file <path> [--caption "…"] [--as-file]');
    await ensureDaemon();
    const isImage = /\.(png|jpe?g|webp)$/i.test(rest[0]) && fs.statSync(rest[0]).size < 9 * 1024 * 1024;
    const kind = isImage && !flags['as-file'] ? 'photo' : 'document';
    await api('POST', '/send-file', { sessionId: sessionId(flags), path: stage(rest[0]), caption: flags.caption || '', kind }, { timeoutMs: 200000 });
    out(`sent ${path.basename(rest[0])} as ${kind}`);
  },

  async report({ flags, rest }) {
    const file = rest[0];
    if (!file || !/\.html?$/i.test(file)) throw new UsageError('usage: tg report <file.html> [--caption "…"] [--link] [--force]');
    const html = fs.readFileSync(file, 'utf8');
    const refs = findLocalRefs(html);
    if (refs.length && !flags.force) {
      out('NOT SENT — this HTML still loads things from the laptop, so it would be broken on a phone:');
      for (const r of refs.slice(0, 15)) out(`  ${r}`);
      out('Fix: compute the results now and embed them — inline the JSON/CSV into a <script>, inline CSS/JS, turn images into data: URIs. Then run this again. (--force sends it anyway.)');
      process.exitCode = 2;
      return;
    }
    await ensureDaemon();
    const sid = sessionId(flags);
    const title = html.match(/<title[^>]*>([^<]{1,120})<\/title>/i)?.[1]?.trim();
    const caption = flags.caption || title || path.basename(file);
    const shots = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-report-'));
    const base = path.basename(file);
    const sendDoc = (p, cap, name) => api('POST', '/send-file', { sessionId: sid, path: stage(p, name), caption: cap, kind: 'document' }, { timeoutMs: 200000 });
    let frozenSent = false;
    try {
      const { preview, full, frozen } = await screenshot(path.resolve(file), shots);
      await api('POST', '/send-file', { sessionId: sid, path: stage(preview), caption, kind: 'photo' }, { timeoutMs: 200000 });
      out('sent preview screenshot');
      if (frozen) {
        // Phone viewers (Telegram on iOS) do not run JavaScript, so the file to tap is the pre-rendered one.
        await sendDoc(frozen, `📎 ${caption}\nopens on the phone — pre-rendered, no JS needed`, base);
        frozenSent = true;
        out(`sent ${base} (static snapshot)`);
      } else if (full) {
        // as a document: Telegram would shrink a tall photo into an unreadable strip
        await sendDoc(full, '🖼 full page');
        out('sent full-page image (static snapshot failed)');
      }
    } catch (e) {
      out(`(no rendering: ${e.message})`);
    } finally {
      fs.rmSync(shots, { recursive: true, force: true });
    }
    if (!frozenSent || flags['with-original']) {
      const name = frozenSent ? base.replace(/(\.html?)$/i, '.interactive$1') : base;
      await sendDoc(file, frozenSent ? '💻 interactive original — open on a computer' : `📎 ${caption}`, name);
      out(`sent ${name} (original)`);
    }
    if (flags.link) {
      try {
        const r = await api('POST', '/publish', { sessionId: sid, path: stage(file) }, { timeoutMs: 60000 });
        out(`sent secret link (expires ${new Date(r.expiresAt).toLocaleString()})`);
      } catch (e) {
        out(`no link: ${e.message}`);
      }
    }
  },

  async listen({ flags }) {
    const sid = sessionId(flags);
    let pause = 2000;
    for (;;) {
      let r;
      try {
        await ensureDaemon();
        r = await api('GET', `/listen?sessionId=${encodeURIComponent(sid)}`, null, { timeoutMs: 0 });
        pause = 2000;
      } catch {
        await sleep(pause); // daemon restarting or laptop waking up: stay quiet and keep waiting
        pause = Math.min(pause * 2, 30000);
        continue;
      }
      if (r.timeout || r.restart) continue;
      if (r.duplicate) return out('A Telegram listener is already armed for this session. Nothing to do — do not start another.');
      if (r.ended) return out(`This session is no longer connected to Telegram${r.reason ? ` (${r.reason})` : ''}. Do NOT re-arm the listener. To reconnect, run tg register again.`);
      if (!r.messages?.length) continue;

      const many = r.messages.length > 1;
      out(`📨 TELEGRAM — ${many ? `${r.messages.length} messages` : 'message'} from your user for this session (${r.signature}):`);
      r.messages.forEach((m, i) => {
        out('');
        if (many) out(`[${i + 1}]`);
        if (m.replyTo) out(`(replying to: "${m.replyTo.replace(/\s+/g, ' ')}")`);
        if (m.voice) out('(voice message, transcribed — may contain mis-hearings)');
        if (m.text) out(m.text);
        for (const a of m.attachments || []) out(`[attached file: ${a}]`);
      });
      out('');
      out('— This is your user, on their phone; they cannot see this terminal. Act on it, then answer with:  tg send "<short reply>"');
      out('— Then re-arm:  tg listen   (Bash, run_in_background: true). Always re-arm before you stop.');
      await new Promise((resolve) => process.stdout.write('', resolve));
      try {
        await api('POST', '/ack', { sessionId: sid, upTo: Math.max(...r.messages.map((m) => m.seq)) });
      } catch {}
      return;
    }
  },

  // A quick multiple-choice (or free-text) question to the user on their phone. Exit 0 and the answer on
  // stdout; 3 when nobody answered in time; 4 when the session was disconnected meanwhile.
  async ask({ flags, rest }) {
    const text = rest.join(' ').trim();
    if (!text) throw new UsageError('usage: tg ask "question" [--option A --option B …] [--timeout <sec>] [--no-text]');
    const options = [].concat(flags.option ?? []).filter((o) => typeof o === 'string');
    await ensureDaemon();
    const r = await api('POST', '/ask', { sessionId: sessionId(flags), text, options, timeoutMs: (Number(flags.timeout) || 570) * 1000, allowText: !flags['no-text'], kind: 'question' }, { timeoutMs: 0 });
    if (r.timeout) {
      out('no answer in time — the user has not seen it yet');
      process.exitCode = 3;
    } else if (r.ended || r.restart) {
      out('the session was disconnected before an answer came');
      process.exitCode = 4;
    } else out(r.text ?? r.choice);
  },

  // Claude Code hooks (installed into settings.json by `tg setup`). They print nothing unless this
  // session is connected to Telegram, so unconnected sessions keep their normal local dialogs.
  async 'hook-permission'() {
    await hookPermission(await readStdinJson(), out);
  },

  async 'hook-notify'() {
    await hookNotify(await readStdinJson());
  },

  // Stop hook: a connected session must not go idle without a listener, or it becomes unreachable.
  async 'hook-stop'() {
    const input = await readStdinJson();
    if (input.stop_hook_active) return;
    const sid = input.session_id || process.env.CLAUDE_CODE_SESSION_ID;
    if (!sid) return;
    let st;
    try {
      st = await api('GET', `/session?sessionId=${encodeURIComponent(sid)}`, null, { timeoutMs: 800 });
    } catch {
      return; // no daemon, no opinion
    }
    if (!st.registered || st.listening) return;
    const why = st.queued
      ? `${st.queued} Telegram message(s) from your user are waiting. Run \`tg listen\` (Bash, run_in_background: true) to receive them.`
      : 'This session is connected to Telegram but no listener is armed, so your user cannot reach you. Run `tg listen` (Bash, run_in_background: true), then finish. If the user is back at the terminal and no longer needs Telegram, run `tg bye` instead.';
    out(JSON.stringify({ decision: 'block', reason: why }));
  },

  async stop() {
    if (!(await daemonUp())) return out('bridge is not running');
    await api('POST', '/stop', {});
    out('bridge stopped' + (fs.existsSync(SERVICE_PLIST) ? ' (launchd will not restart it after a clean stop; `tg up` starts it again)' : ''));
  },

  async logs({ flags }) {
    out(logTail(Number(flags.n) || 40));
  },

  async 'set-token'() {
    const token = (await readStdin()).trim() || '';
    if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) throw new UsageError('usage: pbpaste | tg set-token     (the token is read from stdin so it never lands in shell history)');
    const config = { ...DEFAULT_CONFIG, ...readJson(CONFIG_FILE, {}) };
    config.token = token;
    writeJsonAtomic(CONFIG_FILE, config);
    out('token saved (owner pairing kept). Restart the bridge: tg stop && tg up');
  },

  async service({ rest, quiet = false }) {
    const uid = process.getuid();
    if (rest[0] === 'install') {
      const x = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key><array><string>${x(process.execPath)}</string><string>${x(DAEMON_ENTRY)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>WorkingDirectory</key><string>${x(os.homedir())}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${TOOL_PATH}</string></dict>
</dict></plist>
`;
      fs.mkdirSync(path.dirname(SERVICE_PLIST), { recursive: true });
      fs.writeFileSync(SERVICE_PLIST, plist);
      if (await daemonUp()) await api('POST', '/stop', {}).catch(() => {});
      await sleep(500);
      try {
        execFileSync('launchctl', ['bootout', `gui/${uid}/${SERVICE_LABEL}`], { stdio: 'ignore' });
      } catch {}
      execFileSync('launchctl', ['bootstrap', `gui/${uid}`, SERVICE_PLIST], { stdio: 'inherit' });
      const up = await waitUp(8000);
      if (!up) throw new Error(`service installed but the daemon is not answering. Log:\n${logTail()}`);
      if (!quiet) out('service installed: the bridge now starts at login and restarts if it crashes');
    } else if (rest[0] === 'uninstall') {
      try {
        execFileSync('launchctl', ['bootout', `gui/${uid}/${SERVICE_LABEL}`], { stdio: 'ignore' });
      } catch {}
      fs.rmSync(SERVICE_PLIST, { force: true });
      out('service removed');
    } else throw new UsageError('usage: tg service install|uninstall');
  },

  async install({ flags }) {
    if (flags['no-link']) out('not linking the CLI (--no-link)');
    else {
      try {
        const { link, onPath } = linkCli(undefined, { force: Boolean(flags.force) });
        out(`linked ${link}${onPath ? '' : `  (add ${path.dirname(link)} to your PATH)`}`);
      } catch (e) {
        out(`not linked: ${e.message}`);
      }
    }
    out(`installed the /tg skill into ${installSkill()}`);
    const { added, rewritten } = installHooks();
    const what = [added.length && `added ${added.join(', ')}`, rewritten.length && `rewrote ${rewritten.join(', ')} to this install`].filter(Boolean).join('; ');
    out(what ? `hooks in ${SETTINGS_FILE}: ${what} (backup kept next to it)` : `hooks already present in ${SETTINGS_FILE}`);
  },

  async uninstall({ flags }) {
    const { removed } = uninstallHooks();
    out(removed.length ? `removed hooks: ${removed.join(', ')}` : 'no hooks to remove');
    fs.rmSync(SKILL_DIR, { recursive: true, force: true });
    out(`removed ${SKILL_DIR}`);
    if (fs.existsSync(SERVICE_PLIST)) await commands.service({ rest: ['uninstall'] });
    else if (await daemonUp()) await api('POST', '/stop', {}).catch(() => {});
    if (!flags['keep-link']) {
      try {
        if (fs.readlinkSync(BIN_LINK) === path.join(REPO_DIR, 'bin', 'tg')) fs.rmSync(BIN_LINK, { force: true });
      } catch {}
    }
    if (flags.purge) {
      fs.rmSync(HOME_DIR, { recursive: true, force: true });
      out(`deleted ${HOME_DIR} (token, pairing, inbox, the 1.6 GB speech model)`);
    } else out(`kept ${HOME_DIR} (token and pairing); add --purge to delete it`);
  },

  // First-run wizard. Every step is skippable with a flag so it can run unattended (and in tests).
  async setup({ flags, rest }) {
    if (rest[0] === 'voice') return setupVoice(flags);
    const major = Number(process.versions.node.split('.')[0]);
    if (major < 22) throw new Error(`Node ${process.versions.node} is too old; this needs Node 22 or newer`);

    let config = readJson(CONFIG_FILE, null);
    const apiBase = flags['api-base'] ? String(flags['api-base']) : config?.apiBase;
    if (!config?.token || flags['new-token']) {
      out('1/5  Bot token. In Telegram, open @BotFather, send /newbot, follow the prompts, copy the token.');
      const token = flags['token-stdin'] ? (await readStdin()).trim() : await askLine('     Paste the token (nothing is echoed): ', { hidden: true });
      const me = await validateToken(token, apiBase);
      out(`     ✓ @${me.username}`);
      const username = flags.username !== undefined ? String(flags.username) : process.stdin.isTTY ? await askLine('     Your own Telegram @username, as an extra check during pairing (Enter to skip): ') : '';
      config = saveConfig({ token, apiBase, expectedUsername: username.replace(/^@/, '') || null, ownerId: config?.ownerId ?? null });
      out(`     saved to ${CONFIG_FILE} (only you can read it)`);
    } else out(`1/5  bot token already configured (${CONFIG_FILE}); use --new-token to replace it`);

    out('2/5  Install');
    if (!flags['no-link']) {
      try {
        const { link, onPath } = linkCli(undefined, { force: Boolean(flags.force) });
        out(`     ${link}${onPath ? '' : `  — add ${path.dirname(link)} to your PATH`}`);
      } catch (e) {
        out(`     ${e.message}`);
      }
    }
    if (!flags['no-skill']) out(`     /tg skill → ${installSkill()}`);
    if (!flags['no-hooks']) {
      const { added, rewritten } = installHooks();
      const what = [added.length && `added ${added.join(', ')}`, rewritten.length && `rewrote ${rewritten.join(', ')}`].filter(Boolean).join('; ');
      out(`     hooks in ${SETTINGS_FILE}: ${what || 'already there'}`);
    }

    out('3/5  Bridge daemon');
    if (!flags['no-service'] && process.platform === 'darwin') await commands.service({ rest: ['install'], quiet: true });
    else await ensureDaemon();
    out(`     running${process.platform === 'darwin' && !flags['no-service'] ? ', starts at login' : ''}`);

    out('4/5  Voice messages');
    if (flags['no-voice']) out('     skipped');
    else if (voiceSupport(config).ready) out('     already set up');
    else if (flags.voice || (process.stdin.isTTY && (await confirm('     Transcribe voice notes locally with Whisper? Free, needs Homebrew and a 1.6 GB download.', { fallback: true })))) {
      try {
        installLocalVoice(out);
        out('     ✓ voice ready');
      } catch (e) {
        out(`     ${e.message}`);
      }
    } else out(process.stdin.isTTY ? '     skipped (later: tg setup voice)' : '     skipped — not a terminal; run `tg setup voice` or pass --voice');

    out('5/5  Pairing');
    const st = await api('GET', '/status');
    if (st.paired) out('     already paired');
    else {
      const p = await api('POST', '/pair', {});
      out(`     Open this on your phone and press START:  ${p.link || `(send the code to the bot)`}`);
      out(`     or send the bot this code:  ${p.code}     (valid 10 minutes${p.expectedUsername ? `, only from @${p.expectedUsername}` : ''})`);
      if (!flags['no-wait']) {
        for (let waited = 0; waited < 10 * 60 * 1000; waited += 2000) {
          await sleep(2000);
          if ((await api('GET', '/status')).paired) break;
        }
        out((await api('GET', '/status')).paired ? '     ✓ paired' : '     not paired yet — run `tg pair` for a fresh code when you are ready');
      }
    }
    out('');
    out('Done. In any Claude Code session type  /tg  before you walk away. `tg doctor` checks everything.');
    out('Recommended in @BotFather: /setjoingroups → Disable, and topics for private chats (a thread per session).');
  },

  async doctor() {
    const daemonStatus = (await daemonUp()) ? await api('GET', '/status') : null;
    const { lines, healthy } = await doctor({ daemonStatus });
    out(lines.join('\n'));
    if (!healthy) process.exitCode = 1;
  },

  async help() {
    out(`tg — talk to Claude Code sessions from Telegram

  tg up                         start the bridge if needed, show status (and pairing link if unpaired)
  tg register --name "fix loader" --emoji 🐛 --project-emoji 🧬
  tg listen                     wait for the next Telegram message (run in background)
  tg send "text"                message the user (signed with this session's name)
  tg ask "question" --option A --option B    ask the user on their phone, print the answer
  tg send-file <path> [--caption …] [--as-file]
  tg report <file.html> [--caption …] [--with-original] [--force]
  tg bye                        disconnect this session
  tg project-emoji [🔥] [--project <dir>]   pin a project's emoji (no emoji: list them)
  tg spawn --project <dir> --name "blogposts" [--task "…"]   start a NEW claude session in Terminal, connected
  tg status | logs | stop
  tg pair [--reset]             (re)pair the bot with a Telegram account
  tg service install|uninstall  run the bridge at login via launchd
  tg setup                      first run: token, install, daemon, voice, pairing  (tg setup voice [--openai])
  tg doctor                     check every part and say how to fix what is off
  tg install | uninstall [--purge]   link the CLI, install the /tg skill and hooks / remove them
  pbpaste | tg set-token        replace the bot token`);
  },
};

const [name = 'help', ...argv] = process.argv.slice(2);
const command = commands[name === '--help' || name === '-h' ? 'help' : name];
if (!command) {
  process.stderr.write(`tg: unknown command "${name}" — try: tg help\n`);
  process.exit(64);
}
command(parseArgs(argv)).catch((e) => {
  process.stderr.write(`tg: ${e.message}\n`);
  process.exit(e instanceof UsageError ? 64 : 1);
});
