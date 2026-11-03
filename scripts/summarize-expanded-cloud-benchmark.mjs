// Combine the existing local/Luna controls with the expanded cloud comparison.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const quantile = (values, q) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1] : null;
const ids = ['Qwen3-4B-Instruct-2507', 'Apple-Foundation-Models', 'Cloud-gpt-6-luna', 'Cloud-gpt-6.1-terra', 'Cloud-gpt-5.4-nano'];
const prices = {
  'gpt-6-luna': { input: 0.1, cached: 0.01, write: 0.125, output: 0.5 },
  'gpt-6.1-terra': { input: 1, cached: 0.05, write: 1.25, output: 5 },
  'gpt-5.4-nano': { input: 0.2, cached: 0.02, write: 0.2, output: 1.25 }
};
const paths = ids.map(id => `verification/model-comparison-${id}.json`);
const prior = read('verification/apple-cloud-benchmark.json');
for (const path of ['scripts/model-comparison-cases.mjs', 'scripts/compare-local-models.mjs', 'scripts/cloud-benchmark-engine.mjs']) {
  if (prior.evidence.find(row => row.path === path)?.sha256 !== hash(path)) throw new Error('Shared benchmark changed since baseline: ' + path);
}
const models = paths.map((source, index) => {
  const report = read(source), model = report.models[0], rows = model.rows;
  if (rows.length !== 84 || !model.summary) throw new Error('Incomplete text benchmark: ' + source);
  const requests = rows.flatMap(row => row.requests);
  const usage = requests.reduce((sum, request) => {
    const u = request.usage || {}, d = u.input_tokens_details || {};
    sum.input += u.input_tokens || 0; sum.cached += d.cached_tokens || 0;
    sum.write += d.cache_write_tokens || 0; sum.output += u.output_tokens || 0;
    return sum;
  }, { input: 0, cached: 0, write: 0, output: 0 });
  const cloudId = model.id.startsWith('Cloud-') ? model.id.slice(6) : null;
  const price = prices[cloudId];
  return {
    model: model.id, source, measuredAt: report.createdAt, reusedEarlierTextBaseline: index < 3,
    configuration: report.configuration, ...model.summary,
    passed: rows.filter(row => row.passed).length, total: rows.length,
    firstTokenMedianMs: quantile(requests.map(row => row.firstTokenMs).filter(Number.isFinite), 0.5),
    returnedModels: [...new Set(requests.map(row => row.returnedModel).filter(Boolean))],
    serviceTiers: [...new Set(requests.map(row => row.serviceTier).filter(Boolean))],
    failedChecks: rows.filter(row => !row.passed).map(({ id, round, actual, failures, text }) => ({ id, round, actual, failures, text })),
    ...(price ? { cloudUsage: { ...usage, estimatedUSD: ((usage.input - usage.cached - usage.write) * price.input + usage.cached * price.cached + usage.write * price.write + usage.output * price.output) / 1e6, scope: '84 scored text cases; excludes warm-up, probes and audio', ratesUSDPerMillionTokens: price, pricingSource: `https://developers.openai.com/api/docs/models/${cloudId}` } } : {})
  };
});
const audioPath = 'verification/expanded-cloud-audio-comparison.json';
const audioRaw = read(audioPath);
if (audioRaw.results.length !== ids.length * 3) throw new Error('Incomplete audio benchmark');
const audio = ids.map(model => {
  const rows = audioRaw.results.filter(row => row.model === model);
  if (rows.length !== 3) throw new Error('Expected three audio trials for ' + model);
  return { model, passed: rows.filter(row => row.passed).length, total: rows.length, speechEndToFirstPlaybackMs: rows.map(row => row.speechEndToFirstPlaybackMs), medianMs: quantile(rows.filter(row => row.passed).map(row => row.speechEndToFirstPlaybackMs), 0.5) };
});
const report = {
  createdAt: new Date().toISOString(), hardware: prior.hardware,
  scope: 'Five actual models, 84 synthetic text checks each. Local and Luna text scores reused from the same day with unchanged fixtures/harness. Fifteen fresh interleaved browser/audio trials. OpenAI is the only cloud provider tested.',
  models, audio, audioMeasuredAt: audioRaw.createdAt,
  retainedAppModel: 'Qwen3-4B-Instruct-2507 Q4_K_M',
  manualReview: prior.manualReview.filter(row => !row.model.includes('both variants')),
  limitations: [
    'These are targeted checks through the production controller and grounding filters, not a measure of real-meeting accuracy. Keyword checks can miss unsupported or unhelpful text.',
    'All models use production prompts; no model-specific prompt tuning in this comparison. Apple shorter-prompt exploration is in the previous report only.',
    'Existing local/Luna text measurements were reused, not newly interleaved with Terra/nano; network load and machine conditions may differ between runs.',
    'Cloud uses standard tier, no reasoning, full completion timing including network. No Fast mode, alternate provider or realtime speech model was tested.',
    'GPT-5.4 nano is marked deprecated in current official documentation; measured as a small-model reference, not a new deployment recommendation.',
    'Audio is one easy prerecorded question, three repeats per model, using real local ASR and native speech with an empty app voice cache. Not a physical meeting or broad audio accuracy test.',
    'Warm models, short transcripts and this Mac/network only. Cold launch, long meetings, thermal/battery behavior and poor networks are not characterized.',
    'Apple OS-managed model and generation schema differ from Qwen and cloud. Equal token caps do not imply equal text lengths. Apple system-service network traffic is outside Node/browser interception.'
  ],
  evidence: [...paths, audioPath, 'verification/apple-cloud-benchmark.json', 'scripts/model-comparison-cases.mjs', 'scripts/compare-local-models.mjs', 'scripts/cloud-benchmark-engine.mjs', 'scripts/compare-apple-audio.mjs', 'scripts/test-local-browser.mjs'].map(path => ({ path, sha256: hash(path) }))
};
writeFileSync('verification/expanded-cloud-benchmark.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ models: models.map(({ model, passed, total, moderation, direct, notes, cloudUsage }) => ({ model, passed, total, moderation, direct, notes, cloudUsage })), audio }, null, 2));
