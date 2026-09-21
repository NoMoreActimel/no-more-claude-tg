import { spawn } from 'node:child_process';

/**
 * Holds a `caffeinate` assertion while at least one session is connected, so the laptop does not
 * idle-sleep under a session that is waiting for a Telegram message. `-w <daemon pid>` makes it
 * go away if the daemon dies. Note: closing the lid still sleeps a MacBook (unless it is on power
 * with an external display) — caffeinate cannot override that.
 */
export class Caffeinate {
  constructor({ log = () => {} } = {}) {
    this.log = log;
    this.proc = null;
  }

  get on() {
    return Boolean(this.proc) && this.proc.exitCode === null;
  }

  set(wanted) {
    if (wanted && !this.on) {
      this.proc = spawn('/usr/bin/caffeinate', ['-ims', '-w', String(process.pid)], { stdio: 'ignore' });
      this.proc.once('error', (e) => this.log(`caffeinate failed: ${e.message}`));
      this.proc.once('exit', () => (this.proc = null));
      this.log('caffeinate on');
    } else if (!wanted && this.on) {
      this.proc.kill('SIGTERM');
      this.proc = null;
      this.log('caffeinate off');
    }
  }
}
