// Real OpenAI API smoke test using a supplied WAV file, without capturing a microphone.
// Requires a running Quicken server and incurs normal API usage.
import {chromium} from '@playwright/test';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const file=process.argv[2];
if(!file)throw new Error('Usage: node scripts/rehearse.mjs /absolute/path/test-audio.wav');
const base=process.env.QUICKEN_URL||'http://127.0.0.1:4317';
const token=readFileSync(resolve(process.env.QUICKEN_DATA_DIR||'.quicken','access-token'),'utf8').trim();
const api=async(path,body)=>{const r=await fetch(base+'/api'+path,{method:body?'POST':'GET',headers:{'x-quicken-token':token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});if(!r.ok)throw new Error((await r.json()).error);return await r.json();};
const meeting=await api('/meetings',{title:'Live API rehearsal',mode:'rehearsal',agenda:[{id:'scope',title:'Decide launch scope',minutes:10},{id:'owners',title:'Assign owners and deadlines',minutes:5}],intensity:'active'});
const start=await api(`/meetings/${meeting.id}/start`,{});
const browser=await chromium.launch({headless:true,args:['--disable-audio-input','--disable-audio-output','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream',`--use-file-for-fake-audio-capture=${resolve(file)}%noloop`,'--autoplay-policy=no-user-gesture-required']});
const page=await browser.newPage();
await page.addInitScript(() => {
  window.voiceTestEvents=[];
  window.remoteAudioPeak=0;
  const nativeAdd=RTCPeerConnection.prototype.addTrack;
  const observed=new WeakSet();
  RTCPeerConnection.prototype.addTrack=function(...args){
    if(!observed.has(this)){
      observed.add(this);window.voiceTestPc=this;
      this.addEventListener('track',e=>{
        const ctx=new AudioContext({sinkId:{type:'none'}}), source=ctx.createMediaStreamSource(e.streams[0]), meter=ctx.createAnalyser();
        source.connect(meter).connect(ctx.destination);window.voiceTestAudioContext=ctx;void ctx.resume();const data=new Float32Array(meter.fftSize);
        const timer=setInterval(()=>{meter.getFloatTimeDomainData(data);window.remoteAudioPeak=Math.max(window.remoteAudioPeak,...data.map(Math.abs));},20);
        e.track.addEventListener('ended',()=>{clearInterval(timer);void ctx.close();});
      });
    }
    return nativeAdd.apply(this,args);
  };
  const original=RTCPeerConnection.prototype.createDataChannel;
  RTCPeerConnection.prototype.createDataChannel=function(...args){
    const dc=original.apply(this,args);
    dc.addEventListener('message',e=>{const d=JSON.parse(e.data);if(['response.done','error','input_audio_buffer.speech_started','input_audio_buffer.speech_stopped','output_audio_buffer.started','output_audio_buffer.stopped'].includes(d.type))window.voiceTestEvents.push({at:Date.now(),...d});});
    return dc;
  };
});
const errors=[];
page.on('pageerror',e=>errors.push(e.message));
try{
  await page.goto(base+start.bridgeUrl);
  await page.getByRole('button',{name:'Start microphone',exact:true}).click();
  const started=Date.now();let result;
  while(Date.now()-started<60_000){
    await new Promise(r=>setTimeout(r,1000));
    const s=await api('/state');result=s.meetings.find(x=>x.id===meeting.id);
    if(result.error){console.log(JSON.stringify({stage:'provider',error:result.error}));break;}
    if(result.interventions.some(x=>x.state==='spoken'))break;
  }
  await page.screenshot({path:resolve('../../work/quicken-rehearsal.png')});
  const report={mode:'real OpenAI API, synthetic audio; NOT a real meeting',at:new Date().toISOString(),meetingId:meeting.id,status:result?.status,bridgeConnected:result?.bridgeConnected,transcript:result?.transcript,interventions:result?.interventions,metrics:result?.metrics,error:result?.error,browserErrors:errors,remoteAudioPeak:await page.evaluate(()=>window.remoteAudioPeak),audioDiagnostics:await page.evaluate(async()=>({contextState:window.voiceTestAudioContext?.state,connectionState:window.voiceTestPc?.connectionState,stats:window.voiceTestPc?[...(await window.voiceTestPc.getStats()).values()].filter(s=>['inbound-rtp','outbound-rtp'].includes(s.type)):[]})),events:await page.evaluate(()=>window.voiceTestEvents)};
  writeFileSync(resolve('../../work/live-rehearsal-result.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
  if(!result?.interventions.some(x=>x.state==='spoken')||report.remoteAudioPeak<0.001)process.exitCode=1;
}finally{await browser.close();await api(`/meetings/${meeting.id}/end`,{});}
