import fs from 'node:fs';
import path from 'node:path';

export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw new Error(`cannot read ${file}: ${e.message}`);
  }
}

// Write-then-rename so a crash never leaves a half-written token or state file.
export function writeJsonAtomic(file, data) {
  ensurePrivateDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export const DEFAULT_CONFIG = {
  token: null,
  expectedUsername: null,
  ownerId: null,
  tunnel: { enabled: false },
};

export const DEFAULT_STATE = {
  offset: 0,
  seq: 0,
  sessions: {},
  projectEmojis: {},
  msgMap: [],
  activeSessionId: null,
};
