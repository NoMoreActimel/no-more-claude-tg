export function escapeHtml(s) {
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function signature(session) {
  return `${session.projectEmoji}${session.emoji} ${session.name}`;
}

function renderInline(s) {
  return escapeHtml(s)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
}

/** Minimal markdown -> Telegram HTML: fenced code, inline code, **bold**. Everything else is escaped. */
export function renderBody(text) {
  const parts = String(text).split('```');
  const balanced = parts.length % 2 === 1;
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    const fenced = i % 2 === 1;
    const closed = balanced || i < parts.length - 1;
    if (fenced && closed) {
      const code = parts[i].replace(/^[a-zA-Z0-9_+-]*\n/, '').replace(/\n$/, '');
      out += `<pre>${escapeHtml(code)}</pre>`;
    } else {
      out += (fenced ? '```' : '') + renderInline(parts[i]);
    }
  }
  return out;
}

/** Split on line boundaries; keep code fences balanced inside every chunk. */
export function chunkText(text, limit = 3500) {
  const src = String(text);
  if (src.length <= limit) return [src];
  const chunks = [];
  let cur = '';
  const push = () => {
    if (cur.trim()) chunks.push(cur.replace(/\n+$/, ''));
    cur = '';
  };
  for (let line of src.split('\n')) {
    while (line.length > limit) {
      push();
      chunks.push(line.slice(0, limit));
      line = line.slice(limit);
    }
    if (cur.length + line.length + 1 > limit) push();
    cur += line + '\n';
  }
  push();
  let open = false;
  return chunks.map((c) => {
    let body = open ? '```\n' + c : c;
    const fences = (body.match(/```/g) || []).length;
    open = fences % 2 === 1;
    if (open) body += '\n```';
    return body;
  });
}

const WORD_LIMIT = 3;
const NAME_LIMIT = 28;

export function validateName(name) {
  const clean = String(name || '').trim().replace(/\s+/g, ' ');
  if (!clean) throw new Error('name is required');
  if (clean.length > NAME_LIMIT) throw new Error(`name too long (max ${NAME_LIMIT} chars): make it 2-3 short words`);
  if (clean.split(' ').length > WORD_LIMIT) throw new Error(`name has too many words (max ${WORD_LIMIT})`);
  if (/\p{Extended_Pictographic}/u.test(clean)) throw new Error('put emojis in --emoji / --project-emoji, not in the name');
  return clean;
}

export function validateEmoji(value, label) {
  const clean = String(value || '').trim();
  if (!clean) throw new Error(`${label} is required`);
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(clean)];
  if (graphemes.length !== 1 || !/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(clean)) {
    throw new Error(`${label} must be exactly one emoji`);
  }
  return clean;
}

export function safeFileName(name, fallback = 'file') {
  const base = String(name || fallback).split(/[\\/]/).pop().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '');
  return (base || fallback).slice(-80);
}
