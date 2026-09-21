import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class TgError extends Error {
  constructor(message, { code, retryAfter } = {}) {
    super(message);
    this.name = 'TgError';
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export class Telegram {
  constructor({ token, apiBase = 'https://api.telegram.org' }) {
    if (!token) throw new Error('no bot token configured');
    this.token = token;
    this.apiBase = apiBase.replace(/\/$/, '');
  }

  // The token is part of every URL, so anything that may end up in a log goes through here.
  redact(s) {
    return String(s).split(this.token).join('<token>');
  }

  async request(method, init, timeoutMs) {
    let res;
    try {
      res = await fetch(`${this.apiBase}/bot${this.token}/${method}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new TgError(this.redact(`${method}: network error (${e.cause?.code || e.name})`), { code: 'NETWORK' });
    }
    let body;
    try {
      body = await res.json();
    } catch {
      throw new TgError(`${method}: unreadable response (HTTP ${res.status})`, { code: res.status });
    }
    if (!body.ok) {
      throw new TgError(this.redact(`${method}: ${body.description || 'error'}`), {
        code: body.error_code,
        retryAfter: body.parameters?.retry_after,
      });
    }
    return body.result;
  }

  async call(method, params = {}, { timeoutMs = 30000 } = {}) {
    const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) };
    try {
      return await this.request(method, init, timeoutMs);
    } catch (e) {
      if (e.code === 429 && e.retryAfter && e.retryAfter <= 30) {
        await sleep(e.retryAfter * 1000 + 250);
        return this.request(method, init, timeoutMs);
      }
      throw e;
    }
  }

  async upload(method, params, field, filePath, filename) {
    const form = new FormData();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      form.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    const buf = await fs.promises.readFile(filePath);
    form.set(field, new Blob([buf]), filename || path.basename(filePath));
    return this.request(method, { method: 'POST', body: form }, 180000);
  }

  async download(fileId, destPath, maxBytes = 20 * 1024 * 1024) {
    const f = await this.call('getFile', { file_id: fileId });
    if (f.file_size && f.file_size > maxBytes) throw new TgError('file too large', { code: 'TOO_LARGE' });
    let res;
    try {
      res = await fetch(`${this.apiBase}/file/bot${this.token}/${f.file_path}`, { signal: AbortSignal.timeout(180000) });
    } catch (e) {
      throw new TgError(`download: network error (${e.cause?.code || e.name})`, { code: 'NETWORK' });
    }
    if (!res.ok) throw new TgError(`download: HTTP ${res.status}`, { code: res.status });
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new TgError('file too large', { code: 'TOO_LARGE' });
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(destPath, buf, { mode: 0o600 });
    return { path: destPath, size: buf.length, remotePath: f.file_path };
  }
}
