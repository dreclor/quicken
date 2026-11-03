// Reuses the real browser/audio test with isolated caches for each model and repetition.
// node --import tsx scripts/compare-local-audio.mjs /path/to/recorded-question.wav
import {languageModel} from '../server/local/engine.ts';
import {readFileSync,writeFileSync,mkdtempSync,symlinkSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {homedir,tmpdir} from 'node:os';
const source=process.argv[2];if(!source)throw new Error('Supply the recorded question WAV.');
const current={...languageModel,id:'Qwen3-4B-Instruct-2507'};
const models=[current,...JSON.parse(readFileSync('verification/model-candidates.json','utf8')).reverse()];
const shared=join(homedir(),'Library/Application Support/Quicken/LocalModels'),cache=join(homedir(),'Library/Caches/Quicken/model-comparison');
const previous=existsSync('verification/local-browser-synthetic.json')?readFileSync('verification/local-browser-synthetic.json'):null;
const originalFetch=globalThis.fetch;let seed=17;
globalThis.fetch=(url,options)=>{
 if(new URL(String(url)).pathname.endsWith('/v1/chat/completions'))options={...options,body:JSON.stringify({...JSON.parse(options.body),chat_template_kwargs:{enable_thinking:false},seed})};
 return originalFetch(url,options);
};
const results=[];
try{
 for(const model of models)for(let round=0;round<3;round++){
  const directory=mkdtempSync(join(tmpdir(),'quicken-audio-compare-'));
  symlinkSync(join(model.id===current.id?shared:cache,model.file),join(directory,model.file));symlinkSync(join(shared,'speech'),join(directory,'speech'));symlinkSync(join(shared,'speech-ready.json'),join(directory,'speech-ready.json'));
  Object.assign(languageModel,{...model,name:model.id+' · comparison'});process.env.QUICKEN_MODELS_DIR=directory;seed=[17,29,41][round];process.exitCode=0;
  await import('./test-local-browser.mjs?model='+model.id+'&round='+round);
  const report=JSON.parse(readFileSync('verification/local-browser-synthetic.json','utf8'));
  results.push({model:model.id,round,voiceCache:'Empty before this run',...report});
  writeFileSync('verification/model-audio-comparison.json',JSON.stringify({kind:'Prerecorded audio, actual browser/ASR/LLM/native voice; no physical meeting',results},null,2)+'\n');
  console.log(JSON.stringify({model:model.id,round,ms:report.speechEndToFirstPlaybackMs,passed:report.passed}));
 }
}finally{
 Object.assign(languageModel,current);globalThis.fetch=originalFetch;delete process.env.QUICKEN_MODELS_DIR;if(previous)writeFileSync('verification/local-browser-synthetic.json',previous);
 // Quality failures are recorded, not hidden as an interrupted benchmark.
 process.exitCode=results.length===models.length*3?0:1;
}
