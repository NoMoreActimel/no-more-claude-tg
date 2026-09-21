import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Everything private (token, state, socket, downloads) lives here, mode 0700.
export const HOME_DIR = process.env.CLAUDE_TG_HOME || path.join(os.homedir(), '.config', 'claude-tg');

export const CONFIG_FILE = path.join(HOME_DIR, 'config.json');
export const STATE_FILE = path.join(HOME_DIR, 'state.json');
export const SOCKET_PATH = path.join(HOME_DIR, 'daemon.sock');
export const LOG_FILE = path.join(HOME_DIR, 'daemon.log');
export const INBOX_DIR = path.join(HOME_DIR, 'inbox');
export const OUTBOX_DIR = path.join(HOME_DIR, 'outbox');
export const PUBLISHED_DIR = path.join(HOME_DIR, 'published');
export const MODELS_DIR = path.join(HOME_DIR, 'models');

export const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DAEMON_ENTRY = path.join(REPO_DIR, 'src', 'daemon.js');

export const SERVICE_LABEL = 'com.claude-tg.daemon';
// With a custom home (tests, experiments) stay away from the real launchd service.
export const SERVICE_PLIST = process.env.CLAUDE_TG_HOME
  ? path.join(HOME_DIR, `${SERVICE_LABEL}.plist`)
  : path.join(os.homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);

// launchd and detached spawns do not inherit the login shell's PATH.
export const TOOL_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
