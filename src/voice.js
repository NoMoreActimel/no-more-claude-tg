import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { MODELS_DIR, TOOL_PATH } from './paths.js';

export const MODEL_NAME = 'ggml-large-v3-turbo.bin';
export const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_NAME}`;
export const MODEL_PATH = path.join(MODELS_DIR, MODEL_NAME);
export const OPENAI_MODEL = 'gpt-4o-mini-transcribe';

export function which(bin) {
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

/**
 * What transcription can do right now. `provider` is "local" (ffmpeg + whisper.cpp on this machine, free)
 * or "openai" (their transcription API, a key in config.voice.apiKey, ~$0.003/min).
 */
export function voiceSupport(config = {}) {
  const provider = config.voice?.provider === 'openai' ? 'openai' : 'local';
  const ffmpeg = which('ffmpeg');
  const whisper = which('whisper-cli');
  const model = fs.existsSync(MODEL_PATH) ? MODEL_PATH : null;
  const local = Boolean(ffmpeg && whisper && model);
  const openai = Boolean(config.voice?.apiKey);
  return { provider, ffmpeg, whisper, model, local, openai, ready: provider === 'openai' ? openai : local };
}

async function transcribeLocal(audioPath, { ffmpeg, whisper, model }) {
  const wav = `${audioPath}.wav`;
  try {
    await run(ffmpeg, ['-nostdin', '-y', '-loglevel', 'error', '-i', audioPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], 60000);
    const out = await run(whisper, ['-m', model, '-f', wav, '-l', 'auto', '-nt', '-np'], 180000);
    return out.replace(/\s+/g, ' ').trim();
  } finally {
    fs.rm(wav, { force: true }, () => {});
  }
}

async function transcribeOpenAI(audioPath, { apiKey, model = OPENAI_MODEL }) {
  const form = new FormData();
  form.set('model', model);
  form.set('file', new Blob([await fs.promises.readFile(audioPath)], { type: 'audio/ogg' }), path.basename(audioPath));
  let res;
  try {
    res = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { authorization: `Bearer ${apiKey}` }, body: form, signal: AbortSignal.timeout(120000) });
  } catch (e) {
    throw new Error(`OpenAI transcription: network error (${e.cause?.code || e.name})`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenAI transcription: ${body.error?.message || `HTTP ${res.status}`}`.replace(apiKey, '<key>'));
  return String(body.text || '').trim();
}

/** Returns transcribe(path). The provider is re-read on every call, so `tg setup voice` takes effect without a restart. */
export function makeTranscriber(getConfig = () => ({})) {
  return async function transcribe(audioPath) {
    const config = getConfig() || {};
    const support = voiceSupport(config);
    if (support.provider === 'openai') {
      if (!support.openai) throw new Error('voice.provider is "openai" but no API key is configured — run: tg setup voice');
      return transcribeOpenAI(audioPath, { apiKey: config.voice.apiKey, model: config.voice.model });
    }
    if (!support.local) throw new Error('voice tools missing (ffmpeg, whisper-cpp, model) — run: tg setup voice');
    return transcribeLocal(audioPath, support);
  };
}
