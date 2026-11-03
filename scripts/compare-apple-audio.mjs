// Actual ASR -> model -> native voice -> browser playback; synthetic input only.
// node --import tsx scripts/compare-apple-audio.mjs tests/audio/agenda-question.wav
import { languageModel } from '../server/local/engine.ts';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

if (!process.argv[2]) throw new Error('Supply the recorded question WAV.');
const priorReport = existsSync('verification/local-browser-synthetic.json') ? readFileSync('verification/local-browser-synthetic.json') : undefined;
const priorDirectory = process.env.QUICKEN_MODELS_DIR;
const priorEngine = process.env.QUICKEN_BENCHMARK_ENGINE;
const priorCloud = process.env.QUICKEN_COMPARE_CLOUD;
const outputPath = process.env.QUICKEN_AUDIO_REPORT || 'verification/apple-audio-comparison.json';
const models = process.env.QUICKEN_AUDIO_MODELS?.split(',') || ['Qwen3-4B-Instruct-2507', 'Apple-Foundation-Models', ...(priorCloud ? ['Cloud-' + priorCloud] : [])];
if (!models.length || new Set(models).size !== models.length || models.some(model => !['Qwen3-4B-Instruct-2507', 'Apple-Foundation-Models'].includes(model) && !/^Cloud-[a-z0-9.-]+$/.test(model))) throw new Error('Invalid audio benchmark model list.');
const originalFetch = globalThis.fetch;
const shared = join(homedir(), 'Library/Application Support/Quicken/LocalModels');
let seed = 17;
globalThis.fetch = (url, options) => {
  if (process.env.QUICKEN_BENCHMARK_ENGINE === 'cloud' && String(url) === 'https://api.openai.com/v1/responses') return originalFetch(url, options);
  if (new URL(String(url)).hostname !== '127.0.0.1') throw new Error('External HTTP blocked by benchmark');
  if (new URL(String(url)).pathname.endsWith('/v1/chat/completions')) {
    options = { ...options, body: JSON.stringify({ ...JSON.parse(options.body), chat_template_kwargs: { enable_thinking: false }, seed }) };
  }
  return originalFetch(url, options);
};
const report = { createdAt: new Date().toISOString(), kind: 'One recorded question, three repetitions per model; no physical microphone or meeting', limitations: 'Transport/latency check of an easy question. Not a substitute for the broader semantic tests. Apple system-service traffic is not observed by HTTP interception.', results: [] };
let failed = false;
try {
  for (let round = 0; round < 3; round++) for (const model of [...models.slice(round % models.length), ...models.slice(0, round % models.length)]) {
    const directory = mkdtempSync(join(tmpdir(), 'quicken-apple-audio-'));
    symlinkSync(join(shared, languageModel.file), join(directory, languageModel.file));
    symlinkSync(join(shared, 'speech'), join(directory, 'speech'));
    symlinkSync(join(shared, 'speech-ready.json'), join(directory, 'speech-ready.json'));
    process.env.QUICKEN_MODELS_DIR = directory;
    process.env.QUICKEN_BENCHMARK_ENGINE = model.startsWith('Cloud-') ? 'cloud' : model === 'Apple-Foundation-Models' ? 'apple' : 'qwen';
    if (model.startsWith('Cloud-')) process.env.QUICKEN_COMPARE_CLOUD = model.slice(6);
    seed = [17, 29, 41][round];
    process.exitCode = 0;
    try {
      await import('./test-local-browser.mjs?model=' + model + '&round=' + round);
      const result = JSON.parse(readFileSync('verification/local-browser-synthetic.json', 'utf8'));
      report.results.push({ model, round, voiceCache: 'Empty before run', ...result });
      failed ||= !result.passed;
      writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
      console.log(JSON.stringify({ model, round, passed: result.passed, ms: result.speechEndToFirstPlaybackMs }));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
} finally {
  globalThis.fetch = originalFetch;
  if (priorDirectory === undefined) delete process.env.QUICKEN_MODELS_DIR; else process.env.QUICKEN_MODELS_DIR = priorDirectory;
  if (priorEngine === undefined) delete process.env.QUICKEN_BENCHMARK_ENGINE; else process.env.QUICKEN_BENCHMARK_ENGINE = priorEngine;
  if (priorCloud === undefined) delete process.env.QUICKEN_COMPARE_CLOUD; else process.env.QUICKEN_COMPARE_CLOUD = priorCloud;
  if (priorReport) writeFileSync('verification/local-browser-synthetic.json', priorReport);
  else rmSync('verification/local-browser-synthetic.json', { force: true });
  process.exitCode = failed ? 1 : 0;
}
