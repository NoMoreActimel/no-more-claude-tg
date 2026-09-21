import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractCode, isFromOwner, newCode } from '../src/auth.js';
import { chunkText, renderBody, safeFileName } from '../src/format.js';
import { findLocalRefs } from '../src/report.js';
import { Telegram } from '../src/telegram.js';

test('pairing codes are long, unambiguous and parsed from deep links', () => {
  const code = newCode();
  assert.match(code, /^[A-HJ-NP-Z2-9]{10}$/);
  assert.equal(extractCode(`/start ${code}`), code);
  assert.equal(extractCode(` ${code.toLowerCase()} `), code);
  assert.equal(extractCode('hello there'), null);
  assert.equal(extractCode(undefined), null);
});

test('isFromOwner requires owner id, a private chat with that same id, and a human', () => {
  const ok = { message: { from: { id: 1, is_bot: false }, chat: { id: 1, type: 'private' } } };
  assert.equal(isFromOwner(ok, 1), true);
  assert.equal(isFromOwner(ok, null), false);
  assert.equal(isFromOwner({ message: { from: { id: 2 }, chat: { id: 2, type: 'private' } } }, 1), false);
  assert.equal(isFromOwner({ message: { from: { id: 1 }, chat: { id: -5, type: 'group' } } }, 1), false);
  assert.equal(isFromOwner({ message: { from: { id: 1, is_bot: true }, chat: { id: 1, type: 'private' } } }, 1), false);
  assert.equal(isFromOwner({ edited_message: ok.message }, 1), false, 'unknown update kinds are not trusted');
});

test('chunks stay under the limit and keep code fences balanced', () => {
  const text = 'intro\n```\n' + 'line of code\n'.repeat(600) + '```\noutro';
  const chunks = chunkText(text, 1000);
  assert.ok(chunks.length > 5);
  for (const c of chunks) {
    assert.ok(c.length <= 1010, `chunk of ${c.length}`);
    assert.equal((c.match(/```/g) || []).length % 2, 0);
  }
});

test('renderBody escapes everything outside the tiny markdown subset', () => {
  assert.equal(renderBody('a < b && **bold** `c>d`'), 'a &lt; b &amp;&amp; <b>bold</b> <code>c&gt;d</code>');
  assert.equal(renderBody('```js\nif (a<b) {}\n```'), '<pre>if (a&lt;b) {}</pre>');
  assert.equal(renderBody('dangling ``` fence'), 'dangling ``` fence');
});

test('safeFileName cannot escape the inbox', () => {
  assert.equal(safeFileName('../../etc/passwd'), 'passwd');
  assert.equal(safeFileName('..hidden'), 'hidden');
  assert.equal(safeFileName('my report (final).html'), 'my_report_final_.html');
  assert.equal(safeFileName(undefined), 'file');
});

test('local references in a report are caught; inlined and remote ones are fine', () => {
  const html = `
    <link rel="stylesheet" href="style.css"><script src="./app.js"></script>
    <img src="plots/loss.png"><img src="data:image/png;base64,AAAA">
    <script src="https://cdn.jsdelivr.net/npm/plotly.js"></script>
    <script>fetch('results.json'); fetch("https://example.com/x"); const u = 'file:///Users/me/a.csv';</script>
    <style>body{background:url(bg.png)} a{background:url("data:image/gif;base64,R0")}</style>
    <a href="#top">top</a>`;
  assert.deepEqual(findLocalRefs(html).sort(), ['./app.js', 'bg.png', 'file:///Users/me/a.csv', 'plots/loss.png', 'results.json', 'style.css'].sort());
  assert.deepEqual(findLocalRefs('<script>const data = {"a":1}</script><img src="data:image/png;base64,AA">'), []);
});

test('the bot token never appears in error messages', async () => {
  const token = '123456:SECRETSECRETSECRETSECRETSECRETSECRET';
  const tg = new Telegram({ token, apiBase: 'http://127.0.0.1:1' });
  await assert.rejects(
    () => tg.call('getMe'),
    (e) => !e.message.includes('SECRET') && e.code === 'NETWORK'
  );
  assert.equal(tg.redact(`boom https://x/bot${token}/getMe`), 'boom https://x/bot<token>/getMe');
});
