import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {AppState} from '../../shared/types';
const token=readFileSync(resolve(process.env.QUICKEN_DATA_DIR||'.quicken','access-token'),'utf8').trim();
const fixture=(reason:'disabled'|'unsupported'|'notReady'|'available'):AppState=>({meetings:[],settings:{hasOpenaiKey:false,hasRecallKey:false,recallRegion:'us-west-2',publicBaseUrl:'',realtimeModel:'fixture',notesModel:'fixture'},localAI:{status:'missing',provider:reason==='available'?'apple':'qwen',preference:'auto',model:'Fixture',language:'English',detail:'Set up',apple:{available:reason==='available',reason},qwenInstalled:false,speechInstalled:false}});
for(const reason of ['disabled','unsupported','notReady','available'] as const)test(`compact model setup: ${reason}`,async({page})=>{
  const state=fixture(reason);let settingsOpened=0;const calls:{path:string,body:any}[]=[];
  await page.exposeFunction('settingsOpened',()=>{settingsOpened++;});
  await page.addInitScript(()=>{(window as any).quickenDesktop={openAppleSettings:()=>{void (window as any).settingsOpened();},getDetection:async()=>({enabled:true,apps:[]}),onDetection:()=>()=>{},setDetection(){},onNavigate:()=>()=>{}};});
  await page.routeWebSocket('**/socket',ws=>ws.onMessage(()=>ws.send(JSON.stringify({type:'state',...state}))));
  await page.route('**/api/local/**',async route=>{calls.push({path:new URL(route.request().url()).pathname,body:route.request().postDataJSON()});await route.fulfill({json:{ok:true}});});
  await page.goto('/#access='+token);await page.getByRole('button',{name:'Settings',exact:true}).click();
  const section=page.locator('.local-ai-setup');
  await expect(section.getByRole('button',{name:reason==='available'?'Download speech · 224 MB':'Download Qwen · 2.7 GB',exact:true})).toBeVisible();
  if(reason==='disabled'||reason==='notReady'){await section.getByRole('button',{name:'Open Settings',exact:true}).click();await expect.poll(()=>settingsOpened).toBe(1);}
  else await expect(section.getByRole('button',{name:'Open Settings',exact:true})).toHaveCount(0);
  if(reason!=='available'){await section.getByRole('button',{name:'Check again'}).click();expect(calls.at(-1)?.path).toBe('/api/local/refresh');}
  await section.getByRole('button',{name:reason==='available'?'Download speech · 224 MB':'Download Qwen · 2.7 GB',exact:true}).click();
  await expect.poll(()=>calls.at(-1)?.path).toBe('/api/local/setup');
  if(reason!=='available')expect(calls.some(c=>c.path==='/api/local/model'&&c.body.preference==='qwen')).toBe(true);
  expect((await section.innerText()).split(/\s+/).length).toBeLessThan(65);
  await page.screenshot({path:`verification/model-setup-${reason}.png`});
});
