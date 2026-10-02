import crypto from 'node:crypto';
import path from 'node:path';
import { Pairing, isFromOwner } from './auth.js';
import { chunkText, escapeHtml, renderBody, safeFileName, signature, validateEmoji, validateName } from './format.js';

const LISTEN_TIMEOUT_MS = 25 * 60 * 1000;
const TYPING_MAX_MS = 3 * 60 * 1000;
const TOPIC_CHECK_TTL_MS = 60 * 1000;
const STALE_QUEUE_MS = 2 * 60 * 1000;
const MSG_MAP_LIMIT = 600;
const CAPTION_LIMIT = 1000;
const ASK_DEFAULT_MS = 9 * 60 * 1000 + 30 * 1000; // under Claude Code's 10-minute hook timeout
const ASK_MAX_MS = 60 * 60 * 1000;
const ASK_MAX_OPTIONS = 12;
const ASK_TEXT_LIMIT = 2500; // Telegram messages cap at 4096 chars after HTML escaping
const NOTIFY_QUIET_MS = 10 * 60 * 1000;
const NOTIFY_LABELS = {
  permission_prompt: 'a permission prompt it could not relay',
  idle_prompt: 'your next instruction',
  elicitation_dialog: 'a form from an MCP server',
  elicitation_url_dialog: 'a login in the browser',
  agent_needs_input: 'input for a subagent',
};

const HELP = [
  '<b>Claude Code bridge</b>',
  'Each Claude session that ran <code>/tg</code> shows up here.',
  '',
  '• Thread mode: write inside a session thread.',
  '• Single chat: a plain message goes to the session that wrote last; reply to a message to pick another, or use /sessions.',
  '• Text, voice, photos and files all work.',
  '',
  '/sessions — who is connected',
  '/status — bridge health',
  '/ping — is this session alive (inside a thread)',
  '/end — disconnect this session',
  '/clean — delete threads of ended sessions',
].join('\n');

function defaultIsPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * All bridge behaviour, with Telegram and the filesystem injected so it can be tested offline.
 * Security invariant: nothing reaches a session unless isFromOwner() passed for that update.
 */
export class Bridge {
  constructor({ tg, config, saveConfig, state, saveState, inboxDir, log = () => {}, transcribe = null, isPidAlive = defaultIsPidAlive, onLiveCountChange = () => {}, typing = true, now = Date.now }) {
    Object.assign(this, { tg, config, saveConfig, state, saveState, inboxDir, log, transcribe, isPidAlive, onLiveCountChange, now });
    this.typingEnabled = typing;
    this.pairing = new Pairing({ now });
    this.listeners = new Map();
    this.typing = new Map();
    this.leftAt = new Map();
    this.asks = new Map(); // askId -> pending question for the owner
    this.notified = new Map(); // `${sessionId}:${type}` -> last alert time
    this.topics = false;
    this.topicsCheckedAt = 0;
    this.botUsername = null;
    this.startedAt = now();
    this.stats = { dropped: 0, delivered: 0, sent: 0 };
  }

  // ---------------------------------------------------------------- helpers

  get paired() {
    return Boolean(this.config.ownerId);
  }

  requirePaired() {
    if (!this.paired) throw new Error('bot is not paired with your Telegram account yet — run: tg pair');
  }

  liveSessions() {
    return Object.values(this.state.sessions).filter((s) => !s.endedAt);
  }

  live(sessionId) {
    const s = this.state.sessions[sessionId];
    return s && !s.endedAt ? s : null;
  }

  requireLive(sessionId) {
    const s = this.live(sessionId);
    if (!s) throw new Error('this session is not registered — run: tg register --name … --emoji … --project-emoji …');
    return s;
  }

  sessionByThread(threadId) {
    return Object.values(this.state.sessions).find((s) => s.threadId === threadId) || null;
  }

  sessionByMessage(messageId) {
    const hit = this.state.msgMap.find((m) => m[0] === messageId);
    return hit ? this.state.sessions[hit[1]] || null : null;
  }

  remember(messageId, sessionId) {
    this.state.msgMap.push([messageId, sessionId]);
    if (this.state.msgMap.length > MSG_MAP_LIMIT) this.state.msgMap.splice(0, this.state.msgMap.length - MSG_MAP_LIMIT);
  }

  // A plain (non-reply) message goes to whoever spoke last, so it follows the conversation.
  spoke(sessionId) {
    this.state.activeSessionId = sessionId;
  }

  liveChanged() {
    this.onLiveCountChange(this.liveSessions().length);
  }

  async topicsEnabled(force = false) {
    if (!force && this.now() - this.topicsCheckedAt < TOPIC_CHECK_TTL_MS) return this.topics;
    try {
      const me = await this.tg.call('getMe');
      this.topics = Boolean(me.has_topics_enabled);
      this.botUsername = me.username || null;
      this.topicsCheckedAt = this.now();
    } catch (e) {
      this.log(`getMe failed: ${e.message}`);
    }
    return this.topics;
  }

  async say(threadId, html, extra = {}) {
    const params = { chat_id: this.config.ownerId, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra };
    if (threadId) params.message_thread_id = threadId;
    return this.tg.call('sendMessage', params);
  }

  async reply(msg, html, extra = {}) {
    try {
      return await this.say(msg.message_thread_id || null, html, extra);
    } catch (e) {
      this.log(`reply failed: ${e.message}`);
      return null;
    }
  }

  async react(messageId, emoji) {
    try {
      await this.tg.call('setMessageReaction', { chat_id: this.config.ownerId, message_id: messageId, reaction: [{ type: 'emoji', emoji }] });
    } catch (e) {
      this.log(`reaction failed: ${e.message}`);
    }
  }

  // ---------------------------------------------------------------- threads

  async ensureThread(s) {
    if (s.threadId) return s.threadId;
    if (!(await this.topicsEnabled())) return null;
    try {
      const topic = await this.tg.call('createForumTopic', { chat_id: this.config.ownerId, name: signature(s) });
      s.threadId = topic.message_thread_id;
      this.saveState();
    } catch (e) {
      this.log(`createForumTopic failed: ${e.message}`);
    }
    return s.threadId || null;
  }

  async renameThread(s, name) {
    if (!s.threadId) return;
    try {
      await this.tg.call('editForumTopic', { chat_id: this.config.ownerId, message_thread_id: s.threadId, name });
    } catch (e) {
      if (!/not.modified/i.test(e.message)) this.log(`editForumTopic failed: ${e.message}`);
    }
  }

  /** Run a send; if the user deleted the thread in Telegram, make a new one and retry once. */
  async inThread(s, send) {
    const threadId = await this.ensureThread(s);
    try {
      return await send(threadId);
    } catch (e) {
      if (!threadId || !/thread|topic/i.test(e.message)) throw e;
      s.threadId = null;
      this.saveState();
      return send(await this.ensureThread(s));
    }
  }

  // ---------------------------------------------------------------- session API (called from the local CLI)

  startPairing({ reset = false } = {}) {
    if (this.paired && !reset) throw new Error('already paired — use `tg pair --reset` to pair a different account');
    if (reset) {
      this.config.ownerId = null;
      this.saveConfig();
    }
    return this.pairing.start();
  }

  uniqueName(s) {
    const taken = new Set(this.liveSessions().filter((o) => o.id !== s.id).map((o) => signature(o)));
    let name = s.name;
    for (let n = 2; taken.has(signature({ ...s, name })); n++) name = `${s.name} ${n}`;
    return name;
  }

  async register({ sessionId, name, emoji, projectEmoji, project, pid }) {
    this.requirePaired();
    if (!sessionId) throw new Error('sessionId is required');
    const cleanName = validateName(name);
    const cleanEmoji = validateEmoji(emoji, '--emoji');
    const projectKey = project || 'unknown';
    let pe = this.state.projectEmojis[projectKey];
    if (!pe) {
      pe = validateEmoji(projectEmoji, '--project-emoji');
      this.state.projectEmojis[projectKey] = pe;
    }

    const s = this.state.sessions[sessionId] || { id: sessionId, queue: [], threadId: null, createdAt: this.now() };
    const wasLive = Boolean(this.state.sessions[sessionId]) && !s.endedAt;
    Object.assign(s, { name: cleanName, emoji: cleanEmoji, projectEmoji: pe, project: projectKey, pid: pid || null, endedAt: null, registeredAt: this.now() });
    s.name = this.uniqueName(s);
    this.state.sessions[sessionId] = s;
    this.saveState();

    if (s.threadId) await this.renameThread(s, signature(s));
    const hint = (await this.topicsEnabled()) ? '' : '\n<i>Reply to my messages to talk to this session.</i>';
    await this.inThread(s, (threadId) =>
      this.say(threadId, `🟢 <b>${escapeHtml(signature(s))}</b> ${wasLive ? 'renamed' : 'connected'}\n<code>${escapeHtml(path.basename(projectKey))}</code>${hint}`)
    ).then((m) => this.remember(m.message_id, s.id));
    this.saveState();
    this.liveChanged();
    return { signature: signature(s), threadMode: Boolean(s.threadId), projectEmoji: pe, projectEmojiReused: Boolean(projectEmoji) && pe !== projectEmoji };
  }

  /** Pin (or change) a project's emoji; sessions of that project that are already connected are renamed. */
  async setProjectEmoji(project, emoji) {
    if (!project) throw new Error('project path is required');
    const clean = validateEmoji(emoji, 'emoji');
    this.state.projectEmojis[project] = clean;
    const renamed = [];
    for (const s of this.liveSessions().filter((x) => x.project === project && x.projectEmoji !== clean)) {
      s.projectEmoji = clean;
      s.name = this.uniqueName(s);
      renamed.push(signature(s));
      await this.renameThread(s, signature(s));
    }
    this.saveState();
    return { project, emoji: clean, renamed };
  }

  async end(sessionId, reason) {
    const s = this.live(sessionId);
    if (!s) return false;
    s.endedAt = this.now();
    s.queue = [];
    if (this.state.activeSessionId === sessionId) this.state.activeSessionId = null;
    this.saveState();
    this.stopTyping(sessionId);
    for (const a of [...this.asks.values()].filter((x) => x.sessionId === sessionId)) {
      a.resolve({ ended: true });
      this.closeAsk(a, '🚫 session disconnected — not delivered').catch(() => {});
    }
    const l = this.listeners.get(sessionId);
    if (l) {
      this.listeners.delete(sessionId);
      clearTimeout(l.timer);
      l.resolve({ ended: true, reason });
    }
    try {
      await this.say(s.threadId, `👋 <b>${escapeHtml(signature(s))}</b> disconnected — ${escapeHtml(reason)}`);
    } catch (e) {
      this.log(`goodbye failed: ${e.message}`);
    }
    await this.renameThread(s, `💤 ${signature(s)}`);
    this.liveChanged();
    return true;
  }

  async sendText(sessionId, text) {
    this.requirePaired();
    const s = this.requireLive(sessionId);
    const body = String(text || '').trim();
    if (!body) throw new Error('empty message');
    const sig = signature(s);
    const ids = [];
    for (const chunk of chunkText(body)) {
      const m = await this.inThread(s, async (threadId) => {
        try {
          return await this.say(threadId, `<b>${escapeHtml(sig)}</b>\n${renderBody(chunk)}`);
        } catch (e) {
          if (e.code !== 400 || !/parse|entit/i.test(e.message)) throw e;
          const params = { chat_id: this.config.ownerId, text: `${sig}\n${chunk}`, link_preview_options: { is_disabled: true } };
          if (threadId) params.message_thread_id = threadId;
          return this.tg.call('sendMessage', params);
        }
      });
      ids.push(m.message_id);
      this.remember(m.message_id, s.id);
    }
    this.spoke(s.id);
    this.stopTyping(s.id);
    this.stats.sent += ids.length;
    this.saveState();
    return { messageIds: ids, signature: sig };
  }

  async sendFile(sessionId, filePath, { caption = '', kind = 'document', filename } = {}) {
    this.requirePaired();
    const s = this.requireLive(sessionId);
    const sig = signature(s);
    const cap = `<b>${escapeHtml(sig)}</b>${caption ? `\n${escapeHtml(caption).slice(0, CAPTION_LIMIT)}` : ''}`;
    const method = kind === 'photo' ? 'sendPhoto' : 'sendDocument';
    const m = await this.inThread(s, (threadId) => {
      const params = { chat_id: this.config.ownerId, caption: cap, parse_mode: 'HTML' };
      if (threadId) params.message_thread_id = threadId;
      return this.tg.upload(method, params, kind === 'photo' ? 'photo' : 'document', filePath, filename);
    });
    this.remember(m.message_id, s.id);
    this.spoke(s.id);
    this.stopTyping(s.id);
    this.stats.sent += 1;
    this.saveState();
    return { messageId: m.message_id, signature: sig };
  }

  /**
   * Long-poll for the session's next message(s). Items stay queued until ack(), so a listener that
   * dies between receiving and printing loses nothing.
   */
  listen(sessionId) {
    const s = this.live(sessionId);
    const done = (value) => ({ promise: Promise.resolve(value), cancel() {} });
    if (!s) return done({ ended: true });
    if (s.queue.length) return done({ messages: s.queue.slice(), signature: signature(s) });
    if (this.listeners.has(sessionId)) return done({ duplicate: true });
    let entry;
    const promise = new Promise((resolve) => {
      entry = {
        resolve,
        since: this.now(),
        timer: setTimeout(() => {
          if (this.listeners.get(sessionId) === entry) this.listeners.delete(sessionId);
          resolve({ timeout: true });
        }, LISTEN_TIMEOUT_MS),
      };
      entry.timer.unref?.();
      this.listeners.set(sessionId, entry);
    });
    return {
      promise,
      cancel: () => {
        if (this.listeners.get(sessionId) !== entry) return;
        clearTimeout(entry.timer);
        this.listeners.delete(sessionId);
      },
    };
  }

  async ack(sessionId, upTo) {
    const s = this.live(sessionId);
    if (!s) return { acked: 0 };
    const got = s.queue.filter((i) => i.seq <= upTo);
    s.queue = s.queue.filter((i) => i.seq > upTo);
    this.saveState();
    this.stats.delivered += got.length;
    for (const item of got) await this.react(item.messageId, '👀');
    if (got.length) this.startTyping(s);
    return { acked: got.length };
  }

  sessionState(sessionId) {
    const s = this.live(sessionId);
    if (!s) return { registered: false };
    return { registered: true, listening: this.listeners.has(sessionId), queued: s.queue.length, signature: signature(s) };
  }

  status() {
    return {
      paired: this.paired,
      pairingOpen: this.pairing.active,
      threadMode: this.topics,
      bot: this.botUsername,
      uptimeSec: Math.round((this.now() - this.startedAt) / 1000),
      stats: this.stats,
      sessions: this.liveSessions().map((s) => ({
        id: s.id,
        signature: signature(s),
        project: s.project,
        listening: this.listeners.has(s.id),
        queued: s.queue.length,
        thread: Boolean(s.threadId),
        asking: [...this.asks.values()].filter((a) => a.sessionId === s.id).length,
      })),
    };
  }

  // ---------------------------------------------------------------- questions for the owner

  /**
   * Ask the owner something with buttons, in the session's chat. Resolves with {choice, index} on a tap,
   * {text} on a typed reply to the question, {timeout: true} otherwise. Both answer paths sit behind
   * isFromOwner(), so nobody but the paired owner can answer — this is what permission relays rely on.
   */
  ask(sessionId, { text, options = [], timeoutMs = ASK_DEFAULT_MS, kind = 'question', allowText = true } = {}) {
    this.requirePaired();
    const s = this.requireLive(sessionId);
    const labels = options.map((o) => String(typeof o === 'string' ? o : o?.label ?? '').trim()).filter(Boolean).slice(0, ASK_MAX_OPTIONS);
    if (!String(text || '').trim()) throw new Error('question text is required');
    if (!labels.length && !allowText) throw new Error('a question needs options or a typed answer');
    const id = crypto.randomBytes(4).toString('hex');
    const perRow = labels.every((l) => l.length <= 14) ? 2 : 1;
    const inline_keyboard = [];
    labels.forEach((label, i) => {
      if (i % perRow === 0) inline_keyboard.push([]);
      inline_keyboard[inline_keyboard.length - 1].push({ text: label.slice(0, 60), callback_data: `q:${id}:${i}` });
    });
    const hint = allowText ? `\n<i>${labels.length ? 'Tap a button, or reply' : 'Reply'} to this message to answer.</i>` : '';
    const plain = String(text).slice(0, ASK_TEXT_LIMIT);
    const html = `<b>${escapeHtml(signature(s))}</b>\n${renderBody(plain)}${hint}`;
    // Pending from this moment, so a Notification-hook alert arriving while the question is being sent
    // already sees it as relayed. The timer starts now too, so no answer path can outlive the entry.
    const entry = { id, sessionId: s.id, messageId: null, html, labels, kind, allowText, at: this.now() };
    const answered = new Promise((resolve) => {
      entry.resolve = (result) => {
        if (!this.asks.has(id)) return;
        clearTimeout(entry.timer);
        this.asks.delete(id);
        resolve(result);
      };
    });
    this.asks.set(id, entry);
    entry.timer = setTimeout(() => {
      entry.resolve({ timeout: true });
      this.closeAsk(entry, '⌛ no answer here — it is waiting at the laptop now').catch(() => {});
    }, Math.min(Math.max(Number(timeoutMs) || ASK_DEFAULT_MS, 5000), ASK_MAX_MS));
    entry.timer.unref?.();
    const promise = (async () => {
      try {
        const m = await this.inThread(s, async (threadId) => {
          try {
            return await this.say(threadId, html, inline_keyboard.length ? { reply_markup: { inline_keyboard } } : {});
          } catch (e) {
            if (e.code !== 400 || !/parse|entit/i.test(e.message)) throw e;
            const params = { chat_id: this.config.ownerId, text: `${signature(s)}\n${plain}`, link_preview_options: { is_disabled: true } };
            if (threadId) params.message_thread_id = threadId;
            if (inline_keyboard.length) params.reply_markup = { inline_keyboard };
            return this.tg.call('sendMessage', params);
          }
        });
        entry.messageId = m.message_id;
        this.remember(m.message_id, s.id);
        this.spoke(s.id);
        this.saveState();
      } catch (e) {
        entry.resolve({ failed: true });
        throw e;
      }
      return answered;
    })();
    // The asker (a CLI process, a hook) can die while the question is open; then an answer would vanish
    // into nothing while the phone shows it as taken. Cancel closes the question visibly instead.
    const cancel = () => {
      if (!this.asks.has(id)) return;
      entry.resolve({ cancelled: true });
      this.closeAsk(entry, '🚫 the session stopped waiting — not delivered').catch(() => {});
    };
    return { promise, cancel };
  }

  /** Strip the buttons and append the outcome, so the chat shows what was decided. */
  async closeAsk(entry, note) {
    if (!entry.messageId) return;
    try {
      await this.tg.call('editMessageText', { chat_id: this.config.ownerId, message_id: entry.messageId, text: `${entry.html}\n${escapeHtml(note)}`, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    } catch (e) {
      if (!/not modified/i.test(e.message)) this.log(`closeAsk failed: ${e.message}`);
    }
  }

  async answerAskByReply(msg, text) {
    const repliedTo = msg.reply_to_message?.message_id;
    if (!repliedTo || !text) return false;
    const entry = [...this.asks.values()].find((a) => a.messageId === repliedTo);
    if (!entry) return false;
    if (!entry.allowText) {
      await this.reply(msg, 'Tap one of the buttons to answer that one.');
      return true;
    }
    entry.resolve({ text, typed: true });
    await this.closeAsk(entry, `→ ${text.slice(0, 200)}`);
    await this.react(msg.message_id, '👀');
    return true;
  }

  /**
   * "Claude is waiting at the laptop" alert from the Notification hook. Deduplicated per session and type,
   * and silent when the bridge is already handling it (a relayed prompt) or the session is simply idle
   * with its listener armed (that is normal for a connected session).
   */
  async notify(sessionId, type, detail = '') {
    const s = this.live(sessionId);
    if (!s) return { sent: false, reason: 'not registered' };
    const pending = [...this.asks.values()].some((a) => a.sessionId === sessionId);
    if (type === 'permission_prompt' && pending) return { sent: false, reason: 'relayed' };
    if (type === 'idle_prompt' && (this.listeners.has(sessionId) || pending)) return { sent: false, reason: 'listening' };
    const key = `${sessionId}:${type}`;
    if (this.notified.has(key) && this.now() - this.notified.get(key) < NOTIFY_QUIET_MS) return { sent: false, reason: 'quiet' };
    this.notified.set(key, this.now());
    const what = NOTIFY_LABELS[type] || escapeHtml(String(type || 'input').replace(/_/g, ' '));
    const extra = detail ? `\n<i>${escapeHtml(String(detail).slice(0, 300))}</i>` : '';
    await this.inThread(s, (threadId) => this.say(threadId, `⏸ <b>${escapeHtml(signature(s))}</b> is waiting at the laptop for ${what}.${extra}`)).then((m) => this.remember(m.message_id, s.id));
    this.saveState();
    return { sent: true };
  }

  // ---------------------------------------------------------------- housekeeping

  async sweep() {
    for (const s of this.liveSessions()) {
      if (s.pid && !this.isPidAlive(s.pid)) {
        await this.end(s.id, 'Claude process exited');
        continue;
      }
      const stale = s.queue.find((i) => !i.warned && this.now() - i.at > STALE_QUEUE_MS);
      if (stale && !this.listeners.has(s.id)) {
        s.queue.forEach((i) => (i.warned = true));
        this.saveState();
        try {
          await this.say(s.threadId, `⏳ <b>${escapeHtml(signature(s))}</b> hasn't picked this up yet — it's mid-task or stuck on a permission prompt at the laptop. Your message stays queued.`);
        } catch (e) {
          this.log(`stale notice failed: ${e.message}`);
        }
      }
    }
  }

  startTyping(s) {
    if (!this.typingEnabled) return;
    this.stopTyping(s.id);
    const started = this.now();
    const tick = () => {
      const params = { chat_id: this.config.ownerId, action: 'typing' };
      if (s.threadId) params.message_thread_id = s.threadId;
      this.tg.call('sendChatAction', params).catch(() => {});
    };
    tick();
    const timer = setInterval(() => (this.now() - started > TYPING_MAX_MS ? this.stopTyping(s.id) : tick()), 4500);
    timer.unref?.();
    this.typing.set(s.id, timer);
  }

  stopTyping(sessionId) {
    const timer = this.typing.get(sessionId);
    if (timer) clearInterval(timer);
    this.typing.delete(sessionId);
  }

  shutdown() {
    for (const id of [...this.typing.keys()]) this.stopTyping(id);
    for (const a of [...this.asks.values()]) {
      a.resolve({ restart: true });
      this.closeAsk(a, '🚫 bridge restarted — ask again').catch(() => {});
    }
    for (const [id, l] of this.listeners) {
      clearTimeout(l.timer);
      l.resolve({ restart: true });
      this.listeners.delete(id);
    }
  }

  // ---------------------------------------------------------------- incoming updates

  async handleUpdate(update) {
    try {
      const chat = update.message?.chat || update.callback_query?.message?.chat || update.my_chat_member?.chat;
      if (chat && chat.type !== 'private') return void (await this.leave(chat));

      if (!this.paired) {
        if (update.message) await this.handlePairing(update.message);
        return;
      }
      if (!isFromOwner(update, this.config.ownerId)) {
        this.stats.dropped += 1; // silent: strangers get no sign that anything is here
        return;
      }
      if (update.message) await this.handleOwnerMessage(update.message);
      else if (update.callback_query) await this.handleCallback(update.callback_query);
    } catch (e) {
      this.log(`update ${update.update_id} failed: ${e.message}`);
    }
  }

  async leave(chat) {
    if (!['group', 'supergroup', 'channel'].includes(chat.type)) return;
    if (this.now() - (this.leftAt.get(chat.id) || 0) < 60000) return;
    this.leftAt.set(chat.id, this.now());
    this.log(`added to a ${chat.type}; leaving`);
    try {
      await this.tg.call('leaveChat', { chat_id: chat.id });
    } catch (e) {
      this.log(`leaveChat failed: ${e.message}`);
    }
  }

  async handlePairing(msg) {
    if (msg.chat?.type !== 'private' || !msg.from || msg.from.is_bot) return;
    const result = this.pairing.attempt({ fromId: msg.from.id, username: msg.from.username, text: msg.text, expectedUsername: this.config.expectedUsername });
    if (result !== 'ok') {
      this.stats.dropped += 1;
      return;
    }
    this.config.ownerId = msg.from.id;
    this.saveConfig();
    this.log(`paired with Telegram user id ${msg.from.id}`);
    const threads = await this.topicsEnabled(true);
    await this.say(
      null,
      `✅ <b>Paired.</b> From now on I answer only you (id <code>${msg.from.id}</code>) and ignore everyone else.\n\n` +
        (threads ? 'Thread mode is on: every session gets its own thread.' : 'Tip: turn on <b>Threaded Mode</b> for this bot in @BotFather and every session gets its own thread.') +
        '\n\nIn any Claude Code terminal run <code>/tg</code> before you walk away. /help'
    );
  }

  resolveSession(msg) {
    if (msg.message_thread_id) {
      const byThread = this.sessionByThread(msg.message_thread_id);
      if (byThread || msg.is_topic_message) return byThread;
    }
    const repliedTo = msg.reply_to_message?.message_id;
    if (repliedTo) {
      const byReply = this.sessionByMessage(repliedTo);
      if (byReply) return byReply;
    }
    if (this.state.activeSessionId && this.live(this.state.activeSessionId)) return this.live(this.state.activeSessionId);
    const live = this.liveSessions();
    return live.length === 1 ? live[0] : null;
  }

  async handleOwnerMessage(msg) {
    const text = (msg.text ?? msg.caption ?? '').trim();
    if (await this.answerAskByReply(msg, text)) return;
    const session = this.resolveSession(msg);

    if (text.startsWith('/') && (await this.handleCommand(msg, text, session))) return;

    if (!session) {
      if (msg.is_topic_message) return void (await this.reply(msg, 'No session is attached to this thread. /sessions'));
      return void (await this.sendSessionList(msg, this.liveSessions().length ? 'Which session? Reply to one of its messages, or pick:' : null));
    }
    if (session.endedAt) return void (await this.reply(msg, `💤 <b>${escapeHtml(signature(session))}</b> has disconnected. /sessions`));

    const item = await this.buildItem(msg, session, text);
    if (!item) return;
    item.seq = ++this.state.seq;
    session.queue.push(item);
    this.saveState();

    const l = this.listeners.get(session.id);
    if (l) {
      this.listeners.delete(session.id);
      clearTimeout(l.timer);
      l.resolve({ messages: session.queue.slice(), signature: signature(session) });
    } else {
      await this.react(msg.message_id, '✍');
    }
  }

  async buildItem(msg, session, text) {
    const item = { text, attachments: [], at: this.now(), messageId: msg.message_id };
    const dir = path.join(this.inboxDir, safeFileName(session.id));
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-');

    const audio = msg.voice || msg.audio || msg.video_note;
    if (audio) {
      if (!this.transcribe) return void (await this.reply(msg, '🎤 Voice transcription is not set up on the laptop.'));
      try {
        const file = await this.tg.download(audio.file_id, path.join(dir, `${stamp}-voice.ogg`));
        const transcript = (await this.transcribe(file.path)).trim();
        if (!transcript) return void (await this.reply(msg, "🎤 Couldn't make out any words."));
        item.text = item.text ? `${item.text}\n\n${transcript}` : transcript;
        item.voice = true;
        await this.reply(msg, `🎤 <i>${escapeHtml(transcript)}</i>`);
      } catch (e) {
        this.log(`voice failed: ${e.message}`);
        return void (await this.reply(msg, `🎤 Transcription failed: ${escapeHtml(e.message).slice(0, 200)}`));
      }
    }

    const files = [];
    if (msg.photo?.length) files.push({ id: msg.photo[msg.photo.length - 1].file_id, name: `${stamp}-photo.jpg` });
    if (msg.document) files.push({ id: msg.document.file_id, name: `${stamp}-${safeFileName(msg.document.file_name)}` });
    if (msg.video) files.push({ id: msg.video.file_id, name: `${stamp}-${safeFileName(msg.video.file_name, 'video.mp4')}` });
    for (const f of files) {
      try {
        item.attachments.push((await this.tg.download(f.id, path.join(dir, f.name))).path);
      } catch (e) {
        this.log(`download failed: ${e.message}`);
        await this.reply(msg, e.code === 'TOO_LARGE' ? '📎 Too big — bots can only fetch files up to 20 MB.' : '📎 Could not download that file.');
        if (!item.text) return null;
      }
    }

    const quoted = msg.reply_to_message?.text || msg.reply_to_message?.caption;
    if (quoted) item.replyTo = quoted.slice(0, 280);
    if (!item.text && !item.attachments.length) return void (await this.reply(msg, 'I can pass on text, voice, photos and files.'));
    return item;
  }

  async handleCommand(msg, text, session) {
    const cmd = text.split(/\s+/)[0].slice(1).split('@')[0].toLowerCase();
    switch (cmd) {
      case 'start':
      case 'help':
        await this.reply(msg, HELP);
        return true;
      case 's':
      case 'sessions':
        await this.sendSessionList(msg);
        return true;
      case 'status': {
        const st = this.status();
        await this.reply(
          msg,
          `<b>Bridge</b> up ${Math.round(st.uptimeSec / 60)} min\nthread mode: ${(await this.topicsEnabled(true)) ? 'on' : 'off'}\nsessions: ${st.sessions.length}\ndropped updates from strangers: ${st.stats.dropped}`
        );
        return true;
      }
      case 'ping': {
        if (!session || session.endedAt) return void (await this.reply(msg, 'Use /ping inside a session thread (or as a reply to one).')), true;
        const alive = session.pid ? this.isPidAlive(session.pid) : null;
        const state = this.listeners.has(session.id) ? '🟢 idle, listening' : '🟡 working (not listening right now)';
        await this.reply(msg, `<b>${escapeHtml(signature(session))}</b>\n${state}\nprocess: ${alive === null ? 'unknown' : alive ? 'alive' : 'gone'} · queued: ${session.queue.length}`);
        return true;
      }
      case 'end':
        if (!session || session.endedAt) await this.reply(msg, 'Use /end inside a session thread (or as a reply to one).');
        else await this.end(session.id, 'ended from Telegram');
        return true;
      case 'clean': {
        const ended = Object.values(this.state.sessions).filter((s) => s.endedAt);
        for (const s of ended) {
          if (s.threadId) {
            try {
              await this.tg.call('deleteForumTopic', { chat_id: this.config.ownerId, message_thread_id: s.threadId });
            } catch (e) {
              this.log(`deleteForumTopic failed: ${e.message}`);
            }
          }
          delete this.state.sessions[s.id];
        }
        this.state.msgMap = this.state.msgMap.filter((m) => this.state.sessions[m[1]]);
        this.saveState();
        if (!msg.message_thread_id || this.sessionByThread(msg.message_thread_id)) await this.reply(msg, `🧹 Removed ${ended.length} ended session(s).`);
        return true;
      }
      default:
        return false; // unknown slash text goes to the session verbatim
    }
  }

  async sendSessionList(msg, heading = null) {
    const live = this.liveSessions();
    if (!live.length) return void (await this.reply(msg, 'No Claude sessions are connected.\nRun <code>/tg</code> in a Claude Code terminal to connect one.'));
    const lines = live.map((s) => `${this.listeners.has(s.id) ? '🟢' : '🟡'} <b>${escapeHtml(signature(s))}</b>${s.queue.length ? ` · ${s.queue.length} queued` : ''}${s.id === this.state.activeSessionId ? ' · active' : ''}`);
    const extra = {};
    if (live.some((s) => !s.threadId)) {
      extra.reply_markup = { inline_keyboard: live.map((s) => [{ text: signature(s), callback_data: `use:${s.id}`.slice(0, 64) }]) };
    }
    await this.reply(msg, `${heading || '<b>Sessions</b>  🟢 listening · 🟡 working'}\n${lines.join('\n')}`, extra);
  }

  async handleCallback(cq) {
    const data = String(cq.data || '');
    let toast = 'Nothing to do';
    if (data.startsWith('q:')) {
      const [, id, idx] = data.split(':');
      const entry = this.asks.get(id);
      const choice = entry?.labels[Number(idx)];
      if (entry && choice !== undefined) {
        entry.resolve({ choice, index: Number(idx) });
        await this.closeAsk(entry, `→ ${choice}`);
        toast = choice;
      } else {
        toast = 'That question has expired';
      }
    } else if (data.startsWith('use:')) {
      const id = data.slice(4);
      const s = this.liveSessions().find((x) => x.id.startsWith(id));
      if (s) {
        this.state.activeSessionId = s.id;
        // A toast disappears in a second; leave a line in the chat so it is clear where plain messages go now.
        try {
          const m = await this.say(s.threadId || null, `🎯 Now talking to <b>${escapeHtml(signature(s))}</b> — plain messages go there until another session writes.`);
          this.remember(m.message_id, s.id);
        } catch (e) {
          this.log(`picker notice failed: ${e.message}`);
        }
        this.saveState();
      }
      toast = s ? `Now talking to ${signature(s)}` : 'That session is gone';
    }
    try {
      await this.tg.call('answerCallbackQuery', { callback_query_id: cq.id, text: toast.slice(0, 200) });
    } catch (e) {
      this.log(`answerCallbackQuery failed: ${e.message}`);
    }
  }
}
