import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { MODELS_DIR, TOOL_PATH } from './paths.js';

const MODEL = path.join(MODELS_DIR, 'ggml-large-v3-turbo.bin');

function which(bin) {
  for (const dir of TOOL_PATH.split(':')) {
    const p = path.join(dir, bin);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// execFile with an args array: nothing that came from Telegram is ever parsed by a shell.
function run(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, PATH: TOOL_PATH } }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${path.basename(bin)} failed: ${(stderr || err.message).toString().trim().split('\n').pop()}`));
      else resolve(stdout.toString());
    });
  });
}

export function voiceSupport() {
  const ffmpeg = which('ffmpeg');
  const whisper = which('whisper-cli');
  const model = fs.existsSync(MODEL) ? MODEL : null;
  return { ffmpeg, whisper, model, ready: Boolean(ffmpeg && whisper && model) };
}

/** Returns a transcribe(path) function, or null when the local tools are missing. */
export function makeTranscriber() {
  return async function transcribe(audioPath) {
    const { ffmpeg, whisper, model, ready } = voiceSupport(); // re-checked per call so installing later just works
    if (!ready) throw new Error('voice tools missing on the laptop (need ffmpeg, whisper-cpp and the model)');
    const wav = `${audioPath}.wav`;
    try {
      await run(ffmpeg, ['-nostdin', '-y', '-loglevel', 'error', '-i', audioPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], 60000);
      const out = await run(whisper, ['-m', model, '-f', wav, '-l', 'auto', '-nt', '-np'], 180000);
      return out.replace(/\s+/g, ' ').trim();
    } finally {
      fs.rm(wav, { force: true }, () => {});
    }
  };
}
