import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const paths = [
  'verification/model-comparison-Qwen3-4B-Instruct-2507.json',
  'verification/model-comparison-Apple-Foundation-Models.json',
  'verification/model-comparison-Apple-Foundation-Models-compact.json',
  'verification/model-comparison-Cloud-gpt-6-luna.json',
  'verification/apple-audio-comparison.json'
];
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const quantile = (values, q) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1] : null;
const models = paths.slice(0, 4).map(path => {
  const report = read(path), model = report.models[0];
  if (model.rows.length !== 84 || !model.summary) throw new Error('Incomplete comparison: ' + path);
  return { model: model.id, variant: path.includes('-compact') ? 'compact prompts (exploratory)' : 'production prompts', source: path, configuration: report.configuration, availability: model.availability, passed: model.rows.filter(row => row.passed).length, total: model.rows.length, ...model.summary, firstTokenMedianMs: quantile(model.rows.flatMap(row => row.requests).map(q => q.firstTokenMs).filter(Number.isFinite), 0.5) };
});
const audio = read(paths[4]);
if (audio.results.length !== 9) throw new Error('Expected nine audio trials.');
const audioSummary = [...new Set(audio.results.map(row => row.model))].map(model => {
  const rows = audio.results.filter(row => row.model === model);
  return { model, passed: rows.filter(row => row.passed).length, total: rows.length, speechEndToFirstPlaybackMs: rows.map(row => row.speechEndToFirstPlaybackMs), medianMs: quantile(rows.filter(row => row.passed).map(row => row.speechEndToFirstPlaybackMs), 0.5) };
});
const cloudRows = read(paths[3]).models[0].rows.flatMap(row => row.requests);
const usage = cloudRows.reduce((out, row) => {
  const usage = row.usage || {}, detail = usage.input_tokens_details || {};
  out.inputTokens += usage.input_tokens || 0;
  out.cachedTokens += detail.cached_tokens || 0;
  out.cacheWriteTokens += detail.cache_write_tokens || 0;
  out.outputTokens += usage.output_tokens || 0;
  return out;
}, { inputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
const report = {
  createdAt: new Date().toISOString(), hardware: read(paths[0]).hardware,
  scope: 'Actual models on synthetic meeting fixtures. Four configurations x 84 checks plus nine browser/audio trials. Production app/model unchanged.',
  models, audio: audioSummary,
  cloudUsage: { ...usage, scope: '84 scored text cases only; excludes warm-ups, access probes, and audio trials', estimatedUSD: ((usage.inputTokens - usage.cachedTokens - usage.cacheWriteTokens) * 0.10 + usage.cachedTokens * 0.01 + usage.cacheWriteTokens * 0.125 + usage.outputTokens * 0.50) / 1e6, pricingSource: 'https://developers.openai.com/api/docs/models/gpt-6-luna' },
  retainedAppModel: 'Qwen3-4B-Instruct-2507 Q4_K_M',
  manualReview: [
    { model: 'Apple / production prompts', case: 'sustained-drift and other tracking cases', finding: 'Frequently copied the testing-plan example from instructions, including a quote absent from the actual transcript. Existing grounding rejected it, which also explains many silent passes.' },
    { model: 'Apple / both variants', case: 'explicitly-deferred, deferred-room, deferred-capacity', finding: 'Named Maya or Alex as a follow-up owner without an assignment in the transcript, despite passing the automated topic-word checks.' },
    { model: 'Apple / production prompts', case: 'notes-resolved-question', finding: 'Summary said venue cost was agreed upon; the transcript only states a price.' },
    { model: 'Apple / both variants', case: 'suggestion', finding: 'Suggested using the agenda item to choose a launch date; this passed the keyword check but did not give a useful method for choosing between dates.' },
    { model: 'Qwen / production prompts', case: 'notes-corrected-facts', finding: 'Summary overstated a date merely considered as a date previously set; automated section checks did not catch this.' },
    { model: 'Cloud / production prompts', case: 'notes-corrected-facts and other notes', finding: 'Key decisions, assignments and date distinctions were correct. Some supporting quotes cover only part of a note that combines facts across rows; passing this suite does not establish strict single-quote entailment.' },
    { model: 'Cloud / production prompts', case: 'notes-commitment', finding: 'Added a gendered pronoun not specified by the fixture; no owner or deadline was changed.' }
  ],
  limitations: [
    'Checks include existing rules, grounding and controller behavior; they are not raw model accuracy or a real-meeting reliability score.',
    'Some silent cases pass because unsupported model output is rejected by grounding. Apple baseline repeatedly copied a prompt example that was not in the transcript.',
    'Apple compact prompts were written after baseline inspection; their scores are exploratory, not held-out.',
    'Cloud timing is from this Mac/network on the standard service tier, not a universal cloud speed or SLA. No cloud model tournament was run.',
    'Different tokenizers, native schema generation and cache behavior; equal output caps do not imply equal output lengths.',
    'Apple system-model version follows macOS; the API did not provide a reproducible weight hash.',
    'Audio trials use one easy prerecorded question repeated three times. No physical microphone, speaker routing, or real meeting was tested.',
    'Apple requests use SystemLanguageModel.default on-device. Node/browser HTTP interception does not inspect Apple system-service traffic.',
    'Cold launches, lengthy meetings, background contention and sustained battery/thermal behavior are not characterized.'
  ],
  evidence: [...paths, 'scripts/model-comparison-cases.mjs', 'scripts/compare-local-models.mjs', 'scripts/apple-model-benchmark.swift', 'scripts/apple-benchmark-engine.mjs', 'scripts/cloud-benchmark-engine.mjs'].map(path => ({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }))
};
writeFileSync('verification/apple-cloud-benchmark.json', JSON.stringify(report, null, 2) + '\n');
const availability = read('verification/apple-model-availability.json');
availability.latestAvailability = models.find(model => model.model === 'Apple-Foundation-Models').availability;
availability.status = 'benchmarked';
availability.inferenceRun = true;
writeFileSync('verification/apple-model-availability.json', JSON.stringify(availability, null, 2) + '\n');
console.log(JSON.stringify({ models: models.map(({ model, variant, passed, total, moderation, direct, notes }) => ({ model, variant, passed, total, moderation, direct, notes })), audio: audioSummary, cloudUsage: report.cloudUsage }, null, 2));
