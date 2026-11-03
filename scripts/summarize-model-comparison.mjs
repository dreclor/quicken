import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const base=JSON.parse(readFileSync('verification/model-comparison.json'));
const more=['Qwen3-1.7B','Qwen3-0.6B'].map(id=>JSON.parse(readFileSync(`verification/model-comparison-${id}-thinking64.json`)));
const audio=JSON.parse(readFileSync('verification/model-audio-comparison.json'));
const baseline=base.models[0],gate=base.gate;
const median=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)];
const configurations=[base,...more].flatMap(report=>report.models.map(model=>{
 if(model.rows.length!==84)throw new Error('Incomplete model: '+model.id);
 const reasons=[];
 if(model.summary.overall<gate.minimumOverall)reasons.push('Below 90% overall check threshold');
 for(const kind of ['moderation','direct','notes'])if(model.summary[kind].passed/model.summary[kind].total<gate.minimumEachFeature)reasons.push(kind+' below 85% check threshold');
 if(model.summary.overall<baseline.summary.overall-gate.maxOverallRegression)reasons.push('More than 3 percentage points below baseline');
 if(model.summary.unnecessaryInterjections>gate.maxUnnecessaryInterjections)reasons.push('More than one unnecessary interjection across repetitions');
 if(model.summary.moderation.p95Ms>baseline.summary.moderation.p95Ms||model.summary.direct.p95Ms>baseline.summary.direct.p95Ms)reasons.push('Worse p95 live-response latency than baseline');
 const summary={...model.summary};summary.unexpectedFactSections=summary.unexpectedFactSections??summary.criticalNoteFailures;delete summary.criticalNoteFailures;
 return {id:model.id,thinkingBudget:report.configuration.thinkingBudget||0,bytes:model.bytes,checksPassed:model.rows.filter(r=>r.passed).length,checksTotal:84,summary,qualifies:!reasons.length,reasons};
}));
const eligible=configurations.filter(c=>c.id!==baseline.id&&c.qualifies).sort((a,b)=>a.bytes-b.bytes);
// Manual review is recorded separately; these targeted automated checks are not semantic accuracy.
const review=[
 {model:'Qwen3-4B-Instruct-2507',case:'notes-corrected-facts',rounds:[0,1],finding:'Summary overstates a previously considered date as an established date that changed. The targeted date/action checks did not catch this.'},
 {model:'Qwen3-4B-Instruct-2507',case:'notes-suggestion-only',rounds:[0],finding:'A statement that no work was assigned appears under action items. It fails section classification, but is not an invented assignment.'},
 {model:'Qwen3-1.7B',case:'suggestion',configurations:['non-thinking','thinking64'],rounds:[0,1],finding:'Invents a suggestion attributed to Maya instead of offering Quicken’s own suggestion. The targeted keyword check did not catch this.'},
 {model:'Qwen3-1.7B',case:'known-owner',configurations:['non-thinking','thinking64'],rounds:[0,1],finding:'Says Maya owns the venue-contract task, although the transcript explicitly names Priya. Caught by automated checks.'},
 {model:'Qwen3-0.6B',case:'notes-resolved-question',configurations:['non-thinking'],rounds:[0,1],finding:'Summary repeats the venue question and omits the provided answer. The broad summary-topic check did not catch this.'},
 {model:'Qwen3-0.6B',case:'notes-open-question',configurations:['non-thinking','thinking64'],finding:'Loses the actual unresolved question; some runs also classify the absence of an assignment as a decision.'}
];
const report={createdAt:new Date().toISOString(),decision:eligible.length?'candidate-requires-manual-qualification':'retain-current-model',selected:eligible[0]?.id||baseline.id,rationale:'Neither smaller model preserves custom responses, commitment tracking and structured notes. Retaining 4B is a no-regression decision, not a claim that it passes the stricter new quality gate.',configurationResults:configurations,audioResults:base.models.map(m=>{const runs=audio.results.filter(r=>r.model===m.id);return{id:m.id,runs:runs.map(r=>r.speechEndToFirstPlaybackMs),medianSpeechEndToFirstPlaybackMs:median(runs.map(r=>r.speechEndToFirstPlaybackMs)),applicationVoiceCache:'Empty before each run',externalRequests:runs.flatMap(r=>r.externalRequests),passedTransportChecks:runs.every(r=>r.passed)};}),manualReview:review,limitations:['42 synthetic scenarios repeated with two seeds are not 84 independent meetings. No real meeting or physical microphone was used.','All production prompts, grounding and control logic were unchanged. Small models were tested with thinking off and with a 64-token thinking cap; no fine-tuning or model-specific prompt optimization was done.','Automated checks cover targeted facts and section placement. Manual review found additional inaccuracies; counts must not be presented as overall real-world accuracy.','Audio latency uses three repetitions of one prerecorded question per model, with warmed models and an empty application voice cache. These are not general latency guarantees.','The existing 4B model also misses interventions and produces unnecessary interjections; none of the tested configurations passed the new strict quality gate.','CPU/GPU tests ran sequentially. Thermal state and background macOS activity were not experimentally controlled.'],sourceSHA256:Object.fromEntries(['server/local/engine.ts','server/local/moderator.ts','server/controller.ts','scripts/model-comparison-cases.mjs','tests/audio/agenda-question.wav'].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]))};
writeFileSync('verification/model-selection.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({selected:report.selected,decision:report.decision,configurations:configurations.map(c=>({model:c.id,thinkingBudget:c.thinkingBudget,checks:`${c.checksPassed}/${c.checksTotal}`,qualifies:c.qualifies}))},null,2));
