// Replays a user-supplied 16 kHz mono PCM WAV through the real local stack.
// No microphone is opened. External requests are blocked in the Node process.
// Run: node --import tsx scripts/test-local.mjs /path/to/speech.wav
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createApplication } from '../server/app.ts';
const source = process.argv[2]; if (!source) throw new Error('Supply a 16 kHz mono PCM WAV file.');
const wav=readFileSync(source); let pcm, rate, channels, bits;
for(let i=12;i+8<=wav.length;){const name=wav.toString('ascii',i,i+4),size=wav.readUInt32LE(i+4);if(name==='fmt '){channels=wav.readUInt16LE(i+10);rate=wav.readUInt32LE(i+12);bits=wav.readUInt16LE(i+22);}if(name==='data')pcm=wav.subarray(i+8,i+8+size);i+=8+size+(size%2);}
if(!pcm || rate!==16000 || channels!==1 || bits!==16)throw new Error('Expected mono 16 kHz 16-bit PCM WAV.');
const originalFetch=globalThis.fetch, external=[];
globalThis.fetch=(url,options)=>{const address=new URL(String(url));if(address.hostname!=='127.0.0.1'){external.push(address.origin);throw new Error('External request blocked in local verification.');}return originalFetch(url,options);};
const runtime=createApplication({dataDir:mkdtempSync(join(tmpdir(),'quicken-local-smoke-'))});
await new Promise(resolve=>runtime.server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${runtime.server.address().port}`,headers={'x-quicken-token':runtime.store.accessToken,'Content-Type':'application/json'};
const api=async(path,body)=>{const r=await fetch(base+'/api'+path,{method:body===undefined?'GET':'POST',headers,...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await r.json();if(!r.ok)throw new Error(data.error);return data;};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const report={kind:'synthetic local audio, not a real meeting',externalRequests:external};
let socket, meeting;
try{
  meeting=await api('/meetings',{title:'Local moderator verification',mode:'rehearsal',processing:'local',agenda:[{id:'a',title:'Choose the launch date',minutes:5},{id:'b',title:'Assign testing owners',minutes:5}]});
  const startup=Date.now();const started=await api(`/meetings/${meeting.id}/start`,{});report.startupMs=Date.now()-startup;
  const params=new URLSearchParams(started.bridgeUrl.split('#')[1]);
  socket=new WebSocket(base.replace('http:','ws:')+'/socket');
  const events=[];let stoppedAt=0,voice;const chunks=[];let voiceRate=22050;
  socket.on('message',raw=>{const event=JSON.parse(raw);events.push(event);
    if(event.type==='speak'){report.intervention=event.intervention;socket.send(JSON.stringify({type:'local-voice',id:event.intervention.id}));}
    if(event.type==='local-voice-chunk'){
      if(!chunks.length){report.speechStopToFirstAudioMs=Date.now()-stoppedAt;socket.send(JSON.stringify({type:'playback',id:event.id,phase:'started'}));}
      chunks.push(Buffer.from(event.pcm,'base64'));voiceRate=event.rate;
    }
    if(event.type==='local-voice-done'){
      const pcm=Buffer.concat(chunks),header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(pcm.length+36,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(voiceRate,24);header.writeUInt32LE(voiceRate*2,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40);voice=Buffer.concat([header,pcm]);report.voiceBytes=voice.length;
      socket.send(JSON.stringify({type:'transcript',entry:{id:'moderator-'+event.id,text:report.intervention.text,speaker:'Quicken',source:'moderator'}}));socket.send(JSON.stringify({type:'playback',id:event.id,phase:'finished'}));
    }
    if(event.type==='local-voice'){voice=Buffer.from(event.wav,'base64');report.speechStopToVoiceReadyMs=Date.now()-stoppedAt;report.voiceBytes=voice.length;socket.send(JSON.stringify({type:'playback',id:event.id,phase:'started'}));socket.send(JSON.stringify({type:'transcript',entry:{id:'moderator-'+event.id,text:report.intervention.text,speaker:'Quicken',source:'moderator'}}));socket.send(JSON.stringify({type:'playback',id:event.id,phase:'finished'}));}
    if(event.type==='end')socket.send(JSON.stringify({type:'local-drain'}));
    if(event.type==='error')console.log('Local error:',event.message);
  });
  const waitFor=async(test,timeout=30_000)=>{const deadline=Date.now()+timeout;while(!test()){if(Date.now()>deadline)throw new Error('Timed out waiting for local pipeline.');await sleep(50);}};
  await new Promise(resolve=>socket.on('open',resolve));
  socket.send(JSON.stringify({type:'auth',role:'bridge',sessionId:meeting.id,token:params.get('token')}));await waitFor(()=>events.some(e=>e.type==='state'));
  socket.send(JSON.stringify({type:'local-start'}));await waitFor(()=>events.some(e=>e.type==='local-ready'),120_000);
  for(let i=0;i<6;i++){socket.send(JSON.stringify({type:'local-audio',pcm:Buffer.alloc(5120).toString('base64')}));await sleep(160);}
  socket.send(JSON.stringify({type:'speech',started:true}));
  for(let i=0;i<pcm.length;i+=5120){socket.send(JSON.stringify({type:'local-audio',pcm:pcm.subarray(i,i+5120).toString('base64')}));await sleep(160);}
  stoppedAt=Date.now();socket.send(JSON.stringify({type:'speech',started:false}));
  for(let i=0;i<16;i++){socket.send(JSON.stringify({type:'local-audio',pcm:Buffer.alloc(5120).toString('base64')}));await sleep(160);}
  await waitFor(()=>voice,30_000);
  await api(`/meetings/${meeting.id}/end`,{});
  await waitFor(()=>['ready','error'].includes(runtime.store.records.get(meeting.id).meeting.notesStatus),120_000);
  const saved=runtime.store.records.get(meeting.id).meeting;
  report.transcript=saved.transcript;report.notes=saved.notes;report.notesStatus=saved.notesStatus;
  report.passed=external.length===0&&saved.transcript.some(t=>t.source==='local')&&!!voice&&saved.notesStatus==='ready';
  mkdirSync('verification',{recursive:true});writeFileSync('verification/local-pipeline-synthetic.json',JSON.stringify(report,null,2));if(voice)writeFileSync('verification/local-pipeline-voice.wav',voice);
  console.log(JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1;
}catch(error){console.error(error.message);if(meeting){const saved=runtime.store.records.get(meeting.id).meeting;console.log(JSON.stringify({transcript:saved.transcript,interventions:saved.interventions,error:saved.error,metrics:saved.metrics},null,2));}process.exitCode=1;}
finally{socket?.close();await runtime.close();globalThis.fetch=originalFetch;}
