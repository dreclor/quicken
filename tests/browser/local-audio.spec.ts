import {test,expect,type WebSocketRoute} from '@playwright/test';
import {meeting} from '../fixtures';
test('local browser capture streams PCM, plays voice chunks, cancels on speech, and flushes on End',async({page})=>{
  const external:string[]=[],events:any[]=[];let socket:WebSocketRoute;
  page.on('request',request=>{if(!request.url().startsWith('http://127.0.0.1:4317/'))external.push(request.url());});
  await page.addInitScript(()=>{
    navigator.mediaDevices.getUserMedia=async()=>{
      const context=new AudioContext();await context.resume();const tone=context.createOscillator(),gain=context.createGain(),output=context.createMediaStreamDestination();
      gain.gain.value=0;tone.connect(gain).connect(output);tone.start();
      (window as any).localAudioFixture={context,gain,track:output.stream.getAudioTracks()[0]};return output.stream;
    };
  });
  const m=meeting({id:'offline-fixture',mode:'rehearsal',processing:'local'});
  await page.routeWebSocket('**/socket',ws=>{socket=ws;ws.onMessage(raw=>{const e=JSON.parse(String(raw));events.push(e);if(e.type==='auth')ws.send(JSON.stringify({type:'state',meeting:m}));if(e.type==='local-start')ws.send(JSON.stringify({type:'local-ready'}));if(e.type==='local-drain')ws.send(JSON.stringify({type:'local-drained'}));});});
  await page.goto('/bridge#session=offline-fixture&token=fixture&rehearsal=1&offline=1');
  await page.getByRole('button',{name:'Start microphone',exact:true}).click();
  await expect(page.getByRole('status')).toHaveText('Listening');
  await expect.poll(()=>events.filter(e=>e.type==='local-audio').length).toBeGreaterThan(1);
  const pcm=Buffer.alloc(4410);for(let i=0;i<2205;i++)pcm.writeInt16LE(Math.round(Math.sin(i/22050*2*Math.PI*440)*8000),i*2);
  const send=(e:any)=>socket.send(JSON.stringify(e));
  send({type:'speak',intervention:{id:'one',text:'Launch is first.'}});
  await expect.poll(()=>events.some(e=>e.type==='local-voice'&&e.id==='one')).toBe(true);
  send({type:'local-voice-chunk',id:'one',pcm:pcm.toString('base64'),rate:22050});
  // Playback must start before the server says the clip is complete.
  await expect.poll(()=>events.some(e=>e.type==='playback'&&e.id==='one'&&e.phase==='started')).toBe(true);
  send({type:'local-voice-chunk',id:'one',pcm:pcm.toString('base64'),rate:22050});send({type:'local-voice-done',id:'one'});
  await expect.poll(()=>events.some(e=>e.type==='playback'&&e.id==='one'&&e.phase==='finished')).toBe(true);
  expect(events.find(e=>e.type==='transcript').entry.text).toBe('Launch is first.');
  send({type:'speak',intervention:{id:'two',text:'This should be interrupted.'}});
  await expect.poll(()=>events.some(e=>e.type==='local-voice'&&e.id==='two')).toBe(true);
  send({type:'local-voice-chunk',id:'two',pcm:Buffer.concat(Array(50).fill(pcm)).toString('base64'),rate:22050});
  await expect.poll(()=>events.some(e=>e.type==='playback'&&e.id==='two'&&e.phase==='started')).toBe(true);
  await page.evaluate(()=>{(window as any).localAudioFixture.gain.gain.value=0.2;});
  await expect.poll(()=>events.some(e=>e.type==='speech'&&e.started)).toBe(true);
  await expect.poll(()=>events.some(e=>e.type==='transcript'&&e.entry.id==='moderator-two'&&e.entry.text.includes('interrupted'))).toBe(true);
  send({type:'local-voice-done',id:'two'});send({type:'end',drainMs:0});
  await expect(page.getByRole('status')).toHaveText('Transcript saved');
  expect(events.some(e=>e.type==='playback'&&e.id==='two'&&e.phase==='finished')).toBe(false);
  expect(events.some(e=>e.type==='local-drain')).toBe(true);
  expect(await page.evaluate(()=>(window as any).localAudioFixture.track.readyState)).toBe('ended');
  expect(external).toEqual([]);
});

test('opening local meeting audio does not start capture before the host chooses devices',async({page})=>{
  await page.addInitScript(()=>{(window as any).captures=0;navigator.mediaDevices.getUserMedia=async()=>{(window as any).captures++;throw new Error('Must not capture');};});
  await page.goto('/bridge#session=local-fixture&token=fixture&local=1&offline=1');
  await expect(page.getByRole('status')).toHaveText('Connect audio');
  expect(await page.evaluate(()=>(window as any).captures)).toBe(0);
});
