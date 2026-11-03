import {afterEach,beforeEach,describe,it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../server/app';
import {Store} from '../server/store';
import {WebSocket} from 'ws';
import {FakeLocalEngine} from './local-fixture';
let runtime:ReturnType<typeof createApplication>,dir:string,base:string;
beforeEach(async()=>{dir=mkdtempSync(join(tmpdir(),'quicken-test-'));runtime=createApplication({dataDir:dir,localEngine:new FakeLocalEngine()});await new Promise<void>(resolve=>runtime.server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${(runtime.server.address() as any).port}`;});
afterEach(async()=>{await runtime.close();rmSync(dir,{recursive:true,force:true});});
const request=(path:string,method='GET',body?:unknown,token?:string)=>fetch(base+path,{method,headers:{'x-quicken-token':token??runtime.store.accessToken,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
const create=async()=>await(await request('/api/meetings','POST',{title:'Test agenda',mode:'demo',agenda:[{id:'a',title:'Launch',minutes:5}]})).json();
describe('local API',()=>{
  it('requires the owner credential and never serializes provider secrets',async()=>{expect((await request('/api/state','GET',undefined,'wrong')).status).toBe(401);runtime.store.settings.openaiApiKey='secret-must-not-leak';const state=await(await request('/api/state')).text();expect(state).not.toContain('secret-must-not-leak');expect(state).toContain('hasOpenaiKey');});
  it('runs the full demo flow, saves notes, and persists after restart',async()=>{const m=await create();expect((await request(`/api/meetings/${m.id}/start`,'POST')).ok).toBe(true);for(let step=0;step<6;step++)await request(`/api/meetings/${m.id}/demo-step`,'POST',{step});await request(`/api/meetings/${m.id}/end`,'POST');await new Promise(r=>setTimeout(r,250));const saved=new Store(dir).records.get(m.id)!.meeting;expect(saved.status).toBe('ended');expect(saved.transcript).toHaveLength(6);expect(saved.notes).toContain('share the migration plan Thursday');const exportText=await(await request(`/api/meetings/${m.id}/export`)).text();expect(exportText).toContain('Full transcript');expect(exportText).toContain('Maya');});
  it('rejects invalid uploads, invalid sessions, and duplicate starts',async()=>{expect((await request('/api/meetings','POST',{title:'bad'})).status).toBe(400);const m=await create();await request(`/api/meetings/${m.id}/start`,'POST');expect((await request(`/api/meetings/${m.id}/start`,'POST')).status).toBe(409);const r=await fetch(base+'/api/agenda/import',{method:'POST',headers:{'x-quicken-token':runtime.store.accessToken},body:new FormData()});expect(r.status).toBe(400);});
  it('revokes the bridge capability when a meeting ends',async()=>{const m=await create(),token=runtime.store.records.get(m.id)!.bridgeToken;await request(`/api/meetings/${m.id}/end`,'POST');const r=await fetch(base+`/api/bridge/${m.id}/session`,{method:'POST',headers:{'x-bridge-token':token,'Content-Type':'application/sdp'},body:'v=0\r\n'});expect(r.status).toBe(401);});
  it('includes final words delivered during End, blocks new work, and ends only once',async()=>{
    const m=await create(),record=runtime.store.records.get(m.id)!,token=record.bridgeToken;
    const bridge=new WebSocket(base.replace('http:','ws:')+'/socket');
    const receive=(type:string)=>new Promise<any>((resolve,reject)=>{
      const timer=setTimeout(()=>{bridge.off('message',listener);reject(new Error(`Missing ${type}`));},1500);
      const listener=(raw:any)=>{const data=JSON.parse(raw.toString());if(data.type===type){clearTimeout(timer);bridge.off('message',listener);resolve(data);}};
      bridge.on('message',listener);
    });
    try{
      await new Promise<void>(resolve=>bridge.once('open',resolve));
      const state=receive('state');bridge.send(JSON.stringify({type:'auth',role:'bridge',sessionId:m.id,token}));await state;
      const command=receive('end');
      const firstEnd=request(`/api/meetings/${m.id}/end`,'POST');
      expect((await command).drainMs).toBeGreaterThan(0);
      const secondEnd=request(`/api/meetings/${m.id}/end`,'POST');
      expect(record.meeting.status).toBe('ending');expect(record.meeting.notesStatus).toBe('none');
      const denied=await fetch(base+`/api/bridge/${m.id}/session`,{method:'POST',headers:{'x-bridge-token':token,'Content-Type':'application/sdp'},body:'v=0\r\n'});
      expect(denied.status).toBe(401);
      expect((await request(`/api/meetings/${m.id}`,'PATCH',{paused:false})).status).toBe(409);
      bridge.send(JSON.stringify({type:'ready'}));
      bridge.send(JSON.stringify({type:'assessment',revision:0,assessment:{intervene:true,reason:'addressed',text:'Do not speak after End.',evidence:'late',confidence:1,topic:'late',openQuestions:[],decisions:[],actionItems:[]}}));
      bridge.send(JSON.stringify({type:'transcript',entry:{id:'last-words',speaker:'Alex',text:'I will send the plan on Friday.',source:'realtime'}}));
      bridge.send(JSON.stringify({type:'drained'}));
      const [a,b]=await Promise.all([firstEnd,secondEnd]);expect(a.ok&&b.ok).toBe(true);
      expect(record.meeting.status).toBe('ended');expect(record.meeting.transcript.at(-1)?.text).toContain('Friday');
      expect(record.meeting.notes).toContain('Friday');expect(record.meeting.metrics.assessments).toBe(0);
      expect(record.meeting.interventions).toHaveLength(0);expect(record.bridgeToken).not.toBe(token);
      const endedToken=record.bridgeToken;await request(`/api/meetings/${m.id}/end`,'POST');expect(record.bridgeToken).toBe(endedToken);
    }finally{bridge.terminate();}
  });
  it('recovers a session interrupted during transcript finalization',async()=>{
    const m=await create(),record=runtime.store.records.get(m.id)!;
    record.meeting.status='ending';record.meeting.endedAt=Date.now();runtime.store.save(record);
    const recovered=new Store(dir).records.get(m.id)!;
    expect(recovered.meeting.status).toBe('ended');expect(recovered.bridgeToken).not.toBe(record.bridgeToken);
    expect(recovered.meeting.error).toContain('finishing this transcript');
  });
  it('starts local audio without a Recall account and requires capability auth',async()=>{
    runtime.store.settings.recallApiKey='';
    const m=await(await request('/api/meetings','POST',{title:'Local class meeting',mode:'local',agenda:[{id:'a',title:'Project plan',minutes:5}]})).json();
    const r=await request(`/api/meetings/${m.id}/start`,'POST');expect(r.status).toBe(200);
    const started=await r.json();expect(started.bridgeUrl).toContain('&local=1');expect(runtime.store.records.get(m.id)!.botId).toBeUndefined();
    const unauthorized=await fetch(base+`/api/bridge/${m.id}/session`,{method:'POST',headers:{'Content-Type':'application/sdp'},body:'v=0\r\n'});expect(unauthorized.status).toBe(401);
  });
  it('imports a real agenda upload',async()=>{const data=new FormData();data.append('file',new Blob(['Launch (5 min)\nOwners (10 min)']),'agenda.md');const r=await fetch(base+'/api/agenda/import',{method:'POST',headers:{'x-quicken-token':runtime.store.accessToken},body:data});expect(r.ok).toBe(true);expect((await r.json()).agenda[1]).toMatchObject({title:'Owners',minutes:10});});
});
