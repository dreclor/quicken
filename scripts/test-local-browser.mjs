// Full browser + native engine test using a recording instead of a physical microphone.
import {chromium} from '@playwright/test';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../server/app.ts';
const source=process.argv[2];if(!source)throw new Error('Supply a prerecorded WAV.');
const cloudBenchmark=process.env.QUICKEN_BENCHMARK_ENGINE==='cloud';
const wav=readFileSync(source),external=[],originalFetch=globalThis.fetch;
let cloudRequests=0;
globalThis.fetch=(url,options)=>{if(cloudBenchmark&&String(url)==='https://api.openai.com/v1/responses'){cloudRequests++;return originalFetch(url,options);}if(new URL(String(url)).hostname!=='127.0.0.1'){external.push(String(url));throw new Error('External HTTP blocked');}return originalFetch(url,options);};
let benchmarkEngine;
if(process.env.QUICKEN_BENCHMARK_ENGINE==='apple'||cloudBenchmark){
 const {AppleAudioBenchmarkEngine}=await import('./apple-benchmark-audio-engine.mjs');
 const client=cloudBenchmark?new (await import('./cloud-benchmark-engine.mjs')).CloudBenchmarkEngine(process.env.QUICKEN_COMPARE_CLOUD):undefined;
 benchmarkEngine=new AppleAudioBenchmarkEngine(()=>{},{client,label:cloudBenchmark?'Cloud '+process.env.QUICKEN_COMPARE_CLOUD:undefined});
}
const app=createApplication({dataDir:mkdtempSync(join(tmpdir(),'quicken-browser-local-')),staticDir:'dist',localEngine:benchmarkEngine});
await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}`;
const headers={'x-quicken-token':app.store.accessToken,'Content-Type':'application/json'};
const api=async(path,body)=>{const r=await fetch(base+'/api'+path,{method:body===undefined?'GET':'POST',headers,...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await r.json();if(!r.ok)throw new Error(data.error);return data};
let browser;const report={kind:cloudBenchmark?'Prerecorded input; local ASR/voice with cloud LLM; not a physical meeting':'Prerecorded input through real browser Web Audio and native AI; not a physical meeting',externalRequests:external};
try{
 const m=await api('/meetings',{title:'Local browser verification',mode:'rehearsal',processing:'local',agenda:[{id:'a',title:'Choose the launch date',minutes:5}]});const {bridgeUrl}=await api(`/meetings/${m.id}/start`,{});
 browser=await chromium.launch({headless:true,args:['--mute-audio','--autoplay-policy=no-user-gesture-required']});const page=await browser.newPage();
 await page.route('**/*',route=>{const url=route.request().url();if(url===base+'/fixture.wav')return route.fulfill({contentType:'audio/wav',body:wav});if(!url.startsWith(base+'/')){external.push(url);return route.abort();}return route.continue();});
 await page.addInitScript(()=>{
   window.audioVerification={firstVoiceAt:0,voicePeak:0,inputEndedAt:0};
   const original=AudioBufferSourceNode.prototype.start;AudioBufferSourceNode.prototype.start=function(...args){if(this.buffer?.sampleRate===22050){const state=window.audioVerification;state.firstVoiceAt ||= Date.now();for(const sample of this.buffer.getChannelData(0))state.voicePeak=Math.max(state.voicePeak,Math.abs(sample));}return original.apply(this,args);};
   navigator.mediaDevices.getUserMedia=async()=>{const context=new AudioContext();await context.resume();const data=await(await fetch('/fixture.wav')).arrayBuffer(),buffer=await context.decodeAudioData(data),source=context.createBufferSource(),output=context.createMediaStreamDestination();source.buffer=buffer;source.connect(output);source.onended=()=>{window.audioVerification.inputEndedAt=Date.now();};source.start(context.currentTime+0.4);window.testInputContext=context;return output.stream;};
 });
 const timeline=[];page.on('websocket',socket=>socket.on('framereceived',frame=>{try{const e=JSON.parse(String(frame.payload));if(['speak','stop','voice-error','error','local-voice-done'].includes(e.type))timeline.push({at:Date.now(),type:e.type,message:e.message});}catch{}}));
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(base+bridgeUrl);await page.getByRole('button',{name:'Start microphone',exact:true}).click();
 const deadline=Date.now()+35_000;while(!app.store.records.get(m.id).meeting.transcript.some(t=>t.source==='moderator')){if(Date.now()>deadline)throw new Error('Timed out waiting for spoken browser response');await new Promise(resolve=>setTimeout(resolve,100));}
 const state=await page.evaluate(()=>window.audioVerification);report.speechEndToFirstPlaybackMs=state.firstVoiceAt-state.inputEndedAt;report.voicePeak=state.voicePeak;
 await api(`/meetings/${m.id}/end`,{});const notesDeadline=Date.now()+60_000;while(app.store.records.get(m.id).meeting.notesStatus==='generating'){if(Date.now()>notesDeadline)throw new Error('Notes timed out');await new Promise(resolve=>setTimeout(resolve,100));}
 const saved=app.store.records.get(m.id).meeting;report.transcript=saved.transcript;report.notes=saved.notes;report.meetingError=saved.error;report.interventions=saved.interventions;report.timeline=timeline;report.errors=errors;report.passed=external.length===0&&errors.length===0&&state.voicePeak>0.01&&saved.notesStatus==='ready'&&saved.transcript.some(t=>t.source==='local'&&t.text.includes('quicken'))&&saved.transcript.some(t=>t.source==='moderator'&&t.text.includes('launch date'));
 mkdirSync('verification',{recursive:true});writeFileSync('verification/local-browser-synthetic.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1;
}catch(error){report.passed=false;report.error=String(error);mkdirSync('verification',{recursive:true});writeFileSync('verification/local-browser-synthetic.json',JSON.stringify(report,null,2));console.error(error);for(const r of app.store.records.values())console.log(JSON.stringify({transcript:r.meeting.transcript,error:r.meeting.error,interventions:r.meeting.interventions}));process.exitCode=1;}
finally{await browser?.close();await app.close();globalThis.fetch=originalFetch;if(cloudBenchmark){report.cloudRequests=cloudRequests;writeFileSync('verification/local-browser-synthetic.json',JSON.stringify(report,null,2));}}
