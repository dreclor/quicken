import express from 'express';
import multer from 'multer';
import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join, resolve } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { TestTunnel } from './tunnel.js';
import { Store, type RecordData } from './store.js';
import { MeetingController, timeReminderText } from './controller.js';
import { assessmentSchema, createMeetingSchema, feedbackCounts, feedbackSchema, parseAgenda, reasonSchema, usesLocalAI, type BridgeCommand, type Meeting, type TranscriptEntry } from '../shared/types.js';
import { OfflineEngine, type LocalEngine } from './local/engine.js';
import { LocalModerator, localNotes } from './local/moderator.js';
import { createBot, createRealtimeCall, fallbackNotes, generateNotes, getBot, leaveBot, providerFetch, publicUrl } from './providers.js';

function same(a: unknown, b: string) { return typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
const msg = (e: unknown) => e instanceof Error ? e.message : 'Unexpected error';
export function createApplication(options: { dataDir: string; staticDir?: string; localEngine?: LocalEngine }) {
  const store = new Store(options.dataDir), app = express(), server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/socket', maxPayload: 256 * 1024 });
  // The HTTP startup caller handles listen errors (for example, a second copy
  // using port 4317). ws forwards those errors too; do not crash before that UI.
  wss.on('error', () => {});
  const tunnel = new TestTunnel();
  const viewers = new Set<WebSocket>(), bridges = new Map<string, WebSocket>(), controllers = new Map<string, MeetingController>();
  const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const callsInFlight = new Set<string>(), polling = new Set<string>();
  const endings = new Map<string, Promise<void>>(), drains = new Map<string, () => void>();
  let broadcastTimer: ReturnType<typeof setTimeout> | undefined;
  const send = (ws: WebSocket, value: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); };
  const broadcast = () => {
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(() => { broadcastTimer = undefined; for (const ws of viewers) send(ws, { type: 'state', ...store.state(), localAI: localEngine.status }); }, 100);
  };
  const localEngine = options.localEngine || new OfflineEngine(broadcast);
  let localSession: { id: string; socket: WebSocket; moderator: LocalModerator; queued: number; accepting: boolean } | undefined;
  const changed = (id: string) => {
    const r = store.records.get(id); if (!r) return;
    if (!saveTimers.has(id)) saveTimers.set(id, setTimeout(() => { saveTimers.delete(id); store.save(r); }, 200));
    broadcast();
  };
  const emit = (id: string, cmd: BridgeCommand) => { const ws = bridges.get(id); if (ws) send(ws, cmd); };
  const controller = (r: RecordData) => {
    let c = controllers.get(r.meeting.id);
    if (!c) { c = new MeetingController(r.meeting, cmd => emit(r.meeting.id, cmd), () => changed(r.meeting.id)); controllers.set(r.meeting.id, c); }
    return c;
  };
  const record = (id: string) => { const r = store.records.get(id); if (!r) throw new Error('Meeting not found.'); return r; };
  const bridgeAuthorized = (id: string, token: unknown) => { const r = store.records.get(id); return r && !['ending','ended'].includes(r.meeting.status) && same(token, r.bridgeToken) ? r : undefined; };
  const addTranscript = (r: RecordData, entry: { id: string; text: string; speaker: string; source: TranscriptEntry['source']; at?: number }) => {
    if (!entry.text.trim() || r.meeting.transcript.some(t => t.id === entry.id)) return;
    r.meeting.transcript.push({ ...entry, at: entry.at || Date.now(), text: entry.text.slice(0, 20_000), speaker: entry.speaker.slice(0, 120) }); changed(r.meeting.id);
  };
  const finishNotes = async (r: RecordData) => {
    if (r.meeting.notesStatus === 'generating') return;
    r.meeting.notesStatus = 'generating'; changed(r.meeting.id);
    try { r.meeting.notes = usesLocalAI(r.meeting) ? await localNotes(localEngine, r.meeting) : await generateNotes(store.settings, r.meeting); r.meeting.notesStatus = 'ready'; }
    catch(e) { r.meeting.notes = fallbackNotes(r.meeting); r.meeting.notesStatus = 'error'; r.meeting.error = `AI notes unavailable: ${msg(e)}. Captured notes and transcript are preserved.`; }
    changed(r.meeting.id);
  };
  const end = (r: RecordData, requestLeave = true): Promise<void> => {
    const id = r.meeting.id, existing = endings.get(id);
    if (existing) return existing;
    const task = (async () => {
      if (r.meeting.status !== 'ended') {
        r.meeting.status = 'ending'; r.meeting.endedAt ||= Date.now();
        if (localSession?.id === id) localSession.moderator.close();
        controller(r).cancel('interrupted'); store.save(r); broadcast();
        if (bridges.get(id)?.readyState === WebSocket.OPEN) {
          // Speech is stopped immediately, but already captured words may still
          // be transcribing. Only final transcript events are accepted below.
          const drained = new Promise<void>(resolve => {
            const timer = setTimeout(() => { drains.delete(id); if (usesLocalAI(r.meeting)) r.meeting.error = 'Local transcription took too long to finish. Some final words may be missing.'; resolve(); }, usesLocalAI(r.meeting) ? 15_000 : 4500);
            drains.set(id, () => { clearTimeout(timer); drains.delete(id); resolve(); });
          });
          emit(id, { type: 'end', drainMs: usesLocalAI(r.meeting) ? 0 : 3500 });
          await drained;
        }
        r.meeting.status = 'ended'; r.meeting.bridgeConnected = false;
        if (localSession?.id === id) { localEngine.stopSpeech(); localSession = undefined; }
        r.bridgeToken = randomBytes(32).toString('hex'); store.save(r); broadcast();
        bridges.get(id)?.close(1000, 'Meeting ended');
      }
      if (requestLeave && r.botId && r.meeting.botStatus !== 'leaving') {
        try { await leaveBot(store.settings, r.botId); r.meeting.botStatus = 'leaving'; if(r.meeting.error?.startsWith('Could not confirm the bot left:'))r.meeting.error=undefined; changed(id); }
        catch(e) { r.meeting.error = `Could not confirm the bot left: ${msg(e)}. Remove Quicken from the meeting or retry Leave bot.`; changed(id); }
      }
      if (r.meeting.notesStatus === 'none') void finishNotes(r);
    })();
    endings.set(id, task);
    void task.then(() => endings.delete(id), () => endings.delete(id));
    return task;
  };
  app.disable('x-powered-by');
  app.use((req,res,next) => { res.setHeader('Referrer-Policy','no-referrer'); res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Cache-Control','no-store'); next(); });
  app.use(express.json({ limit: '1mb' }));
  app.get('/health', (_req,res) => res.json({ ok: true, app: 'Quicken' }));
  app.post('/api/bridge/:id/session', express.text({ type: 'application/sdp', limit: '64kb' }), async (req,res) => {
    const r = bridgeAuthorized(req.params.id, req.headers['x-bridge-token']);
    if (!r) return res.status(401).json({ error:'Meeting bridge authorization expired.' });
    if (usesLocalAI(r.meeting)) return res.status(400).json({error:'This is a fully local session. Cloud audio is disabled.'});
    if (callsInFlight.has(r.meeting.id)) return res.status(409).json({ error:'Connection already in progress.' });
    if (typeof req.body !== 'string' || !req.body.startsWith('v=0')) return res.status(400).json({ error:'Invalid WebRTC offer.' });
    callsInFlight.add(r.meeting.id);
    try { const sdp = await createRealtimeCall(store.settings, r.meeting, req.body); res.type('application/sdp').send(sdp); }
    catch(e) { r.meeting.error = msg(e); changed(r.meeting.id); res.status(502).json({ error:msg(e) }); }
    finally { callsInFlight.delete(r.meeting.id); }
  });
  app.use('/api', (req,res,next) => same(req.headers['x-quicken-token'], store.accessToken) ? next() : res.status(401).json({ error:'Open Quicken from the desktop app or use npm run open to sign in locally.' }));
  app.get('/api/state', (_req,res) => res.json({...store.state(), localAI: localEngine.status}));
  app.post('/api/local/setup', (_req,res) => {
    if (localSession) return res.status(409).json({error:'End the local session before changing models.'});
    if (localEngine.status.status === 'unavailable') return res.status(400).json({error:localEngine.status.detail});
    void localEngine.setup().catch(() => {}); res.status(202).json({ok:true});
  });
  app.post('/api/local/warm', async (_req,res) => {
    try { await localEngine.prepare(); res.json(localEngine.status); } catch(error) { res.status(400).json({error:msg(error)}); }
  });
  app.patch('/api/settings', (req,res) => {
    const data = z.object({ openaiApiKey:z.string().max(500).optional(), recallApiKey:z.string().max(500).optional(), recallRegion:z.enum(['us-west-2','us-east-1','eu-central-1','ap-northeast-1']).optional(), publicBaseUrl:z.string().max(1000).optional(), realtimeModel:z.string().min(1).max(120).optional(), notesModel:z.string().min(1).max(120).optional() }).parse(req.body);
    if (data.publicBaseUrl) data.publicBaseUrl = publicUrl(data.publicBaseUrl);
    if (!data.openaiApiKey) delete data.openaiApiKey; if (!data.recallApiKey) delete data.recallApiKey;
    Object.assign(store.settings,data); store.saveSettings(); broadcast(); res.json(store.publicSettings());
  });
  app.post('/api/tunnel/start',async(_req,res)=>{
    try {
      const address=server.address();if(!address||typeof address==='string')throw new Error('The local server is not listening.');
      const url=await tunnel.start(address.port);store.settings.publicBaseUrl=url;store.saveSettings();broadcast();res.json({url,temporary:true});
    } catch(e) {res.status(502).json({error:msg(e)});}
  });
  app.post('/api/settings/check', async (_req,res) => {
    const results: { provider:string; ok:boolean; detail:string }[] = [];
    for (const provider of ['openai','recall']) {
      const key = provider === 'openai' ? store.settings.openaiApiKey : store.settings.recallApiKey;
      if (!key) { results.push({ provider,ok:false,detail:'API key missing' }); continue; }
      try { await providerFetch(provider === 'openai' ? 'https://api.openai.com/v1/responses' : `https://${store.settings.recallRegion}.recall.ai/api/v1/bot/?limit=1`, provider === 'openai' ? {method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:store.settings.notesModel,input:'Reply OK.',max_output_tokens:32,store:false})} : {headers:{Authorization:key}}, 15_000); results.push({provider,ok:true,detail:provider==='openai'?'Notes API connected; voice access is tested during rehearsal.':'Connected'}); }
      catch(e) { results.push({provider,ok:false,detail:msg(e)}); }
    }
    res.json(results);
  });
  const upload = multer({ storage:multer.memoryStorage(), limits:{fileSize:10*1024*1024,files:1} });
  app.post('/api/agenda/import', upload.single('file'), async (req,res) => {
    if (!req.file) return res.status(400).json({error:'Choose an agenda file.'});
    let text = '';
    const filename = req.file.originalname.toLowerCase();
    if (/\.(txt|md|csv)$/.test(filename)) text = req.file.buffer.toString('utf8');
    else if (filename.endsWith('.docx')) { const mammoth = await import('mammoth'); text = (await mammoth.extractRawText({buffer:req.file.buffer})).value; }
    else if (filename.endsWith('.pdf')) { const { PDFParse } = await import('pdf-parse'); const parser = new PDFParse({data:req.file.buffer}); try { text = (await parser.getText()).text; } finally { await parser.destroy(); } }
    else return res.status(400).json({error:'Choose a TXT, Markdown, PDF, or DOCX agenda.'});
    const agenda = parseAgenda(text); if (!agenda.length) return res.status(400).json({error:'No readable text found. Paste the agenda instead.'});
    res.json({agenda,text:text.slice(0,30_000)});
  });
  app.post('/api/meetings', (req,res) => {
    const input = createMeetingSchema.parse(req.body);
    if (input.mode === 'meeting') input.processing = 'cloud';
    const meeting: Meeting = { ...input, id:randomUUID(),createdAt:Date.now(),status:'draft',paused:false,bridgeConnected:false,currentAgendaIndex:0,topic:'',openQuestions:[],decisions:[],actionItems:[],transcript:[],interventions:[],notes:'',notesStatus:'none',metrics:{responseMs:[],assessments:0,rejected:0} };
    store.save({meeting,bridgeToken:randomBytes(32).toString('hex')}); broadcast(); res.status(201).json(meeting);
  });
  app.post('/api/meetings/:id/start', async (req,res) => {
    const r = record(req.params.id);
    if (!['draft','error'].includes(r.meeting.status)) return res.status(409).json({error:'This session has already started.'});
    if (usesLocalAI(r.meeting) && [...store.records.values()].some(other => other.meeting.id !== r.meeting.id && usesLocalAI(other.meeting) && ['joining','live','ending'].includes(other.meeting.status))) return res.status(409).json({error:'End the current local session before starting another.'});
    r.meeting.status = 'joining'; r.meeting.error = undefined; changed(r.meeting.id);
    try {
      if (usesLocalAI(r.meeting)) await localEngine.prepare();
      if (r.meeting.mode === 'meeting') { const bot = await createBot(store.settings,r.meeting,r.bridgeToken); if (!bot.id) throw new Error('Recall did not return a bot ID. Check your Recall dashboard before retrying.'); r.botId=bot.id; r.meeting.botStatus='joining'; }
      else if (r.meeting.mode === 'demo') { r.meeting.status='live'; r.meeting.startedAt=Date.now(); r.meeting.agendaStartedAt=Date.now(); }
      store.save(r); broadcast(); res.json({meeting:r.meeting, ...(['rehearsal','local'].includes(r.meeting.mode) ? {bridgeUrl:`/bridge#session=${r.meeting.id}&token=${r.bridgeToken}&rehearsal=1${r.meeting.mode==='local'?'&local=1':''}${usesLocalAI(r.meeting)?'&offline=1':''}`} : {})});
    } catch(e) { r.meeting.status='error'; r.meeting.error=msg(e); changed(r.meeting.id); res.status(502).json({error:msg(e)}); }
  });
  app.get('/api/meetings/:id/bridge', (req,res) => { const r=record(req.params.id); if(!['rehearsal','local'].includes(r.meeting.mode)||['ending','ended'].includes(r.meeting.status))return res.status(400).json({error:'No local audio session is available.'}); res.json({bridgeUrl:`/bridge#session=${r.meeting.id}&token=${r.bridgeToken}&rehearsal=1${r.meeting.mode==='local'?'&local=1':''}${usesLocalAI(r.meeting)?'&offline=1':''}`}); });
  app.patch('/api/meetings/:id', (req,res) => {
    const r=record(req.params.id); const c=controller(r);
    if(['ending','ended'].includes(r.meeting.status))return res.status(409).json({error:'This meeting has ended.'});
    const changes=z.object({paused:z.boolean().optional(),intensity:z.enum(['gentle','balanced','active']).optional(),enabledReasons:z.array(reasonSchema).optional(),currentAgendaIndex:z.number().int().min(0).optional(),extendMinutes:z.number().int().min(1).max(30).optional()}).parse(req.body);
    if(changes.paused!==undefined){r.meeting.paused=changes.paused;if(changes.paused)c.cancel('interrupted');}
    if(changes.intensity)r.meeting.intensity=changes.intensity;
    if(changes.enabledReasons)r.meeting.enabledReasons=changes.enabledReasons;
    if(changes.currentAgendaIndex!==undefined)c.advance(changes.currentAgendaIndex);
    if(changes.extendMinutes)r.meeting.agenda[r.meeting.currentAgendaIndex].minutes+=changes.extendMinutes;
    emit(r.meeting.id,{type:'state',meeting:r.meeting});changed(r.meeting.id);res.json(r.meeting);
  });
  // Ratings stay available after a meeting ends so a host can review and rate
  // the interjection log once the conversation is over.
  app.post('/api/meetings/:id/interventions/:intervention/feedback',(req,res)=>{
    const r=record(req.params.id);
    const item=r.meeting.interventions.find(x=>x.id===req.params.intervention);
    if(!item)return res.status(404).json({error:'That interjection is no longer available.'});
    const {feedback}=z.object({feedback:feedbackSchema.nullable()}).parse(req.body);
    if(feedback)item.feedback=feedback;else delete item.feedback;
    changed(r.meeting.id);res.json({feedback:item.feedback??null,...feedbackCounts(r.meeting)});
  });
  app.post('/api/meetings/:id/stop-speaking',(req,res)=>{controller(record(req.params.id)).cancel('interrupted');res.json({ok:true});});
  app.post('/api/meetings/:id/end',async(req,res)=>{const r=record(req.params.id);await end(r);res.json(r.meeting);});
  app.post('/api/meetings/:id/notes',async(req,res)=>{const r=record(req.params.id);if(r.meeting.status!=='ended')return res.status(400).json({error:'End the meeting before generating final notes.'});void finishNotes(r);res.json({ok:true});});
  app.get('/api/meetings/:id/export',(req,res)=>{const r=record(req.params.id);const rated=feedbackCounts(r.meeting);res.type('text/markdown').attachment('quicken-meeting.md').send((r.meeting.notes||fallbackNotes(r.meeting))+`\n\n---\n\n# Interjection ratings\n\n- Helpful: ${rated.up}\n- Not helpful: ${rated.down}\n- Unrated: ${r.meeting.interventions.filter(x=>x.spokenAt&&!x.feedback).length}\n`+'\n---\n\n# Full transcript\n\n'+r.meeting.transcript.map(x=>`**${x.speaker}:** ${x.text}`).join('\n\n'));});
  app.post('/api/meetings/:id/demo-step',(req,res)=>{
    const r=record(req.params.id);if(r.meeting.mode!=='demo'||r.meeting.status!=='live')return res.status(400).json({error:'Start a demo session first.'});
    const step=z.number().int().min(0).max(5).parse(req.body.step), c=controller(r);
    const script=[['Maya','Let’s agree on the launch scope first. We need the onboarding flow and the new dashboard.'],['Alex','The dashboard is ready. I’ll own onboarding and have it ready by Friday.'],['Maya','What about the customer migration? Who’s responsible for that?'],['Alex','We’ll figure that out soon. By the way, did everyone see the new office designs?'],['Maya','Yes, but let’s settle migration before we move on.'],['Alex','I’ll take migration too, and share the plan on Thursday.']];
    c.speech(true);addTranscript(r,{id:`demo-${step}`,speaker:script[step][0],text:script[step][1],source:'demo'});c.speech(false);
    if(step===1)r.meeting.actionItems=['Alex: onboarding ready by Friday.'];
    if(step===2)r.meeting.openQuestions=['Who owns customer migration?'];
    if(step===3)c.assess({intervene:true,reason:'ambiguous',text:'Before we move on, could we name an owner and a date for the migration plan?',evidence:'Customer migration was raised, but “we’ll figure that out soon” left its owner and date unclear.',confidence:.98,topic:'Launch ownership',openQuestions:['Who owns customer migration?'],decisions:[],actionItems:[]},c.revision);
    if(step===5){r.meeting.openQuestions=[];r.meeting.actionItems.push('Alex: share the migration plan Thursday.');r.meeting.decisions=['Launch scope includes onboarding and the new dashboard.'];}
    changed(r.meeting.id);res.json(r.meeting);
  });
  // Demo playback has no real audio/model call and is explicitly labeled throughout the UI.
  app.post('/api/meetings/:id/demo-playback',(req,res)=>{const r=record(req.params.id);if(r.meeting.mode!=='demo')return res.sendStatus(400);const c=controller(r);const id=c.activeId;if(id){c.playback(id,'started');addTranscript(r,{id:'moderator-'+id,text:r.meeting.interventions.find(x=>x.id===id)!.text,speaker:'Quicken',source:'demo'});c.playback(id,'finished');}res.json({ok:true});});
  if(options.staticDir){app.use(express.static(resolve(options.staticDir),{index:false}));app.get(['/', '/bridge', '/popup'],(_req,res)=>res.sendFile(join(resolve(options.staticDir!),'index.html')));}
  app.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{res.status(error instanceof z.ZodError?400:500).json({error:error instanceof z.ZodError?error.issues.map(x=>`${x.path.join('.')}: ${x.message}`).join('; '):msg(error)});});
  wss.on('connection',ws=>{
    let role:'viewer'|'bridge'|undefined, sessionId:string|undefined;
    const authTimeout=setTimeout(()=>{if(!role)ws.close(1008,'Authentication required');},5000);
    ws.on('message',async raw=>{
      try{
        const data=JSON.parse(raw.toString());
        if(!role){
          if(data.type!=='auth')return ws.close(1008,'Authenticate first');
          if(data.role==='viewer'&&same(data.token,store.accessToken)){role='viewer';viewers.add(ws);send(ws,{type:'state',...store.state(),localAI:localEngine.status});}
          else if(data.role==='bridge'){
            const r=bridgeAuthorized(data.sessionId,data.token);if(!r)return ws.close(1008,'Invalid bridge token');
            if(bridges.has(r.meeting.id))bridges.get(r.meeting.id)!.close(1000,'Replaced by a new bridge');
            role='bridge';sessionId=r.meeting.id;bridges.set(sessionId,ws);send(ws,{type:'state',meeting:r.meeting});
          }else return ws.close(1008,'Unauthorized');
          clearTimeout(authTimeout);return;
        }
        if(role!=='bridge'||!sessionId||bridges.get(sessionId)!==ws)return;
        const r=record(sessionId),c=controller(r);if(r.meeting.status==='ended')return;
        if (data.type === 'local-start') {
          if (!usesLocalAI(r.meeting) || !['joining','live'].includes(r.meeting.status)) throw new Error('Not a local session.');
          if (localSession && localSession.id !== sessionId) throw new Error('Another local session is active.');
          localSession?.moderator.close(); localEngine.stopSpeech();
          const moderator = new LocalModerator(r.meeting, c, localEngine, message => { r.meeting.error = message; changed(r.meeting.id); });
          const current = {id:sessionId, socket:ws, moderator, queued:0, accepting:true}; localSession = current;
          try {
            await localEngine.startSpeech(event => {
              if (localSession !== current || r.meeting.status === 'ended') return;
              if (event.event === 'final') {
                addTranscript(r, {id:randomUUID(), text:event.text, speaker:r.meeting.mode === 'local'?'Participant':'You', source:'local'});
                if (r.meeting.status === 'live') moderator.transcript();
                send(ws, {type:'local-partial',text:''});
              } else send(ws, {type:'local-partial',text:event.text});
            });
            if (localSession !== current || ws.readyState !== WebSocket.OPEN || !['joining','live'].includes(r.meeting.status)) { moderator.close(); return; }
            r.meeting.bridgeConnected=true; r.meeting.status='live'; r.meeting.startedAt||=Date.now(); r.meeting.agendaStartedAt||=Date.now(); r.meeting.error=undefined; changed(sessionId);
            send(ws,{type:'local-ready'});
            const topic=r.meeting.agenda[r.meeting.currentAgendaIndex]?.title;
            if(topic) for(const remaining of [60_000,0]) void localEngine.voice(timeReminderText(topic,remaining)).catch(()=>{});
          } catch(error) { moderator.close(); if(localSession===current){localSession=undefined;localEngine.stopSpeech();} send(ws,{type:'error',message:msg(error)}); }
          return;
        }
        if (data.type === 'local-audio') {
          const current = localSession;
          if (!current || current.socket !== ws || !current.accepting || !usesLocalAI(r.meeting)) return;
          if (typeof data.pcm !== 'string' || data.pcm.length > 22_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data.pcm)) throw new Error('Invalid PCM.');
          if (++current.queued > 16) { current.accepting=false; current.moderator.close(); r.meeting.error='Local transcription fell behind. Audio stopped; close other heavy apps and reconnect.'; changed(sessionId); send(ws,{type:'error',message:r.meeting.error}); ws.close(1013,'Audio overloaded'); return; }
          try { await localEngine.audio(data.pcm); }
          catch(error) { current.accepting=false; send(ws,{type:'error',message:msg(error)}); ws.close(1011,'Speech engine stopped'); }
          finally { current.queued--; }
          return;
        }
        if (data.type === 'local-drain' && localSession?.socket === ws) {
          localSession.accepting=false;
          try { await localEngine.flush(); }
          catch(error) { r.meeting.error='Some final words could not be transcribed: '+msg(error); changed(sessionId); }
          send(ws,{type:'local-drained'}); drains.get(sessionId)?.(); return;
        }
        if (data.type === 'local-voice' && usesLocalAI(r.meeting)) {
          const item=r.meeting.interventions.find(item=>item.id===data.id);
          if (!item || c.activeId!==item.id || c.humanSpeaking || r.meeting.paused || r.meeting.status!=='live') return;
          try {
            const current=()=>c.activeId===item.id && !c.humanSpeaking && !r.meeting.paused && r.meeting.status==='live';
            if(localEngine.streamVoice){
              await localEngine.streamVoice(item.text,chunk=>{if(current())send(ws,{type:'local-voice-chunk',id:item.id,pcm:chunk.pcm.toString('base64'),rate:chunk.rate});});
              if(current())send(ws,{type:'local-voice-done',id:item.id});
            }else{
              const wav=await localEngine.voice(item.text);
              if(current())send(ws,{type:'local-voice',id:item.id,wav:wav.toString('base64')});
            }
          } catch(error) { c.cancel('dismissed');r.meeting.error='Local voice unavailable: '+msg(error);changed(sessionId);send(ws,{type:'voice-error',message:r.meeting.error}); }
          return;
        }
        if(r.meeting.status==='ending'){
          if(data.type==='drained'){drains.get(sessionId)?.();return;}
          if(data.type!=='transcript')return;
        }
        if(data.type==='ready'&&!usesLocalAI(r.meeting)){r.meeting.bridgeConnected=true;r.meeting.status='live';r.meeting.startedAt||=Date.now();r.meeting.agendaStartedAt||=Date.now();r.meeting.error=undefined;changed(sessionId);}
        else if(data.type==='speech'){const started=z.boolean().parse(data.started);c.speech(started);if(localSession?.socket===ws)localSession.moderator.speech(started);send(ws,{type:'revision',revision:c.revision});}
        else if(data.type==='assessment'&&!usesLocalAI(r.meeting)){c.assess(assessmentSchema.parse(data.assessment),z.number().int().parse(data.revision));send(ws,{type:'state',meeting:r.meeting});}
        else if(data.type==='transcript'){const t=z.object({id:z.string().max(150),text:z.string().max(20_000),speaker:z.string().max(120),source:z.enum(['recall','realtime','moderator']),at:z.number().optional()}).parse(data.entry);addTranscript(r,t);}
        else if(data.type==='playback')c.playback(z.string().parse(data.id),z.enum(['started','finished']).parse(data.phase));
        else if(data.type==='error'){r.meeting.error=z.string().max(500).parse(data.message);changed(sessionId);}
      }catch{send(ws,{type:'error',message:'Invalid event received.'});}
    });
    ws.on('close',()=>{clearTimeout(authTimeout);viewers.delete(ws);if(sessionId&&bridges.get(sessionId)===ws){bridges.delete(sessionId);const r=record(sessionId);r.meeting.bridgeConnected=false;controller(r).cancel('interrupted');changed(sessionId);
      if(localSession?.socket===ws){const current=localSession;current.accepting=false;current.moderator.close();void localEngine.flush().catch(()=>{}).finally(()=>{if(localSession===current){localSession=undefined;localEngine.stopSpeech();}drains.get(r.meeting.id)?.();});}else drains.get(sessionId)?.();
    }});
    ws.on('error',()=>{});
  });
  const timer=setInterval(()=>{for(const c of controllers.values())c.tick();},100);timer.unref();
  const poll=setInterval(()=>{for(const r of store.records.values()){
    if(!r.botId||['ending','ended'].includes(r.meeting.status)||polling.has(r.meeting.id))continue;
    polling.add(r.meeting.id);void getBot(store.settings,r.botId).then(bot=>{
      if(['ending','ended'].includes(r.meeting.status))return;
      const status=bot.status_changes?.at(-1)?.code;if(status){r.meeting.botStatus=status;changed(r.meeting.id);if(status==='done')void end(r,false);if(status==='fatal'){r.meeting.status='error';r.meeting.error='The meeting bot could not connect. Check admission settings and Recall bot diagnostics.';}}
    }).catch(()=>{}).finally(()=>polling.delete(r.meeting.id));
  }},5000);poll.unref();
  return {app,server,store,controllers, warmLocal(){return localEngine.status.status==='installed'?localEngine.prepare():Promise.resolve();}, async endActive(){await Promise.allSettled([...store.records.values()].filter(r=>['live','joining','ending'].includes(r.meeting.status)).map(r=>end(r)));for(const r of store.records.values()){if(r.meeting.notesStatus==='generating'){r.meeting.notes=fallbackNotes(r.meeting);r.meeting.notesStatus='error';r.meeting.error='Quicken closed before AI notes finished. Your transcript is saved; retry AI notes when you reopen.';store.save(r);}}}, async close(){localSession?.moderator.close();localSession=undefined;localEngine.close();tunnel.stop();clearInterval(timer);clearInterval(poll);for(const done of drains.values())done();await Promise.allSettled(endings.values());if(broadcastTimer)clearTimeout(broadcastTimer);for(const t of saveTimers.values())clearTimeout(t);for(const r of store.records.values())store.save(r);for(const ws of wss.clients)ws.close();wss.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
