// Runs the real daemon and the real CLI against a fake Telegram Bot API, over the real unix socket.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = '424242:TESTTOKENTESTTOKENTESTTOKENTESTTOKEN';
const OWNER = 111;
const STRANGER = 666;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-e2e-'));
const env = { ...process.env, CLAUDE_TG_HOME: home, CLAUDE_CODE_SESSION_ID: 'e2e-session-1', CLAUDE_CONFIG_DIR: path.join(home, 'claude'), CLAUDE_TG_LINK: path.join(home, 'link', 'tg') };
const apiCalls = [];
const pendingUpdates = [];
let updateId = 1;
let messageId = 100;
let apiServer;
let daemon;

let ackedOffset = 0;

function inject(fromId, username, text, extra = {}) {
  const id = updateId++;
  pendingUpdates.push({ update_id: id, message: { message_id: messageId++, from: { id: fromId, is_bot: false, username }, chat: { id: fromId, type: 'private' }, text, ...extra } });
  return id;
}

function injectTap(data, fromId = OWNER) {
  const id = updateId++;
  pendingUpdates.push({ update_id: id, callback_query: { id: `cq${id}`, from: { id: fromId, is_bot: false }, message: { chat: { id: fromId, type: 'private' } }, data } });
  return id;
}

const handled = (id) => until(() => ackedOffset > id, `update ${id} handled by the daemon`);

const calls = (method) => apiCalls.filter((c) => c.method === method);

async function until(check, what, ms = 8000) {
  for (let waited = 0; waited < ms; waited += 50) {
    if (await check()) return;
    await sleep(50);
  }
  assert.fail(`timed out waiting for: ${what}`);
}

function tg(...args) {
  return new Promise((resolve) => {
    const child = execFile('node', [path.join(ROOT, 'src/cli.js'), ...args], { env, timeout: 20000 }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
    child.stdin.end();
  });
}

before(async () => {
  apiServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const method = req.url.split('/').pop();
      assert.ok(req.url.startsWith(`/bot${TOKEN}/`), 'daemon must use the configured token');
      const raw = Buffer.concat(chunks);
      let params = {};
      if ((req.headers['content-type'] || '').includes('json')) params = JSON.parse(raw.toString() || '{}');
      else params = { multipart: true, size: raw.length, raw: raw.toString('latin1') };
      const call = { method, params };
      if (method !== 'getUpdates') apiCalls.push(call);
      let result = true;
      if (method === 'getMe') result = { id: 1, is_bot: true, username: 'fakebot', has_topics_enabled: true };
      if (method === 'getUpdates') {
        ackedOffset = Math.max(ackedOffset, params.offset || 0); // offset only advances after an update was handled
        for (let i = 0; i < 10 && !pendingUpdates.length; i++) await sleep(30);
        result = pendingUpdates.splice(0).filter((u) => u.update_id >= (params.offset || 0));
      }
      if (['sendMessage', 'sendDocument', 'sendPhoto'].includes(method)) result = { message_id: messageId++ };
      call.result = result;
      if (method === 'createForumTopic') result = { message_thread_id: 77, name: params.name };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result }));
    });
  });
  await new Promise((r) => apiServer.listen(0, '127.0.0.1', r));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ token: TOKEN, apiBase: `http://127.0.0.1:${apiServer.address().port}`, expectedUsername: 'Owner', ownerId: null }), { mode: 0o600 });
  daemon = spawn('node', [path.join(ROOT, 'src/daemon.js')], { env, stdio: 'ignore' });
  await until(() => fs.existsSync(path.join(home, 'daemon.sock')), 'daemon socket');
});

after(async () => {
  daemon?.kill('SIGTERM');
  apiServer?.close();
  await sleep(300);
  fs.rmSync(home, { recursive: true, force: true });
});

test('full flow: pair → register → receive → reply → file → hook → disconnect', async () => {
  // the control socket and everything around it is owner-only
  assert.equal(fs.statSync(path.join(home, 'daemon.sock')).mode & 0o077, 0);

  // --- unpaired: nothing can register, strangers and even a correct code from the wrong account fail
  const early = await tg('register', '--name', 'fix loader', '--emoji', '🐛', '--project-emoji', '🧬');
  assert.match(early.stderr, /not paired/);

  const pairing = await tg('pair');
  const code = pairing.stdout.match(/code to the bot as a message:\s+(\S+)/)[1];
  assert.match(pairing.stdout, new RegExp(`https://t.me/fakebot\\?start=${code}`));

  await handled(inject(STRANGER, 'mallory', `/start ${code}`));
  assert.equal(calls('sendMessage').length, 0, 'impostor gets no reply');
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'config.json'))).ownerId, null);

  inject(OWNER, 'Owner', `/start ${code}`);
  await until(() => calls('sendMessage').length === 1, 'pairing confirmation');
  assert.equal(calls('sendMessage')[0].params.chat_id, OWNER);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'config.json'))).ownerId, OWNER);

  // --- register: gets its own thread, named with both emojis
  const reg = await tg('register', '--name', 'fix loader', '--emoji', '🐛', '--project-emoji', '🧬');
  assert.match(reg.stdout, /registered as: 🧬🐛 fix loader\s+\(own Telegram thread\)/);
  assert.equal(calls('createForumTopic')[0].params.name, '🧬🐛 fix loader');

  // --- Stop hook: connected but deaf → blocked
  const hookInput = JSON.stringify({ session_id: 'e2e-session-1', stop_hook_active: false });
  const blocked = await runHook(hookInput);
  assert.equal(JSON.parse(blocked).decision, 'block');
  assert.equal(await runHook(JSON.stringify({ session_id: 'e2e-session-1', stop_hook_active: true })), '', 'never loops');
  assert.equal(await runHook(JSON.stringify({ session_id: 'some-other-session' })), '', 'unconnected sessions are left alone');

  // --- listen; a stranger writing into the thread changes nothing; the owner's message wakes it
  const listener = spawn('node', [path.join(ROOT, 'src/cli.js'), 'listen'], { env });
  let heard = '';
  listener.stdout.on('data', (c) => (heard += c));
  const listenerDone = new Promise((r) => listener.once('exit', r));
  await until(async () => (await tg('status')).stdout.includes('🟢 🧬🐛 fix loader'), 'listener armed');
  assert.equal(await runHook(hookInput), '', 'listening session may stop');

  await handled(inject(STRANGER, 'mallory', 'delete everything', { message_thread_id: 77, is_topic_message: true }));
  assert.equal(heard, '');
  assert.match((await tg('status')).stdout, /🟢 🧬🐛 fix loader/, 'still listening, nothing queued');

  inject(OWNER, 'Owner', 'rerun with seed 2', { message_thread_id: 77, is_topic_message: true });
  await listenerDone;
  assert.match(heard, /TELEGRAM — message from your user for this session \(🧬🐛 fix loader\)/);
  assert.match(heard, /rerun with seed 2/);
  assert.match(heard, /re-arm/);
  assert.doesNotMatch(heard, /delete everything/);
  await until(() => calls('setMessageReaction').some((c) => c.params.reaction[0].emoji === '👀'), 'seen reaction');

  // --- reply goes to the thread, signed
  const sent = await tg('send', 'Done. loss 0.41 → 0.37');
  assert.equal(sent.stdout.trim(), 'sent');
  const reply = calls('sendMessage').at(-1).params;
  assert.equal(reply.message_thread_id, 77);
  assert.ok(reply.text.startsWith('<b>🧬🐛 fix loader</b>\nDone. loss 0.41'));

  // --- files are staged through the private outbox and cleaned up afterwards
  const file = path.join(home, 'result.csv');
  fs.writeFileSync(file, 'a,b\n1,2\n');
  const sentFile = await tg('send-file', file, '--caption', 'results');
  assert.match(sentFile.stdout, /sent result\.csv as document/);
  assert.ok(calls('sendDocument')[0].params.raw.includes('a,b'));
  await until(() => fs.readdirSync(path.join(home, 'outbox')).length === 0, 'outbox cleaned');

  // --- the daemon refuses to upload anything that was not staged by the CLI
  const direct = await rawApi('POST', '/send-file', { sessionId: 'e2e-session-1', path: path.join(home, 'config.json') });
  assert.match(direct.error, /not staged/);

  // --- disconnect
  assert.match((await tg('bye')).stdout, /disconnected/);
  assert.match((await tg('listen')).stdout, /no longer connected/);
  assert.ok(calls('editForumTopic').some((c) => c.params.name === '💤 🧬🐛 fix loader'));

  // --- nothing sensitive in the log
  const log = fs.readFileSync(path.join(home, 'daemon.log'), 'utf8');
  assert.ok(!log.includes(TOKEN) && !log.includes('rerun with seed 2') && !log.includes('delete everything'));
});

function runHook(input) {
  return new Promise((resolve) => {
    const child = execFile('node', [path.join(ROOT, 'src/cli.js'), 'hook-stop'], { env, timeout: 10000 }, (_e, stdout) => resolve(stdout.trim()));
    child.stdin.end(input);
  });
}

function rawApi(method, route, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({ socketPath: path.join(home, 'daemon.sock'), path: route, method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

// ------------------------------------------------------------------ prompt relay through the real hooks

function runCli(args, stdinText) {
  const child = spawn('node', [path.join(ROOT, 'src/cli.js'), ...args], { env });
  let stdout = '';
  child.stdout.on('data', (c) => (stdout += c));
  const done = new Promise((resolve) => child.once('exit', (code) => resolve({ code, stdout: stdout.trim() })));
  child.stdin.end(stdinText ?? '');
  return done;
}

const lastQuestion = () => calls('sendMessage').filter((c) => c.params.reply_markup?.inline_keyboard?.flat().some((b) => b.callback_data?.startsWith('q:'))).at(-1);
const buttons = (q) => Object.fromEntries(q.params.reply_markup.inline_keyboard.flat().map((b) => [b.text, b.callback_data]));

test('permission prompts: Allow and Deny from the owner, nothing from strangers, timeout falls back to the laptop', async () => {
  assert.match((await tg('register', '--session', 'e2e-session-2', '--name', 'relay test', '--emoji', '🔐', '--project-emoji', '🧬')).stdout, /registered as/);
  const seen = calls('sendMessage').length;
  const hookInput = (tool_name, tool_input) => JSON.stringify({ session_id: 'e2e-session-2', hook_event_name: 'PermissionRequest', tool_name, tool_input, permission_mode: 'default' });

  // allow
  let hook = runCli(['hook-permission'], hookInput('Bash', { command: 'npm publish', description: 'publish the package' }));
  await until(() => calls('sendMessage').length > seen && lastQuestion(), 'permission question sent');
  let q = lastQuestion();
  assert.match(q.params.text, /Permission/);
  assert.match(q.params.text, /npm publish/);
  assert.deepEqual(Object.keys(buttons(q)), ['✅ Allow', '❌ Deny']);
  injectTap(buttons(q)['❌ Deny'], STRANGER);
  await handled(injectTap(buttons(q)['✅ Allow'], STRANGER));
  assert.equal(calls('answerCallbackQuery').length, 0, 'strangers get nothing, not even a toast');
  injectTap(buttons(q)['✅ Allow']);
  let r = await hook;
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  await until(() => calls('editMessageText').some((c) => c.params.text.endsWith('→ ✅ Allow')), 'outcome shown in chat');

  // deny
  hook = runCli(['hook-permission'], hookInput('Write', { file_path: '/etc/hosts', content: 'x' }));
  await until(() => lastQuestion() !== q, 'second question sent');
  q = lastQuestion();
  injectTap(buttons(q)['❌ Deny']);
  r = await hook;
  const denied = JSON.parse(r.stdout).hookSpecificOutput.decision;
  assert.equal(denied.behavior, 'deny');
  assert.match(denied.message, /Telegram/);

  // Claude's own multiple-choice question, answered by button
  hook = runCli(['hook-permission'], hookInput('AskUserQuestion', { questions: [{ header: 'Auth', question: 'Which auth approach?', options: [{ label: 'NextAuth', description: 'built in' }, { label: 'Clerk', description: 'managed' }], multiSelect: false }] }));
  await until(() => lastQuestion() !== q, 'relayed question sent');
  q = lastQuestion();
  assert.match(q.params.text, /Which auth approach/);
  assert.deepEqual(Object.keys(buttons(q)), ['NextAuth', 'Clerk']);
  injectTap(buttons(q)['Clerk']);
  r = await hook;
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.decision.message, /Auth: Clerk/);

  // unconnected session or unknown tool input: silent
  r = await runCli(['hook-permission'], hookInput.call(null, 'Bash', { command: 'ls' }).replace('e2e-session-2', 'never-registered'));
  assert.equal(r.stdout, '');
});

test('tg ask: the owner types the answer as a reply; the Notification hook alerts once', async () => {
  const before = calls('sendMessage').length;
  const asking = runCli(['ask', 'Which branch?', '--option', 'main', '--option', 'dev', '--session', 'e2e-session-2']);
  await until(() => calls('sendMessage').length > before && lastQuestion(), 'question sent');
  const q = lastQuestion();
  assert.deepEqual(Object.keys(buttons(q)), ['main', 'dev']);
  inject(OWNER, 'Owner', 'release/3.0', { reply_to_message: { message_id: q.result.message_id, text: 'Which branch?' } });
  const r = await asking;
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'release/3.0');

  const n = calls('sendMessage').length;
  await runCli(['hook-notify'], JSON.stringify({ session_id: 'e2e-session-2', hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }));
  await until(() => calls('sendMessage').length === n + 1, 'alert sent');
  assert.match(calls('sendMessage').at(-1).params.text, /waiting at the laptop/);
  await runCli(['hook-notify'], JSON.stringify({ session_id: 'e2e-session-2', notification_type: 'idle_prompt' }));
  await sleep(300);
  assert.equal(calls('sendMessage').length, n + 1, 'no repeat within the quiet period');
  // the asking process dies (Claude's Bash timeout, Ctrl-C): the phone must not show a live question
  const n2 = calls('sendMessage').length;
  const child = spawn('node', [path.join(ROOT, 'src/cli.js'), 'ask', 'Still there?', '--option', 'yes', '--session', 'e2e-session-2'], { env });
  await until(() => calls('sendMessage').length > n2 && lastQuestion(), 'question sent');
  const orphan = lastQuestion();
  child.kill('SIGKILL');
  await until(() => calls('editMessageText').some((c) => c.params.message_id === orphan.result.message_id && /stopped waiting/.test(c.params.text)), 'question closed after the asker died');
  await handled(injectTap(buttons(orphan).yes));
  assert.match(calls('answerCallbackQuery').at(-1).params.text, /expired/);
  await tg('bye', '--session', 'e2e-session-2');
});
