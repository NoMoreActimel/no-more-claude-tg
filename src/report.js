import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
];

const REMOTE = /^(?:https?:)?\/\//i;
const INLINE = /^(?:data:|blob:|#|mailto:|tel:|javascript:|about:)/i;

/**
 * A report is opened on a phone, far away from this disk. Anything it still loads from a local path
 * (./data.json, ../plots/a.png, file://…) will be missing there, so flag it before sending.
 */
export function findLocalRefs(html) {
  const refs = new Set();
  const add = (url) => {
    const u = String(url || '').trim();
    if (!u || REMOTE.test(u) || INLINE.test(u)) return;
    refs.add(u);
  };
  for (const m of html.matchAll(/<(?:script|img|iframe|source|video|audio|embed|object|link)\b[^>]*?\b(?:src|href|data)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) add(m[1] ?? m[2]);
  for (const m of html.matchAll(/\b(?:fetch|d3\.(?:csv|json|tsv|text)|Plotly\.d3\.(?:csv|json))\(\s*(?:"([^"]+)"|'([^']+)')/g)) add(m[1] ?? m[2]);
  for (const m of html.matchAll(/url\(\s*(?:"([^"]+)"|'([^']+)'|([^)'"\s]+))\s*\)/gi)) add(m[1] ?? m[2] ?? m[3]);
  for (const m of html.matchAll(/file:\/\/[^\s"'<>)]+/gi)) refs.add(m[0]);
  return [...refs];
}

export function findChrome() {
  return CHROME_CANDIDATES.find((p) => fs.existsSync(p)) || null;
}

const PHONE = { width: 430, height: 1000, deviceScaleFactor: 2, mobile: true };
const FULL_PAGE_MAX = 8000; // css px; beyond this a PNG stops being pleasant to scroll

/**
 * Minimal DevTools client over --remote-debugging-pipe (fd 3 in, fd 4 out, NUL-separated JSON).
 * A pipe instead of a debugging port: nothing listens on the network, even on localhost.
 */
class Chrome {
  constructor(bin) {
    this.profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-chrome-'));
    this.proc = spawn(
      bin,
      ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${this.profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--hide-scrollbars', '--mute-audio', 'about:blank'],
      { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] }
    );
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = [];
    let buf = '';
    this.proc.stdio[4].setEncoding('utf8').on('data', (chunk) => {
      buf += chunk;
      let end;
      while ((end = buf.indexOf('\0')) >= 0) {
        this.onMessage(JSON.parse(buf.slice(0, end)));
        buf = buf.slice(end + 1);
      }
    });
    this.proc.once('exit', () => {
      for (const p of this.pending.values()) p.reject(new Error('Chrome exited early'));
      this.pending.clear();
    });
    this.proc.once('error', (e) => {
      for (const p of this.pending.values()) p.reject(e);
    });
  }

  onMessage(msg) {
    if (msg.id && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      return;
    }
    this.waiters = this.waiters.filter((w) => {
      if (w.method !== msg.method) return true;
      w.resolve(msg.params);
      return false;
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
    });
  }

  waitFor(method, timeoutMs) {
    return new Promise((resolve) => {
      this.waiters.push({ method, resolve });
      setTimeout(resolve, timeoutMs); // a page that never fires "load" still gets a screenshot
    });
  }

  async close() {
    const exited = new Promise((resolve) => this.proc.once('exit', resolve));
    this.send('Browser.close').catch(() => {});
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
    if (this.proc.exitCode === null) this.proc.kill('SIGKILL');
    fs.rm(this.profile, { recursive: true, force: true }, () => {});
  }
}

// Runs inside the page after its own scripts have finished. Telegram's in-app HTML viewer on iOS does not
// execute JavaScript (verified on an iPhone), so a JS-drawn report is blank there. This freezes
// what the scripts produced into plain HTML: canvases become images, scripts and inline handlers go.
const FREEZE_PAGE = `(() => {
  for (const canvas of document.querySelectorAll('canvas')) {
    try {
      const img = document.createElement('img');
      img.src = canvas.toDataURL('image/png');
      img.className = canvas.className;
      img.style.cssText = canvas.style.cssText;
      img.style.width = canvas.clientWidth + 'px';
      img.style.height = canvas.clientHeight + 'px';
      canvas.replaceWith(img);
    } catch {}
  }
  for (const el of document.querySelectorAll('script, noscript')) el.remove();
  for (const el of document.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
  }
  for (const input of document.querySelectorAll('input')) {
    if (input.checked) input.setAttribute('checked', '');
    if (input.type !== 'password' && input.type !== 'file') input.setAttribute('value', input.value);
  }
  const note = document.createElement('div');
  note.textContent = 'Static snapshot · rendered ' + new Date().toLocaleString() + ' · interactivity removed';
  note.style.cssText = 'font:12px -apple-system,system-ui,sans-serif;color:#888;padding:6px 10px;text-align:center';
  document.body.prepend(note);
  return '<!doctype html>\\n' + document.documentElement.outerHTML;
})()`;

/**
 * Render the page the way a phone would and save into outDir:
 *   preview — PNG of the first screenful, small enough that Telegram's photo compression keeps it readable;
 *   full    — PNG of the whole page (only when it is longer than the preview), to be sent uncompressed;
 *   frozen  — static HTML of the rendered page, readable in viewers that do not run JavaScript.
 */
export async function screenshot(htmlPath, outDir, { settleMs = 1500 } = {}) {
  const bin = findChrome();
  if (!bin) throw new Error('no Chrome-family browser found for the screenshot');
  const chrome = new Chrome(bin);
  const deadline = setTimeout(() => chrome.proc.kill('SIGKILL'), 45000);
  try {
    const { targetId } = await chrome.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await chrome.send('Target.attachToTarget', { targetId, flatten: true });
    const page = (method, params) => chrome.send(method, params, sessionId);
    await page('Page.enable');
    await page('Emulation.setDeviceMetricsOverride', PHONE);
    const loaded = chrome.waitFor('Page.loadEventFired', 20000);
    await page('Page.navigate', { url: pathToFileURL(htmlPath).href });
    await loaded;
    await new Promise((r) => setTimeout(r, settleMs)); // let charts finish drawing

    // Layout metrics never report less than the viewport, so ask the page where its content really ends;
    // otherwise a short report becomes a mostly blank image.
    const { cssContentSize } = await page('Page.getLayoutMetrics');
    const layoutHeight = Math.ceil(cssContentSize?.height || PHONE.height);
    const measured = await page('Runtime.evaluate', {
      expression: 'Math.ceil(document.body.getBoundingClientRect().bottom + window.scrollY + (parseFloat(getComputedStyle(document.body).marginBottom) || 0))',
      returnByValue: true,
    }).then((r) => Number(r.result?.value) || 0, () => 0);
    const pageHeight = layoutHeight > PHONE.height || measured < 200 ? layoutHeight : Math.min(layoutHeight, measured);
    const capture = async (height, file) => {
      const { data } = await page('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: PHONE.width, height, scale: 1 } });
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      return file;
    };
    const preview = await capture(Math.min(pageHeight, PHONE.height), path.join(outDir, 'preview.png'));
    const full = pageHeight > PHONE.height ? await capture(Math.min(pageHeight, FULL_PAGE_MAX), path.join(outDir, 'full-page.png')) : null;

    // Last, because it rewrites the DOM.
    let frozen = null;
    try {
      const { result } = await page('Runtime.evaluate', { expression: FREEZE_PAGE, returnByValue: true });
      if (typeof result?.value === 'string' && result.value.length > 100) {
        frozen = path.join(outDir, 'frozen.html');
        fs.writeFileSync(frozen, result.value);
      }
    } catch {}
    return { preview, full, frozen, pageHeight };
  } finally {
    clearTimeout(deadline);
    await chrome.close();
  }
}
