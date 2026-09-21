import crypto from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

export function newCode(len = 10) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// "/start CODE" (deep link) or a bare "CODE".
export function extractCode(text) {
  if (typeof text !== 'string') return null;
  const m = text.trim().match(/^(?:\/start(?:@\w+)?\s+)?([A-Za-z0-9]{6,32})$/);
  return m ? m[1].toUpperCase() : null;
}

/**
 * One-time pairing. Until it succeeds the bot has no owner and answers nobody.
 * The code is shown only in the local terminal, expires, and burns after a few wrong guesses,
 * so finding the bot's username is not enough to claim it.
 */
export class Pairing {
  constructor({ ttlMs = 10 * 60 * 1000, maxPerUser = 3, maxTotal = 12, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.maxPerUser = maxPerUser;
    this.maxTotal = maxTotal;
    this.now = now;
    this.code = null;
  }

  start() {
    this.code = newCode();
    this.expiresAt = this.now() + this.ttlMs;
    this.failures = new Map();
    this.totalFailures = 0;
    return { code: this.code, expiresAt: this.expiresAt };
  }

  get active() {
    return Boolean(this.code) && this.now() < this.expiresAt;
  }

  /** @returns {'ok'|'wrong'|'closed'} */
  attempt({ fromId, username, text, expectedUsername }) {
    if (!this.active) return 'closed';
    const fails = this.failures.get(fromId) || 0;
    if (fails >= this.maxPerUser) return 'closed';
    const candidate = extractCode(text);
    if (!candidate) return 'wrong'; // chatter is ignored, not counted
    const nameOk = !expectedUsername || (username || '').toLowerCase() === expectedUsername.toLowerCase();
    if (nameOk && safeEqual(candidate, this.code)) {
      this.code = null;
      return 'ok';
    }
    this.failures.set(fromId, fails + 1);
    this.totalFailures += 1;
    if (this.totalFailures >= this.maxTotal) this.code = null; // someone is guessing: burn it
    return 'wrong';
  }
}

/** The only gate that lets a Telegram update reach a Claude session. */
export function isFromOwner(update, ownerId) {
  if (!ownerId) return false;
  const msg = update.message;
  if (msg) {
    return msg.from?.id === ownerId && !msg.from.is_bot && msg.chat?.type === 'private' && msg.chat.id === ownerId;
  }
  const cq = update.callback_query;
  if (cq) {
    const chat = cq.message?.chat;
    return cq.from?.id === ownerId && !cq.from.is_bot && (!chat || (chat.type === 'private' && chat.id === ownerId));
  }
  return false;
}
