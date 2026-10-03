import { api } from './client.js';

const RELAY_TIMEOUT_MS = 9 * 60 * 1000 + 30 * 1000; // the hook itself is given 600 s by settings.json
const ALLOW = '✅ Allow';
const DENY = '❌ Deny';

export async function readStdinJson() {
  if (process.stdin.isTTY) return {};
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  try {
    return JSON.parse(data || '{}');
  } catch {
    return {};
  }
}

const FENCE_LIMIT = 1500;
// Never let the owner approve something they could not see: a cut command says so, loudly.
const fence = (s, limit = FENCE_LIMIT) => {
  const t = String(s).replace(/```/g, "''' ");
  const cut = t.length > limit;
  return '```\n' + t.slice(0, limit) + '\n```' + (cut ? `\n⚠️ ${t.length - limit} more characters not shown. Deny, or check at the laptop.` : '');
};
const short = (v, n = 600) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? '');
  return s.length > n ? s.slice(0, n) + '…' : s;
};

/** One screen a person can judge from a phone: what the tool is about to do. */
export function describeTool(toolName, input = {}) {
  switch (toolName) {
    case 'Bash':
    case 'PowerShell':
      return `**Run a command**${input.description ? `\n${short(input.description, 200)}` : ''}\n${fence(input.command || '')}`;
    case 'Write':
      return `**Write file** \`${short(input.file_path, 200)}\` (${String(input.content || '').length} chars)\n${fence(input.content || '', 400)}`;
    case 'Edit':
      return `**Edit file** \`${short(input.file_path, 200)}\`\nreplace:\n${fence(input.old_string ?? '', 300)}\nwith:\n${fence(input.new_string ?? '', 300)}`;
    case 'MultiEdit':
    case 'NotebookEdit':
      return `**Edit file** \`${short(input.file_path || input.notebook_path, 200)}\`\n${fence(short(input, 600), 600)}`;
    case 'Read':
      return `**Read file** \`${short(input.file_path, 200)}\``;
    case 'WebFetch':
      return `**Fetch** ${short(input.url, 300)}`;
    case 'WebSearch':
      return `**Web search:** ${short(input.query, 300)}`;
    default:
      return `**${toolName}**\n${fence(short(input, 800))}`;
  }
}

function decision(behavior, message) {
  const out = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior } } };
  if (message) out.hookSpecificOutput.decision.message = message;
  return JSON.stringify(out);
}

/** Only sessions that joined the bridge get their prompts relayed; everyone else keeps the local dialog. */
async function connected(sessionId) {
  if (!sessionId) return false;
  try {
    const st = await api('GET', `/session?sessionId=${encodeURIComponent(sessionId)}`, null, { timeoutMs: 1500 });
    return Boolean(st.registered);
  } catch {
    return false; // no daemon: nothing to relay to
  }
}

/**
 * PermissionRequest hook. Prints a decision when the owner answered on Telegram; prints nothing (so the
 * normal local prompt appears) when the session is not connected, the daemon is down, or nobody answered.
 */
export async function hookPermission(input, out) {
  const sid = input.session_id;
  if (!(await connected(sid))) return;
  if (input.tool_name === 'AskUserQuestion') return relayQuestions(input, out);
  const text = `🔐 Permission\n${describeTool(input.tool_name, input.tool_input)}`;
  let r;
  try {
    r = await api('POST', '/ask', { sessionId: sid, text, options: [ALLOW, DENY], kind: 'permission', timeoutMs: RELAY_TIMEOUT_MS, allowText: false }, { timeoutMs: 0 });
  } catch {
    return;
  }
  if (r.choice === ALLOW) out(decision('allow'));
  else if (r.choice === DENY) out(decision('deny', 'Denied by the user from Telegram. Do not retry it; ask what to do instead.'));
}

/**
 * AskUserQuestion has no hook of its own, but PermissionRequest fires for it (verified on Claude Code
 * 2.1.288, interactive, default permission mode). The questions go to the owner as buttons and the answers
 * travel back as the denial message: the tool never runs, Claude reads the message as the user's answer and
 * continues (verified: next reply used the relayed choice). The terminal dialog flashes briefly first.
 */
async function relayQuestions(input, out) {
  const questions = Array.isArray(input.tool_input?.questions) ? input.tool_input.questions.slice(0, 4) : [];
  if (!questions.length) return;
  const answers = [];
  const deadline = Date.now() + RELAY_TIMEOUT_MS; // the hook as a whole is killed at 600 s
  for (const [i, q] of questions.entries()) {
    const left = deadline - Date.now();
    if (left < 10000) return;
    const options = (q.options || []).map((o) => String(o.label || o).slice(0, 60));
    const lines = (q.options || []).filter((o) => o.description).map((o) => `• **${o.label}** — ${short(o.description, 160)}`);
    const text = `❓ ${questions.length > 1 ? `[${i + 1}/${questions.length}] ` : ''}${q.question}${lines.length ? `\n${lines.join('\n')}` : ''}${q.multiSelect ? '\n(several apply? reply with them comma-separated)' : ''}`;
    let r;
    try {
      r = await api('POST', '/ask', { sessionId: input.session_id, text, options, kind: 'question', timeoutMs: left, allowText: true }, { timeoutMs: 0 });
    } catch {
      return;
    }
    if (r.choice === undefined && !r.text) return; // timeout/ended: fall back to the local dialog
    answers.push(`${q.header || `Q${i + 1}`}: ${r.text ?? r.choice}`);
  }
  out(decision('deny', `The user answered on Telegram instead of in the terminal — ${answers.join('; ')}. Continue with these answers; do not ask again.`));
}

/** Notification hook: fire-and-forget "Claude is waiting at the laptop" alert. */
export async function hookNotify(input) {
  const sid = input.session_id;
  const type = input.notification_type || input.type;
  if (!sid || !type) return;
  try {
    await api('POST', '/notify', { sessionId: sid, type, detail: input.message ? String(input.message).slice(0, 300) : '' }, { timeoutMs: 4000 });
  } catch {}
}
