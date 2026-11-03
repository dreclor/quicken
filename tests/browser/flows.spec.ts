import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const token=readFileSync(resolve(process.env.QUICKEN_DATA_DIR || '.quicken','access-token'),'utf8').trim();
test.beforeEach(async({page})=>{await page.goto('/#access='+token);await expect(page.getByRole('heading',{name:/Meet with/})).toBeVisible();});
test('sample meeting, controls, transcript, notes, and export',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.screenshot({path:'../../work/quicken-home.png',fullPage:true});
  await page.getByRole('button',{name:'Try sample'}).click();
  await expect(page.getByRole('heading',{name:'Launch planning · sample'})).toBeVisible();
  await expect(page.getByText('Sample · scripted')).toBeVisible();
  await page.getByRole('button',{name:'Pause',exact:true}).click();
  await expect(page.getByText('Paused',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Resume',exact:true}).click();
  await expect(page.getByText('Alex: share the migration plan Thursday.',{exact:true})).toHaveCount(0);
  await expect(page.getByText('I’ll take migration too, and share the plan on Thursday.',{exact:true})).toBeVisible({timeout:25_000});
  await expect(page.getByText('Who owns customer migration?',{exact:true})).toHaveCount(0);
  await page.screenshot({path:'../../work/quicken-session.png',fullPage:true});
  await page.getByRole('button',{name:'End meeting',exact:true}).click();
  await expect(page.locator('.note-bullet').filter({hasText:'Alex: share the migration plan Thursday.'})).toBeVisible();
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'Export',exact:true}).click();expect((await download).suggestedFilename()).toBe('quicken-meeting.md');
  expect(errors).toEqual([]);
});
test('agenda file import, mode selection, and connection settings',async({page})=>{
  await page.getByRole('button',{name:'New meeting',exact:true}).click();
  await page.locator('input[type=file]').setInputFiles({name:'agenda.md',mimeType:'text/markdown',buffer:Buffer.from('Introductions (3 min)\nDecide a launch date (7 min)')});
  await expect(page.getByLabel('Agenda',{exact:true})).toHaveValue('Introductions (3 min)\nDecide a launch date (7 min)');
  await expect(page.getByText('10 min',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:/Microphone rehearsal/}).click();
  await expect(page.getByLabel('Meeting link')).toHaveCount(0);
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Settings'})).toBeVisible();
  await page.locator('summary').filter({hasText:'Cloud bot'}).click();
  await expect(page.getByLabel(/OPENAI API KEY/)).toHaveAttribute('type','password');
  await expect(page.getByLabel(/OPENAI API KEY/)).toHaveValue('');
  await page.getByRole('button',{name:'Close dialog'}).click();
  await page.screenshot({path:'../../work/quicken-new.png',fullPage:true});
});
test('small viewport still exposes the primary workflow',async({page})=>{
  await page.setViewportSize({width:800,height:900});
  await expect(page.getByRole('button',{name:'New meeting',exact:true})).toBeVisible();
  const width=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth}));expect(width.scroll).toBeLessThanOrEqual(width.client);
  await page.screenshot({path:'../../work/quicken-small.png',fullPage:true});
});

test('chicken popup shows the meeting and controls it',async({page,context})=>{
  const headers={'x-quicken-token':token};
  const created=await context.request.post('/api/meetings',{headers,data:{title:'Chicken popup test',mode:'demo',agenda:[{id:'a',title:'Choose our project topic',minutes:5}]}});
  const m=await created.json();await context.request.post(`/api/meetings/${m.id}/start`,{headers});
  await page.setViewportSize({width:350,height:440});
  await page.goto('/popup#access='+token);
  await expect(page.getByAltText('Quicken the chicken')).toBeVisible();
  await expect(page.getByText('Choose our project topic')).toBeVisible();
  await page.getByRole('button',{name:'Pause',exact:true}).click();
  await expect(page.getByText('Paused')).toBeVisible();
  await page.getByRole('button',{name:'Resume',exact:true}).click();
  await expect(page.getByText('Listening')).toBeVisible();
  await page.screenshot({path:'../../work/quicken-popup.png'});
  await context.request.post(`/api/meetings/${m.id}/end`,{headers});
});

test('meeting hint names microphone activity without starting capture',async({page})=>{
  await page.addInitScript(()=>{
    (window as any).captureCalls=0;
    navigator.mediaDevices.getUserMedia=async()=>{(window as any).captureCalls++;throw new Error('Ambient capture must not start');};
    window.quickenDesktop={showMain(){},onNavigate:()=>()=>{},setChickenExpanded(){},showChicken(){},closeChicken(){},getDetection:async()=>({enabled:true,apps:['Google Chrome']}),setDetection(){},onDetection:()=>()=>{}};
  });
  await page.setViewportSize({width:350,height:440});
  await page.goto('/popup#access='+token);
  await expect(page.getByText('Mic active')).toBeVisible();
  await expect(page.getByText('Google Chrome')).toBeVisible();
  expect(await page.evaluate(()=>(window as any).captureCalls)).toBe(0);
});

test('ending stops input and preserves a late transcript before closing audio',async({page,context})=>{
  const headers={'x-quicken-token':token};
  // The actual browser bridge runs against a deterministic provider fixture;
  // this checks shutdown ordering, not live model accuracy or audio routing.
  const created=await context.request.post('/api/meetings',{headers,data:{title:'Transcript finalization test',mode:'demo',agenda:[{id:'a',title:'Next steps',minutes:5}]}});
  const meeting=await created.json();
  const {bridgeToken}=JSON.parse(readFileSync(resolve(process.env.QUICKEN_DATA_DIR || '.quicken','meetings',meeting.id+'.json'),'utf8'));
  await page.addInitScript(()=>{
    const state:any={enabled:true,stopped:false,closed:false,events:[]};(window as any).drainFixture=state;
    const track={get enabled(){return state.enabled;},set enabled(v:boolean){state.enabled=v;},stop(){state.stopped=true;}};
    navigator.mediaDevices.getUserMedia=async()=>({getTracks:()=>[track]}) as any;
    (window as any).RTCPeerConnection=class{
      dc:any;
      addTrack(){}
      createDataChannel(){this.dc={readyState:'open',send:(raw:string)=>state.events.push(JSON.parse(raw)),close(){}};state.emit=(event:any)=>this.dc.onmessage({data:JSON.stringify(event)});return this.dc;}
      async createOffer(){return{sdp:'v=0\r\n'};}
      async setLocalDescription(){}
      async setRemoteDescription(){this.dc.onopen();}
      close(){state.closed=true;}
    };
  });
  await page.route('**/api/bridge/*/session',route=>route.fulfill({status:200,contentType:'application/sdp',body:'v=0\r\n'}));
  await page.goto(`/bridge#session=${meeting.id}&token=${bridgeToken}&rehearsal=1`);
  await page.getByRole('button',{name:'Start microphone',exact:true}).click();
  await expect(page.getByRole('status')).toHaveText('Listening');
  const ending=context.request.post(`/api/meetings/${meeting.id}/end`,{headers});
  await expect(page.getByRole('status')).toHaveText('Saving transcript…');
  expect(await page.evaluate(()=>({enabled:(window as any).drainFixture.enabled,closed:(window as any).drainFixture.closed}))).toEqual({enabled:false,closed:false});
  await page.evaluate(()=>{
    const fixture=(window as any).drainFixture;
    fixture.emit({type:'input_audio_buffer.committed'});
    fixture.emit({type:'conversation.item.input_audio_transcription.completed',item_id:'final-utterance',transcript:'The project review is Friday.'});
  });
  const finished=await(await ending).json();
  expect(finished.transcript.at(-1).text).toBe('The project review is Friday.');
  expect(finished.notes).toContain('project review is Friday');
  expect(finished.status).toBe('ended');
  await expect(page.getByRole('status')).toHaveText('Transcript saved');
  expect(await page.evaluate(()=>({stopped:(window as any).drainFixture.stopped,closed:(window as any).drainFixture.closed,responses:(window as any).drainFixture.events.filter((e:any)=>e.type==='response.create').length}))).toEqual({stopped:true,closed:true,responses:0});
});
