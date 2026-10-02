// `tg setup` unattended, hook merging, doctor and uninstall — all inside temporary homes.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = '777:SETUPTOKENSETUPTOKENSETUPTOKENSETUPTOKEN';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tgHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-setup-home-'));
const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-setup-claude-'));
// Everything the CLI may write is redirected: runtime home, Claude Code dir, and the `tg` symlink.
const env = { ...process.env, CLAUDE_TG_HOME: tgHome, CLAUDE_CONFIG_DIR: claudeDir, CLAUDE_TG_LINK: path.join(tgHome, 'link', 'tg') };
delete env.CLAUDE_CODE_SESSION_ID;
let apiServer;
let apiBase;

function tg(args, stdinText = '') {
  return new Promise((resolve) => {
    const child = execFile('node', [path.join(ROOT, 'src/cli.js'), ...args], { env, timeout: 60000 }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
    child.stdin.end(stdinText);
  });
}

before(async () => {
  apiServer = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', async () => {
      const method = req.url.split('/').pop();
      let result = true;
      if (method === 'getMe') result = { id: 777, is_bot: true, username: 'setupbot', has_topics_enabled: false };
      if (method === 'getUpdates') {
        await sleep(200);
        result = [];
      }
      if (method === 'sendMessage') result = { message_id: 1 };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result }));
    });
  });
  await new Promise((r) => apiServer.listen(0, '127.0.0.1', r));
  apiBase = `http://127.0.0.1:${apiServer.address().port}`;
  // a settings.json the way a long-time user might have it: other keys, and a Stop hook already added by hand
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(git *)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: '$HOME/.local/bin/tg hook-stop 2>/dev/null || true', timeout: 5 }] }], PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'prettier --write' }] }] } }, null, 2));
});

after(async () => {
  await tg(['stop']);
  apiServer?.close();
  await sleep(300);
  fs.rmSync(tgHome, { recursive: true, force: true });
  fs.rmSync(claudeDir, { recursive: true, force: true });
});

test('setup runs unattended: validates the token, writes config 0600, installs skill + hooks, starts the daemon, prints the pairing code', async () => {
  const bad = await tg(['setup', '--token-stdin', '--api-base', apiBase, '--no-link', '--no-service', '--no-voice', '--no-wait'], 'not-a-token');
  assert.match(bad.stderr, /does not look like a bot token/);
  assert.ok(!fs.existsSync(path.join(tgHome, 'config.json')), 'nothing saved on a bad token');

  const r = await tg(['setup', '--token-stdin', '--api-base', apiBase, '--no-link', '--no-service', '--no-voice', '--no-wait', '--username', '@Owner'], `${TOKEN}\n`);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /✓ @setupbot/);
  assert.match(r.stdout, /added Stop, PermissionRequest, Notification|added PermissionRequest, Notification/);
  assert.match(r.stdout, /press START:\s+https:\/\/t\.me\/setupbot\?start=[A-Z2-9]{10}/);
  const cfg = JSON.parse(fs.readFileSync(path.join(tgHome, 'config.json'), 'utf8'));
  assert.equal(cfg.token, TOKEN);
  assert.equal(cfg.expectedUsername, 'Owner');
  assert.equal(cfg.ownerId, null);
  assert.equal(fs.statSync(path.join(tgHome, 'config.json')).mode & 0o077, 0);
  assert.ok(fs.existsSync(path.join(claudeDir, 'skills', 'tg', 'SKILL.md')));

  const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
  assert.equal(settings.model, 'opus', 'other settings untouched');
  assert.deepEqual(settings.permissions, { allow: ['Bash(git *)'] });
  assert.equal(settings.hooks.Stop.length, 1, 'the hand-written Stop hook is recognised, not duplicated');
  assert.equal(settings.hooks.PostToolUse[0].hooks[0].command, 'prettier --write', 'foreign hooks kept');
  assert.match(settings.hooks.PermissionRequest[0].hooks[0].command, /bin\/tg" hook-permission/);
  assert.equal(settings.hooks.PermissionRequest[0].hooks[0].timeout, 600);
  assert.equal(settings.hooks.Notification[0].hooks[0].async, true);
  assert.match(settings.hooks.Notification[0].matcher, /permission_prompt\|idle_prompt/);
  assert.ok(fs.readdirSync(claudeDir).some((f) => f.startsWith('settings.json.bak-')), 'backup written');

  const again = await tg(['setup', '--no-link', '--no-service', '--no-voice', '--no-wait']);
  assert.match(again.stdout, /already configured/);
  assert.match(again.stdout, /hooks in .*: already there/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8')).hooks.PermissionRequest.length, 1, 'idempotent');
});

test('hooks pointing at a moved install are reported by doctor and rewritten by install; a foreign `tg` is never replaced', async () => {
  const settingsFile = path.join(claudeDir, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  settings.hooks.PermissionRequest[0].hooks[0].command = '"/old/place/bin/tg" hook-permission 2>/dev/null || true';
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  const d = await tg(['doctor']);
  assert.match(d.stdout, /❌ hooks in .* point at another install: PermissionRequest → \/old\/place\/bin\/tg/);
  const i = await tg(['install']);
  assert.match(i.stdout, /rewrote PermissionRequest to this install/);
  assert.match(i.stdout, /linked .*\/link\/tg/);
  assert.equal(fs.readlinkSync(path.join(tgHome, 'link', 'tg')), path.join(ROOT, 'bin', 'tg'));
  const after = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.match(after.hooks.PermissionRequest[0].hooks[0].command, new RegExp(`"${ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/bin/tg" hook-permission`));
  assert.equal(after.hooks.PermissionRequest.length, 1);
  assert.match((await tg(['doctor'])).stdout, /✅ Stop, PermissionRequest and Notification hooks installed/);

  const foreign = path.join(tgHome, 'bin', 'tg');
  fs.mkdirSync(path.dirname(foreign), { recursive: true });
  fs.writeFileSync(foreign, '#!/bin/sh\necho telegram-cli\n');
  const probe = await new Promise((resolve) => execFile('node', ['--input-type=module', '-e', `import {linkCli} from './src/setup.js'; try { linkCli(${JSON.stringify(foreign)}); console.log('replaced') } catch (e) { console.log('refused: ' + e.message) }`], { env, cwd: ROOT }, (e, stdout) => resolve(stdout.trim())));
  assert.match(probe, /^refused: .*not this tool/);
  assert.equal(fs.readFileSync(foreign, 'utf8'), '#!/bin/sh\necho telegram-cli\n', 'the foreign file is intact');

  const unattended = await tg(['setup', '--no-link', '--no-service', '--no-wait']);
  assert.match(unattended.stdout, /4\/5  Voice messages\n\s+skipped — not a terminal/);
  assert.ok(!fs.existsSync(path.join(tgHome, 'models')), 'no download without a yes');
});

test('doctor reports each part and fails only on real blockers; uninstall removes exactly ours', async () => {
  const d = await tg(['doctor']);
  assert.equal(d.code, 1, 'unpaired is a blocker');
  assert.match(d.stdout, /✅ bot token valid — @setupbot/);
  assert.match(d.stdout, /❌ not paired/);
  assert.match(d.stdout, /✅ daemon running/);
  assert.match(d.stdout, /✅ Stop, PermissionRequest and Notification hooks installed/);
  assert.match(d.stdout, /\/tg skill installed/);

  const u = await tg(['uninstall', '--keep-link']);
  assert.match(u.stdout, /removed hooks: Stop, PermissionRequest, Notification/);
  const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
  assert.equal(settings.hooks.Stop, undefined);
  assert.equal(settings.hooks.PermissionRequest, undefined);
  assert.equal(settings.hooks.PostToolUse[0].hooks[0].command, 'prettier --write', 'foreign hook survives');
  assert.equal(settings.model, 'opus');
  assert.ok(!fs.existsSync(path.join(claudeDir, 'skills', 'tg')));
  assert.ok(fs.existsSync(path.join(tgHome, 'config.json')), 'config kept without --purge');
  await sleep(500);
  assert.match((await tg(['status'])).stdout, /not running/);
});

test('folder trust is read from and written to Claude Code\'s project list without touching other entries', async () => {
  const claudeJson = path.join(claudeDir, '.claude.json');
  fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'x@y' }, projects: { '/p/known': { hasTrustDialogAccepted: true, allowedTools: ['Bash'] } } }));
  const { folderTrusted, trustFolder } = await import('../src/setup.js'); // CLAUDE_CONFIG_DIR is set for this process? no — use the CLI's view instead
  // the module resolves paths from the test process env, which has no CLAUDE_CONFIG_DIR; so exercise it through a child
  const probe = (code) => new Promise((resolve) => execFile('node', ['--input-type=module', '-e', code], { env, cwd: ROOT }, (e, stdout, stderr) => resolve((stdout || stderr).trim())));
  assert.equal(await probe(`import {folderTrusted} from './src/setup.js'; console.log(folderTrusted('/p/known'), folderTrusted('/p/new'))`), 'true false');
  await probe(`import {trustFolder} from './src/setup.js'; trustFolder('/p/new')`);
  const after = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
  assert.equal(after.projects['/p/new'].hasTrustDialogAccepted, true);
  assert.deepEqual(after.projects['/p/known'], { hasTrustDialogAccepted: true, allowedTools: ['Bash'] });
  assert.equal(after.oauthAccount.emailAddress, 'x@y');
  assert.equal(fs.statSync(claudeJson).mode & 0o077, 0);
  void folderTrusted;
  void trustFolder;
});
