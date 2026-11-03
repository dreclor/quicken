import { describe, expect, it } from 'vitest';
import { groundedAssessment, isDirectQuestion, localNotes, LocalModerator } from '../server/local/moderator';
import { MeetingController } from '../server/controller';
import { FakeLocalEngine } from './local-fixture';
import { meeting } from './fixtures';
const turn=(text:string,id='a')=>({id,text,speaker:'Maya',source:'local' as const,at:Date.now()});

describe('local moderation grounding',()=>{
  it('leaves a fresh participant question for people to answer',()=>{
    const m=meeting({transcript:[turn('Which launch date do you prefer?')]});
    const a=groundedAssessment(JSON.stringify({decision:'unanswered',text:'Which date?',evidence:m.transcript[0].text,confidence:1}),m);
    expect(a.intervene).toBe(false);
    expect(isDirectQuestion('Hello, Quicken, what is next?')).toBe(true);
  });
  it('rejects unsupported facts and requires actual evidence before an interjection',()=>{
    const m=meeting({transcript:[turn('I will send the testing plan soon.')]});
    const a=groundedAssessment(JSON.stringify({decision:'ambiguous',text:'When will it be ready?',evidence:'Invented statement',confidence:1,actionItems:[{text:'Maya sends it tomorrow.',quote:'Maya promised tomorrow.'}],openQuestions:['Who is the manager?']}),m);
    expect(a.intervene).toBe(false);expect(a.actionItems).toEqual([]);expect(a.openQuestions).toEqual([]);
  });
  it('retains a clear assignment and does not re-ask its resolved owner or deadline',()=>{
    const m=meeting({transcript:[turn('Who will send the testing plan?'),turn('Maya will send the testing plan Friday.','b'),turn('Great, let us move on.','c')]});
    const a=groundedAssessment(JSON.stringify({decision:'ambiguous',text:'When will Maya send it?',evidence:'Maya will send the testing plan Friday.',confidence:1,openQuestions:['Who will send the testing plan?']}),m);
    expect(a.intervene).toBe(false);expect(a.openQuestions).toEqual([]);expect(a.actionItems).toContain('Maya will send the testing plan Friday.');
  });
  it('discards an in-flight custom answer when someone speaks again',async()=>{
    const m=meeting({processing:'local',mode:'rehearsal',transcript:[turn('Quicken, what is next?')]});
    const controller=new MeetingController(m,()=>{},()=>{}),engine=new FakeLocalEngine();
    let finish!:(s:string)=>void;
    engine.complete=()=>new Promise(resolve=>{finish=resolve;});
    const moderator=new LocalModerator(m,controller,engine,()=>{});moderator.transcript();
    await expect.poll(()=>!!finish).toBe(true);controller.speech(true);moderator.speech(true);
    finish('Choose the launch date.');await new Promise(r=>setTimeout(r,20));expect(m.interventions).toHaveLength(0);moderator.close();
  });
  it('does not turn moderator speech or invented follow-ups into decisions and open questions',async()=>{
    const m=meeting({transcript:[turn('What is first?'),{...turn('Choose the launch date.','b'),source:'moderator'}]});
    const engine=new FakeLocalEngine();
    engine.complete=async()=>JSON.stringify({summary:[{text:'The agenda starts with the launch date.',sourceId:'0-1',quote:'Choose the launch date.'}],decisions:[{text:'The team chose a date.',sourceId:'0-1',quote:'Choose the launch date.'}],actionItems:[],openQuestions:[{text:'What is the budget?',sourceId:'0-0',quote:'What is the budget?'}]});
    const notes=await localNotes(engine,m);expect(notes).toContain('agenda starts with the launch date');expect(notes).not.toContain('team chose');expect(notes).not.toContain('budget');
  });
});
