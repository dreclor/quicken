import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createApplication } from '../server/app';
import { FakeLocalEngine } from './local-fixture';
let runtime: ReturnType<typeof createApplication>, engine: FakeLocalEngine, base: string, directory: string;
const sockets: WebSocket[]=[];
beforeEach(async()=>{engine=new FakeLocalEngine();directory=mkdtempSync(join(tmpdir(),'quicken-local-test-'));runtime=createApplication({dataDir:directory,localEngine:engine});await new Promise<void>(r=>runtime.server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${(runtime.server.address() as any).port}`;});
afterEach(async()=>{for(const socket of sockets)socket.terminate();sockets.length=0;await runtime.close();rmSync(directory,{recursive:true,force:true});});
const api=(path:string,body?:unknown)=>fetch(base+'/api'+path,{method:body===undefined?'GET':'POST',headers:{'x-quicken-token':runtime.store.accessToken,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
const create=async()=>await(await api('/meetings',{title:'Offline meeting',mode:'rehearsal',agenda:[{id:'a',title:'Launch',minutes:5}]})).json();
async function bridge(id:string) {
  const socket=new WebSocket(base.replace('http:','ws:')+'/socket');sockets.push(socket);const events:any[]=[];
  socket.on('message',raw=>events.push(JSON.parse(raw.toString())));
  await new Promise<void>(r=>socket.once('open',r));
  socket.send(JSON.stringify({type:'auth',role:'bridge',sessionId:id,token:runtime.store.records.get(id)!.bridgeToken}));
  await expect.poll(()=>events.some(e=>e.type==='state')).toBe(true);
  socket.send(JSON.stringify({type:'local-start'}));await expect.poll(()=>events.some(e=>e.type==='local-ready')).toBe(true);
  return {socket,events};
}
describe('fully local session boundary',()=>{
  it('reports a second server port conflict without an uncaught WebSocket error',async()=>{
    const other=createApplication({dataDir:mkdtempSync(join(tmpdir(),'quicken-port-test-')),localEngine:new FakeLocalEngine()});
    const error=await new Promise<NodeJS.ErrnoException>(resolve=>{other.server.once('error',resolve);other.server.listen(Number(new URL(base).port),'127.0.0.1');});
    expect(error.code).toBe('EADDRINUSE');await other.close();
  });
  it('defaults to local, needs no provider credentials, and rejects the cloud audio endpoint',async()=>{
    runtime.store.settings.openaiApiKey='';runtime.store.settings.recallApiKey='';
    const m=await create();expect(m.processing).toBe('local');
    const started=await(await api(`/meetings/${m.id}/start`,{})).json();expect(started.bridgeUrl).toContain('offline=1');
    const denied=await fetch(base+`/api/bridge/${m.id}/session`,{method:'POST',headers:{'x-bridge-token':runtime.store.records.get(m.id)!.bridgeToken,'Content-Type':'application/sdp'},body:'v=0\r\n'});
    expect(denied.status).toBe(400);expect(engine.calls.prepare).toBe(1);
    const other=await create();expect((await api(`/meetings/${other.id}/start`,{})).status).toBe(409);
  });
  it('keeps final locally transcribed words and creates local notes at End',async()=>{
    const m=await create();await api(`/meetings/${m.id}/start`,{});const {socket,events}=await bridge(m.id);
    socket.send(JSON.stringify({type:'local-audio',pcm:Buffer.alloc(5120).toString('base64')}));await expect.poll(()=>engine.calls.audio).toBe(1);
    engine.finalOnFlush='Maya will send the launch plan on Friday.';
    const ending=api(`/meetings/${m.id}/end`,{});await expect.poll(()=>events.some(e=>e.type==='end')).toBe(true);
    socket.send(JSON.stringify({type:'local-drain'}));await ending;
    const saved=runtime.store.records.get(m.id)!.meeting;
    await expect.poll(()=>saved.notesStatus).toBe('ready');expect(saved.transcript[0]).toMatchObject({source:'local',text:'Maya will send the launch plan on Friday.'});expect(saved.notes).toContain('Friday');expect(engine.calls.complete).toBe(1);
  });
  it('discards locally generated voice if the host pauses before it is ready',async()=>{
    const m=await create();await api(`/meetings/${m.id}/start`,{});const {socket,events}=await bridge(m.id);
    let finish!:(value:Buffer<ArrayBuffer>)=>void;engine.voice=()=>new Promise(resolve=>{finish=resolve;});
    runtime.controllers.get(m.id)!.propose({reason:'addressed',text:'Launch is first.',confidence:1,evidence:'Direct question'});
    await expect.poll(()=>events.some(e=>e.type==='speak')).toBe(true);const intervention=events.find(e=>e.type==='speak').intervention;
    socket.send(JSON.stringify({type:'local-voice',id:intervention.id}));await expect.poll(()=>!!finish).toBe(true);
    await fetch(base+`/api/meetings/${m.id}`,{method:'PATCH',headers:{'x-quicken-token':runtime.store.accessToken,'Content-Type':'application/json'},body:JSON.stringify({paused:true})});
    finish(Buffer.from('voice'));await new Promise(r=>setTimeout(r,50));expect(events.some(e=>e.type==='local-voice')).toBe(false);
  });
  it('fires time reminders without asking the LLM',async()=>{
    const m=await create();await api(`/meetings/${m.id}/start`,{});const {events}=await bridge(m.id);
    const saved=runtime.store.records.get(m.id)!.meeting;saved.agendaStartedAt=Date.now()-4*60_000-1000;
    runtime.controllers.get(m.id)!.tick();await expect.poll(()=>events.some(e=>e.type==='speak')).toBe(true);
    expect(events.find(e=>e.type==='speak').intervention.reason).toBe('time');expect(engine.calls.complete).toBe(0);
  });
});
