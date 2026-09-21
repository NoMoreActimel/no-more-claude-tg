import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Bridge } from '../src/bridge.js';
import { DEFAULT_STATE } from '../src/store.js';

const OWNER = 111;
const STRANGER = 666;

class FakeTelegram {
  constructor({ topics = false } = {}) {
    this.topics = topics;
    this.calls = [];
    this.nextId = 1000;
    this.nextThread = 50;
  }
  async call(method, params = {}) {
    this.calls.push({ method, params });
    if (method === 'getMe') return { username: 'testbot', has_topics_enabled: this.topics };
    if (method === 'createForumTopic') return { message_thread_id: this.nextThread++, name: params.name };
    if (method === 'sendMessage') return { message_id: this.nextId++ };
    return true;
  }
  async upload(method, params) {
    this.calls.push({ method, params });
    return { message_id: this.nextId++ };
  }
  async download(fileId, dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, 'x');
    return { path: dest, size: 1 };
  }
  sent() {
    return this.calls.filter((c) => c.method === 'sendMessage');
  }
  reset() {
    this.calls = [];
  }
}

function make({ ownerId = OWNER, topics = false, expectedUsername = 'Owner', transcribe = null } = {}) {
  const tg = new FakeTelegram({ topics });
  const config = { token: 't', ownerId, expectedUsername };
  const state = structuredClone(DEFAULT_STATE);
  const bridge = new Bridge({
    tg,
    config,
    state,
    transcribe,
    typing: false,
    inboxDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tg-test-')),
    saveConfig: () => {},
    saveState: () => {},
    isPidAlive: (pid) => pid !== 4242,
  });
  return { tg, config, state, bridge };
}

let updateId = 1;
const dm = (fromId, text, extra = {}) => ({
  update_id: updateId++,
  message: { message_id: 5000 + updateId, from: { id: fromId, is_bot: false, username: fromId === OWNER ? 'Owner' : 'mallory' }, chat: { id: fromId, type: 'private' }, text, ...extra },
});

const reg = (bridge, id, name = 'fix loader', extra = {}) => bridge.register({ sessionId: id, name, emoji: '🐛', projectEmoji: '🧬', project: '/p/alpha', pid: 1, ...extra });

// ------------------------------------------------------------------ security

test('a stranger gets no reply and reaches no session', async () => {
  const { tg, bridge, state } = make();
  await reg(bridge, 's1');
  tg.reset();
  for (const text of ['hello', '/start', '/sessions', '/end', 'rm -rf ~']) await bridge.handleUpdate(dm(STRANGER, text));
  assert.equal(tg.calls.length, 0, 'not a single Telegram API call is made for a stranger');
  assert.equal(state.sessions.s1.queue.length, 0);
  assert.equal(bridge.stats.dropped, 5);
});

test('a stranger cannot spoof the owner via chat id, a group, or a forged thread', async () => {
  const { tg, bridge, state } = make({ topics: true });
  await reg(bridge, 's1');
  const thread = state.sessions.s1.threadId;
  tg.reset();
  // stranger writing "in" the owner's thread id
  await bridge.handleUpdate(dm(STRANGER, 'do it', { message_thread_id: thread, is_topic_message: true }));
  // owner's user id but in a group chat (e.g. bot added to a group the owner is in)
  await bridge.handleUpdate({ update_id: updateId++, message: { message_id: 1, from: { id: OWNER, is_bot: false }, chat: { id: -100123, type: 'supergroup' }, text: 'do it' } });
  // a bot claiming the owner's id
  await bridge.handleUpdate({ update_id: updateId++, message: { message_id: 2, from: { id: OWNER, is_bot: true }, chat: { id: OWNER, type: 'private' }, text: 'do it' } });
  assert.equal(state.sessions.s1.queue.length, 0);
  assert.deepEqual(tg.calls.map((c) => c.method), ['leaveChat'], 'the only reaction is leaving the group');
});

test('callback queries from strangers are ignored', async () => {
  const { tg, bridge, state } = make();
  await reg(bridge, 's1');
  tg.reset();
  await bridge.handleUpdate({ update_id: updateId++, callback_query: { id: 'x', from: { id: STRANGER, is_bot: false }, data: 'use:s1' } });
  assert.equal(tg.calls.length, 0);
  assert.equal(state.activeSessionId, null);
});

test('unpaired bot answers nobody and nothing can register', async () => {
  const { tg, bridge } = make({ ownerId: null });
  await bridge.handleUpdate(dm(OWNER, 'hello'));
  await bridge.handleUpdate(dm(STRANGER, '/start'));
  assert.equal(tg.calls.length, 0);
  await assert.rejects(() => reg(bridge, 's1'), /not paired/);
});

test('pairing needs the right code AND the expected username', async () => {
  const { tg, bridge, config } = make({ ownerId: null });
  const { code } = bridge.startPairing();
  await bridge.handleUpdate(dm(STRANGER, `/start ${code}`)); // right code, wrong account
  assert.equal(config.ownerId, null);
  await bridge.handleUpdate(dm(OWNER, '/start WRONGCODE1'));
  assert.equal(config.ownerId, null);
  assert.equal(tg.sent().length, 0, 'failed attempts get no response');
  await bridge.handleUpdate(dm(OWNER, `/start ${code}`));
  assert.equal(config.ownerId, OWNER);
  assert.equal(tg.sent().length, 1);
});

test('pairing code burns after repeated wrong guesses and cannot be reused', async () => {
  const { bridge, config } = make({ ownerId: null, expectedUsername: null });
  const { code } = bridge.startPairing();
  for (let i = 0; i < 3; i++) await bridge.handleUpdate(dm(STRANGER, `GUESS${i}AAAA`));
  await bridge.handleUpdate(dm(STRANGER, code)); // locked out even with the right code
  assert.equal(config.ownerId, null);
  await bridge.handleUpdate(dm(OWNER, code));
  assert.equal(config.ownerId, OWNER);
  // once paired, a fresh pairing cannot be opened without an explicit reset
  assert.throws(() => bridge.startPairing(), /already paired/);
});

test('an expired pairing code is rejected', async () => {
  let t = 0;
  const tg = new FakeTelegram();
  const config = { ownerId: null };
  const bridge = new Bridge({ tg, config, state: structuredClone(DEFAULT_STATE), saveConfig() {}, saveState() {}, inboxDir: os.tmpdir(), typing: false, now: () => t });
  const { code } = bridge.startPairing();
  t += 11 * 60 * 1000;
  await bridge.handleUpdate(dm(OWNER, code));
  assert.equal(config.ownerId, null);
});

// ------------------------------------------------------------------ routing

test('thread mode: a message in a session thread reaches that session only', async () => {
  const { tg, bridge, state } = make({ topics: true });
  await reg(bridge, 's1', 'fix loader');
  await reg(bridge, 's2', 'eval report', { project: '/p/beta', projectEmoji: '🎵' });
  assert.notEqual(state.sessions.s1.threadId, state.sessions.s2.threadId);
  const topicNames = tg.calls.filter((c) => c.method === 'createForumTopic').map((c) => c.params.name);
  assert.deepEqual(topicNames, ['🧬🐛 fix loader', '🎵🐛 eval report']);

  const waiting = bridge.listen('s2').promise;
  await bridge.handleUpdate(dm(OWNER, 'rerun with seed 2', { message_thread_id: state.sessions.s2.threadId, is_topic_message: true }));
  const got = await waiting;
  assert.equal(got.messages[0].text, 'rerun with seed 2');
  assert.equal(state.sessions.s1.queue.length, 0);
});

test('single-chat mode: reply routing, then the picker, then ambiguity asks', async () => {
  const { tg, bridge, state } = make();
  await reg(bridge, 's1', 'fix loader');
  await reg(bridge, 's2', 'eval report');
  const { messageIds } = await bridge.sendText('s2', 'Report ready');
  await bridge.handleUpdate(dm(OWNER, 'thanks', { reply_to_message: { message_id: messageIds[0], text: 'Report ready' } }));
  assert.equal(state.sessions.s2.queue.length, 1);
  assert.equal(state.sessions.s2.queue[0].replyTo, 'Report ready');

  tg.reset();
  await bridge.handleUpdate(dm(OWNER, 'which one am I talking to'));
  assert.equal(state.sessions.s1.queue.length, 0, 'ambiguous text is not guessed');
  assert.ok(tg.sent()[0].params.reply_markup, 'a picker is offered instead');

  await bridge.handleUpdate({ update_id: updateId++, callback_query: { id: 'c', from: { id: OWNER, is_bot: false }, message: { chat: { id: OWNER, type: 'private' } }, data: 'use:s1' } });
  await bridge.handleUpdate(dm(OWNER, 'now this goes to s1'));
  assert.equal(state.sessions.s1.queue.length, 1);
});

test('messages queue while the session is busy and survive until acked', async () => {
  const { tg, bridge, state } = make();
  await reg(bridge, 's1');
  tg.reset();
  await bridge.handleUpdate(dm(OWNER, 'one'));
  await bridge.handleUpdate(dm(OWNER, 'two'));
  assert.deepEqual(tg.calls.map((c) => c.params.reaction?.[0].emoji), ['✍', '✍']);

  const first = await bridge.listen('s1').promise;
  assert.deepEqual(first.messages.map((m) => m.text), ['one', 'two']);
  const again = await bridge.listen('s1').promise; // listener died before acking: nothing is lost
  assert.equal(again.messages.length, 2);

  await bridge.ack('s1', first.messages[1].seq);
  assert.equal(state.sessions.s1.queue.length, 0);
  assert.equal(tg.calls.filter((c) => c.params.reaction?.[0].emoji === '👀').length, 2);
});

test('a second listener is refused instead of stealing messages', async () => {
  const { bridge } = make();
  await reg(bridge, 's1');
  const first = bridge.listen('s1');
  assert.deepEqual(await bridge.listen('s1').promise, { duplicate: true });
  first.cancel();
  assert.equal(bridge.listeners.size, 0);
});

test('every outgoing message is signed by the bridge, and html in the body is escaped', async () => {
  const { tg, bridge } = make();
  await reg(bridge, 's1');
  tg.reset();
  await bridge.sendText('s1', 'done <script>alert(1)</script> `x<y`');
  const text = tg.sent()[0].params.text;
  assert.ok(text.startsWith('<b>🧬🐛 fix loader</b>\n'));
  assert.ok(text.includes('&lt;script&gt;') && text.includes('<code>x&lt;y</code>'));
});

test('project emoji is fixed by the first session of a project', async () => {
  const { bridge } = make();
  await reg(bridge, 's1');
  const r = await reg(bridge, 's2', 'second task', { projectEmoji: '🚀' });
  assert.equal(r.signature, '🧬🐛 second task');
  assert.equal(r.projectEmojiReused, true);
});

test('a project emoji can be pinned up front, and changing it renames connected sessions', async () => {
  const { tg, bridge, state } = make({ topics: true });
  await bridge.setProjectEmoji('/p/alpha', '🔥');
  const r = await reg(bridge, 's1'); // asks for 🧬, but the pinned one wins
  assert.equal(r.signature, '🔥🐛 fix loader');
  const changed = await bridge.setProjectEmoji('/p/alpha', '📄');
  assert.deepEqual(changed.renamed, ['📄🐛 fix loader']);
  assert.equal(state.sessions.s1.projectEmoji, '📄');
  assert.equal(tg.calls.filter((c) => c.method === 'editForumTopic').at(-1).params.name, '📄🐛 fix loader');
  await assert.rejects(() => bridge.setProjectEmoji('/p/alpha', 'fire'), /one emoji/);
});

test('names are kept short and emoji-free; duplicates get a number', async () => {
  const { bridge } = make();
  await assert.rejects(() => reg(bridge, 'a', 'this name has far too many words'), /too (many|long)/);
  await assert.rejects(() => reg(bridge, 'a', '🐛 loader'), /emoji/);
  await assert.rejects(() => bridge.register({ sessionId: 'a', name: 'ok', emoji: 'bug', projectEmoji: '🧬' }), /one emoji/);
  await reg(bridge, 's1');
  assert.equal((await reg(bridge, 's2')).signature, '🧬🐛 fix loader 2');
});

test('a session whose Claude process died is ended and its listener released', async () => {
  const { bridge, state } = make({ topics: true });
  await reg(bridge, 's1', 'fix loader', { pid: 4242 });
  const waiting = bridge.listen('s1').promise;
  await bridge.sweep();
  assert.equal((await waiting).ended, true);
  assert.ok(state.sessions.s1.endedAt);
  await bridge.handleUpdate(dm(OWNER, 'anyone?', { message_thread_id: state.sessions.s1.threadId, is_topic_message: true }));
  assert.equal(state.sessions.s1.queue.length, 0);
});

test('/end from Telegram disconnects the session; unknown slash text is passed through', async () => {
  const { bridge, state } = make();
  await reg(bridge, 's1');
  await bridge.handleUpdate(dm(OWNER, '/compact please'));
  assert.equal(state.sessions.s1.queue[0].text, '/compact please');
  await bridge.handleUpdate(dm(OWNER, '/end'));
  assert.ok(state.sessions.s1.endedAt);
});

test('voice is transcribed, echoed back, and delivered as text', async () => {
  const { tg, bridge, state } = make({ transcribe: async () => ' run the tests again ' });
  await reg(bridge, 's1');
  tg.reset();
  await bridge.handleUpdate(dm(OWNER, undefined, { voice: { file_id: 'v1' } }));
  assert.equal(state.sessions.s1.queue[0].text, 'run the tests again');
  assert.equal(state.sessions.s1.queue[0].voice, true);
  assert.ok(tg.sent()[0].params.text.includes('run the tests again'), 'transcript is echoed so mis-hearings are visible');
});

test('photos and documents land in the private inbox and are passed as paths', async () => {
  const { bridge, state } = make();
  await reg(bridge, 's1');
  await bridge.handleUpdate(dm(OWNER, undefined, { caption: 'look', photo: [{ file_id: 'small' }, { file_id: 'big' }], document: { file_id: 'd', file_name: '../../etc/passwd' } }));
  const item = state.sessions.s1.queue[0];
  assert.equal(item.text, 'look');
  assert.equal(item.attachments.length, 2);
  for (const p of item.attachments) assert.ok(p.startsWith(bridge.inboxDir) && !p.includes('..'), p);
});
