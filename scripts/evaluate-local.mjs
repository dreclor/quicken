// Small synthetic regression set against the installed real local model.
// This is not a real meeting or a broad accuracy benchmark.
import { OfflineEngine } from '../server/local/engine.ts';
import { LocalModerator, localNotes } from '../server/local/moderator.ts';
import { MeetingController } from '../server/controller.ts';
import { meeting } from '../tests/fixtures.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
const engine = new OfflineEngine(() => {}), results=[];
const scenarios = [
  {name:'clear assignment',turns:['Maya will send the testing plan on Friday.'],expect:false},
  {name:'fresh question',turns:['Which launch date do you prefer?'],expect:false},
  {name:'missing deadline',turns:['We need the testing plan before release.','I will send the testing plan soon.'],expect:true,reason:'ambiguous'},
  {name:'explicitly unanswered question',turns:['How much will the launch campaign cost?','I do not know the cost yet.','Let us skip the cost and move on to the website design.'],expect:true,reason:'unanswered'},
  {name:'sustained drift',turns:['We need to choose the launch date today.','Did you watch the football match last night?','Yes, the final goal was incredible.','I think the referee missed a penalty in the second half.'],expect:true,reason:'off_track'},
  {name:'resolved question',turns:['Who will send the testing plan?','Maya will send the testing plan Friday.','Great, let us move on to the launch date.'],expect:false},
];
const transcript=turns=>turns.map((text,i)=>({id:String(i),speaker:i%2?'Alex':'Maya',text,source:'local',at:Date.now()}));
try {
  await engine.prepare();
  for(const scenario of scenarios) {
    const m=meeting({processing:'local',mode:'rehearsal',agenda:[{id:'a',title:'Launch planning',minutes:5}],transcript:transcript(scenario.turns)});
    let error;const controller=new MeetingController(m,()=>{},()=>{}), moderator=new LocalModerator(m,controller,engine,message=>{error=message;});
    const start=Date.now();moderator.transcript();
    while(!m.metrics.assessments&&!error&&Date.now()-start<30_000)await new Promise(resolve=>setTimeout(resolve,50));
    moderator.close();const intervention=m.interventions[0];
    const result={scenario:scenario.name,ms:Date.now()-start,intervention,actionItems:m.actionItems,error,passed:!error&&m.metrics.assessments>0&&!!intervention===scenario.expect&&(!scenario.reason||intervention?.reason===scenario.reason)};
    results.push(result);console.log(JSON.stringify(result));
  }
  const notes=await localNotes(engine,meeting({transcript:[...transcript(['Quicken, what is the first item on our agenda?']),{id:'answer',speaker:'Quicken',text:'The first item on our agenda is to choose the launch date.',source:'moderator',at:Date.now()},...transcript(['I will send the testing plan on Friday.'])]}));
  const passed=results.every(r=>r.passed);mkdirSync('verification',{recursive:true});writeFileSync('verification/local-semantic-evaluation.json',JSON.stringify({kind:'Synthetic text scenarios with the real local model',results,notes,passed},null,2));console.log(notes);if(!passed)process.exitCode=1;
}finally{engine.close();}
