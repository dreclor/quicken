process.env.QUICKEN_LOCAL_MODEL = 'qwen';
// Reproducible comparison using actual production moderator, grounding, controller and notes.
// Run: node --import tsx scripts/compare-local-models.mjs [model-id]
import { OfflineEngine, languageModel } from '../server/local/engine.ts';
import { LocalModerator, localNotes } from '../server/local/moderator.ts';
import { MeetingController } from '../server/controller.ts';
import { meeting } from '../tests/fixtures.ts';
import { moderationCases, directCases, notesCases } from './model-comparison-cases.mjs';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir, cpus, totalmem } from 'node:os';
import { AppleBenchmarkEngine } from './apple-benchmark-engine.mjs';
import { CloudBenchmarkEngine } from './cloud-benchmark-engine.mjs';
const current={...languageModel,id:'Qwen3-4B-Instruct-2507'};
const apple=process.argv[2]==='Apple-Foundation-Models';
const appleCompact=apple&&process.env.QUICKEN_APPLE_COMPACT==='1';
const cloud=process.argv[2]?.startsWith('Cloud-') ? process.argv[2].slice(6) : undefined;
const thinkingBudget=Number(process.env.QUICKEN_COMPARE_THINKING||0);
if((apple||cloud)&&thinkingBudget)throw new Error('Only Qwen comparison supports the llama.cpp thinking-budget option.');
if(thinkingBudget)process.env.LLAMA_ARG_THINK_BUDGET=String(thinkingBudget);
const candidates=JSON.parse(readFileSync('verification/model-candidates.json','utf8'));
const shared=join(homedir(),'Library/Application Support/Quicken/LocalModels');
const cache=join(homedir(),'Library/Caches/Quicken/model-comparison');
const models=cloud?[{id:'Cloud-'+cloud}]:apple?[{id:'Apple-Foundation-Models',storage:'System-managed; no Quicken model download'}]:[current,...candidates.slice().reverse()].filter(m=>!process.argv[2]||m.id===process.argv[2]);
if(!models.length)throw new Error('Unknown comparison model.');
const quantile=(a,q)=>a.length?Math.round([...a].sort((a,b)=>a-b)[Math.ceil(a.length*q)-1]):null;
const originalFetch=globalThis.fetch;let seed=17,requests=[],activeEngine;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{activeEngine?.close();process.exit(130);});
globalThis.fetch=async(url,options)=>{
 const parsed=new URL(String(url));if(cloud&&parsed.href==='https://api.openai.com/v1/responses')return originalFetch(url,options);
 if(parsed.hostname!=='127.0.0.1')throw new Error('Benchmark blocks external requests');
 if(!parsed.pathname.endsWith('/v1/chat/completions'))return originalFetch(url,options);
 const body={...JSON.parse(options.body),chat_template_kwargs:{enable_thinking:thinkingBudget>0},max_tokens:JSON.parse(options.body).max_tokens+thinkingBudget,seed};
 const start=performance.now();const response=await originalFetch(url,{...options,body:JSON.stringify(body)});
 const data=await response.clone().json();
 requests.push({ms:Math.round(performance.now()-start),usage:data.usage,timings:data.timings,finishReason:data.choices?.[0]?.finish_reason,text:data.choices?.[0]?.message?.content,reasoning:data.choices?.[0]?.message?.reasoning_content});
 return response;
};
const turns=items=>items.map((item,i)=>({id:String(i),speaker:i%2?'Alex':'Maya',source:'local',at:Date.now()+i,...(typeof item==='string'?{text:item}:item)}));
const makeMeeting=c=>meeting({title:'Model comparison',processing:'local',mode:'rehearsal',createdAt:Date.now(),startedAt:Date.now(),agendaStartedAt:Date.now(),agenda:[{id:'a',title:c.kind==='direct'?'Choose the launch date':'Launch planning',minutes:10},{id:'b',title:'Assign owners',minutes:10}],currentAgendaIndex:c.current||0,transcript:turns(c.turns),...(c.enabledReasons?{enabledReasons:c.enabledReasons}:{}),interventions:(c.recentInterventions||[]).map((text,i)=>({id:'old-'+i,reason:'off_track',text,evidence:'Earlier discussion',confidence:1,proposedAt:Date.now()-5000,spokenAt:Date.now()-4000,state:'spoken'}))});
function checkText(text,c){return [...(c.contains||[]).filter(pattern=>!new RegExp(pattern,'i').test(text)).map(pattern=>'Missing: '+pattern),...(c.forbidden||[]).filter(pattern=>new RegExp(pattern,'i').test(text)).map(pattern=>'Forbidden: '+pattern)];}
function notesSections(text){const keys=['summary','decisions','actionItems','openQuestions'];const labels=['Summary','Decisions','Action items','Open questions'];return Object.fromEntries(keys.map((key,i)=>{const part=text.split('## '+labels[i]+'\n')[1]?.split('\n## ')[0]?.trim()||'';return[key,part];}));}
const report={kind:'Synthetic local model comparison; no physical microphone or real meeting',createdAt:new Date().toISOString(),hardware:{cpu:cpus()[0]?.model,ramGB:totalmem()/1e9},configuration:{quantization:'Q4_K_M',context:8192,gpuLayers:99,cpuThreads:4,parallelSlots:1,temperature:0.1,thinking:thinkingBudget>0,thinkingBudget,repetitions:2,seeds:[17,29],promptPolicy:'Unchanged production prompts for every model',latency:'Final transcript to moderator assessment; notes measured separately. Includes 120ms moderation debounce, excludes ASR and voice.'},gate:{minimumOverall:0.9,minimumEachFeature:0.85,maxOverallRegression:0.03,maxUnnecessaryInterjections:1,criticalFacts:'No invented decisions/assignments in designated empty notes sections; manually inspect all answers and notes.',latency:'No worse p95 live moderation latency than 4B baseline.'},models:[]};
if(apple)report.configuration={runtime:'Apple FoundationModels / SystemLanguageModel.default (on-device)',context:'System-reported below',temperature:0.1,sampling:'random top-k 40',repetitions:2,seeds:[17,29],promptPolicy:'Unchanged production text prompts; JSON schema mapped to Apple guided generation with property order preserved. Native schema prompt inclusion enabled.',sessionPolicy:'Fresh session per request; one unscored warm-up; no history shared between cases.',comparisonLimits:'Different model tokenizers, schema implementations, and runtime caching; equal token caps are not equal text lengths. No assumed parity in hidden sampling defaults.',latency:report.configuration.latency};
if(appleCompact)report.configuration.promptPolicy='Exploratory shorter Apple-specific moderation, notes and deferred-question prompts after baseline inspection. Same fixtures, controller, schema, caps and scoring; not a held-out result. See compactInstructions in apple-benchmark-engine.mjs.';
if(cloud){report.kind='Synthetic cloud/local comparison; no real meeting data';report.configuration={runtime:'OpenAI Responses API',model:cloud,reasoning:'none',serviceTier:'default',temperature:0.1,repetitions:2,seeds:null,promptPolicy:'Unchanged production text prompts and output caps; native strict JSON schema.',sessionPolicy:'Independent requests, store=false; one unscored warm-up; no retries; API prompt caching may occur.',comparisonLimits:'No seed control in Responses. Full response latency includes network, server, and download. Streaming first-token latency also recorded but not used as decision latency.',latency:report.configuration.latency};}
mkdirSync('verification',{recursive:true});const output='verification/model-comparison'+(process.argv[2]?'-'+process.argv[2]:'')+(thinkingBudget?'-thinking'+thinkingBudget:'')+(appleCompact?'-compact':'')+'.json';
const save=()=>writeFileSync(output,JSON.stringify(report,null,2)+'\n');
try{
 for(const model of models){
  let engine;
  if(cloud){engine=new CloudBenchmarkEngine(cloud,row=>requests.push(row));}
  else if(apple){engine=new AppleBenchmarkEngine(row=>requests.push(row));}
  else{
   const directory=mkdtempSync(join(tmpdir(),'quicken-model-compare-'));
   symlinkSync(join(model.id===current.id?shared:cache,model.file),join(directory,model.file));
   symlinkSync(join(shared,'speech'),join(directory,'speech'));symlinkSync(join(shared,'speech-ready.json'),join(directory,'speech-ready.json'));
   Object.assign(languageModel,{...model,name:model.id+' · comparison'});
   engine=new OfflineEngine(()=>{},{directory});
  }
  activeEngine=engine;const entry={id:model.id,bytes:model.bytes,sha:model.sha,rows:[]};report.models.push(entry);save();
  try{
   if(apple){entry.availability=await engine.availability();save();if(!entry.availability.available){entry.status='unavailable';throw new Error(entry.availability.availability);}}
   const load=performance.now();await engine.prepare();entry.loadMs=Math.round(performance.now()-load);
   const warmup=performance.now();
   await engine.complete('Reply with OK only.','Ready',{maxTokens:8});
   entry.warmupMs=Math.round(performance.now()-warmup);
   console.log(JSON.stringify({model:model.id,loadedMs:entry.loadMs}));
   for(let round=0;round<2;round++){
    seed=round?29:17;
    if(apple)engine.seed=seed;
    const live=[...moderationCases.map(c=>({...c,kind:'moderation'})),...directCases.map(c=>({...c,kind:'direct'}))];
    const cases=round?[...live.slice(17),...live.slice(0,17)]:live;
    for(const c of cases){
     const m=makeMeeting(c);let error;const controller=new MeetingController(m,()=>{},()=>{});if(c.cooldown)controller.lastSpokeAt=Date.now()-4000;
     const moderator=new LocalModerator(m,controller,engine,e=>{error=e;});requests=[];const start=performance.now();moderator.transcript();
     while(!m.metrics.assessments&&!error&&performance.now()-start<40_000)await new Promise(r=>setTimeout(r,10));
     moderator.close();const elapsedMs=Math.round(performance.now()-start);const intervention=m.interventions.find(i=>!i.id.startsWith('old-'));
     const actual=intervention?.reason||'silent';const failures=[];
     if(error||!m.metrics.assessments)failures.push(error||'No assessment');
     if(actual!==c.decision)failures.push(`Expected ${c.decision}, got ${actual}`);
     if(c.decision!=='silent')failures.push(...checkText(intervention?.text||'',c));
     if(intervention&&intervention.text.split(/\s+/).length>40)failures.push('Too verbose');
     if(!thinkingBudget&&requests.some(r=>r.reasoning?.trim()))failures.push('Unexpected thinking');
     const row={id:c.id,kind:c.kind,round,expected:c.decision,actual,elapsedMs,text:intervention?.text,failures,passed:!failures.length,requests};entry.rows.push(row);save();console.log(JSON.stringify({model:model.id,id:c.id,round,ms:elapsedMs,passed:row.passed,failures}));
    }
    for(const c of notesCases){
     requests=[];const start=performance.now();let text='',error;try{text=await localNotes(engine,makeMeeting(c));}catch(e){error=String(e);}
     const sections=notesSections(text),failures=[];if(error)failures.push(error);
     for(const key of c.empty||[])if(sections[key]!=='None recorded.')failures.push(key+' should be empty');
     for(const[key,patterns]of Object.entries(c.must||{}))for(const pattern of patterns)if(!new RegExp(pattern,'i').test(sections[key]))failures.push(key+' missing '+pattern);
     for(const[key,patterns]of Object.entries(c.forbidden||{}))for(const pattern of patterns)if(new RegExp(pattern,'i').test(sections[key]))failures.push(key+' contains forbidden '+pattern);
     if(!thinkingBudget&&requests.some(r=>r.reasoning?.trim()))failures.push('Unexpected thinking');
     const row={id:c.id,kind:'notes',round,elapsedMs:Math.round(performance.now()-start),text,sections,failures,passed:!failures.length,requests};entry.rows.push(row);save();console.log(JSON.stringify({model:model.id,id:c.id,round,ms:row.elapsedMs,passed:row.passed,failures}));
    }
   }
   entry.summary=Object.fromEntries(['moderation','direct','notes'].map(kind=>{const rows=entry.rows.filter(r=>r.kind===kind);return[kind,{passed:rows.filter(r=>r.passed).length,total:rows.length,medianMs:quantile(rows.map(r=>r.elapsedMs),.5),p95Ms:quantile(rows.map(r=>r.elapsedMs),.95)}];}));
   entry.summary.overall=entry.rows.filter(r=>r.passed).length/entry.rows.length;
   entry.summary.unnecessaryInterjections=entry.rows.filter(r=>r.expected==='silent'&&r.actual!=='silent').length;
   entry.summary.unexpectedFactSections=entry.rows.filter(r=>r.kind==='notes'&&r.failures.some(f=>/^(decisions|actionItems) should be empty/.test(f))).length;
   save();console.log(JSON.stringify({model:model.id,summary:entry.summary}));
  }finally{engine.close();activeEngine=undefined;await new Promise(r=>setTimeout(r,750));}
 }
}finally{globalThis.fetch=originalFetch;Object.assign(languageModel,current);save();}
