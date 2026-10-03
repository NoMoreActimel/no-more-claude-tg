import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { PUBLISHED_DIR, TOOL_PATH } from './paths.js';
import { safeFileName } from './format.js';

const LINK_TTL_MS = 24 * 60 * 60 * 1000;
const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.json': 'application/json', '.csv': 'text/csv; charset=utf-8' };

/**
 * OFF unless config.tunnel.enabled is true.
 *
 * Expiring secret links for reports that need a real browser. Isolation rules:
 *  - its own HTTP listener on 127.0.0.1, which knows nothing about sessions or the control socket;
 *  - serves only files copied into PUBLISHED_DIR, looked up by an exact 256-bit token (no path joins
 *    from the URL, so no traversal);
 *  - cloudflared runs only while at least one link is alive.
 */
export class Tunnel {
  constructor({ log = () => {}, now = Date.now } = {}) {
    this.log = log;
    this.now = now;
    this.links = new Map(); // token -> { file, name, expiresAt }
    this.server = null;
    this.proc = null;
    this.baseUrl = null;
  }

  async publish(sourcePath) {
    const token = crypto.randomBytes(32).toString('hex');
    const name = safeFileName(path.basename(sourcePath), 'report.html');
    const dir = path.join(PUBLISHED_DIR, token);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, name);
    fs.copyFileSync(sourcePath, file);
    const expiresAt = this.now() + LINK_TTL_MS;
    this.links.set(token, { file, name, expiresAt });
    const base = await this.ensureUp();
    return { url: `${base}/r/${token}/${encodeURIComponent(name)}`, expiresAt };
  }

  handle(req, res) {
    const deny = () => {
      res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      res.end('not found');
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return deny();
    const m = (req.url || '').split('?')[0].match(/^\/r\/([0-9a-f]{64})\/([^/]+)$/);
    const link = m && this.links.get(m[1]);
    let name = null;
    try {
      name = m && decodeURIComponent(m[2]);
    } catch {}
    if (!link || this.now() > link.expiresAt || name !== link.name) return deny();
    res.writeHead(200, {
      'content-type': TYPES[path.extname(link.name).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(link.file).on('error', () => res.destroy()).pipe(res);
  }

  async ensureUp() {
    if (!this.server) {
      this.server = http.createServer((req, res) => this.handle(req, res));
      await new Promise((resolve, reject) => this.server.once('error', reject).listen(0, '127.0.0.1', resolve));
    }
    if (this.baseUrl && this.proc && this.proc.exitCode === null) return this.baseUrl;
    const port = this.server.address().port;
    this.baseUrl = await new Promise((resolve, reject) => {
      const proc = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { env: { ...process.env, PATH: TOOL_PATH }, stdio: ['ignore', 'ignore', 'pipe'] });
      this.proc = proc;
      const timer = setTimeout(() => reject(new Error('cloudflared did not produce a URL in 30s')), 30000);
      proc.stderr.on('data', (chunk) => {
        const hit = chunk.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (hit) {
          clearTimeout(timer);
          resolve(hit[0]);
        }
      });
      proc.once('error', (e) => (clearTimeout(timer), reject(new Error(`cloudflared: ${e.message}`))));
      proc.once('exit', () => {
        this.baseUrl = null;
        this.proc = null;
      });
    });
    this.log('report tunnel is up');
    return this.baseUrl;
  }

  sweep() {
    for (const [token, link] of this.links) {
      if (this.now() <= link.expiresAt) continue;
      this.links.delete(token);
      fs.rm(path.dirname(link.file), { recursive: true, force: true }, () => {});
    }
    if (!this.links.size) this.down();
  }

  down() {
    if (this.proc) {
      this.proc.kill('SIGTERM');
      this.log('report tunnel is down (no live links)');
    }
    this.proc = null;
    this.baseUrl = null;
  }

  shutdown() {
    this.down();
    this.server?.close();
    fs.rmSync(PUBLISHED_DIR, { recursive: true, force: true }); // links die with the daemon
  }
}
