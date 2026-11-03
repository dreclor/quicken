import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Headphones, ShieldCheck, Cloud, Pause, Play, Square, Upload, VolumeX, X } from 'lucide-react';
import { accessToken, api } from './api';
import { parseAgenda, type AppState, type Meeting } from '../shared/types';

type QuickSetup = { mode: 'local' | 'rehearsal' | 'meeting'; agenda: string; meetingUrl: string };
function savedSetup(): QuickSetup {
  const defaults: QuickSetup = { mode: 'local', agenda: 'Goals (5 min)\nDiscussion (15 min)\nNext steps (5 min)', meetingUrl: '' };
  try {
    const saved = JSON.parse(localStorage.getItem('quicken-quick-start') || '{}');
    return { mode: ['local', 'rehearsal', 'meeting'].includes(saved.mode) ? saved.mode : defaults.mode, agenda: typeof saved.agenda === 'string' ? saved.agenda.slice(0, 30_000) : defaults.agenda, meetingUrl: '' };
  } catch { return defaults; }
}
function openMain(target: QuickenNavigation = {}) {
  if (window.quickenDesktop) window.quickenDesktop.showMain(target);
  else {
    const params = new URLSearchParams();
    if (target.view) params.set('view', target.view);
    if (target.meetingId) params.set('meeting', target.meetingId);
    window.open('/#' + params, 'quicken-main');
  }
}

export function ChickenPopup() {
  const [state, setState] = useState<AppState>();
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [detection, setDetection] = useState<MeetingDetection>();
  const [configuring, setConfiguring] = useState(false);
  const [setup, setSetup] = useState(savedSetup);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const starting = useRef(false);
  const upload = useRef<HTMLInputElement>(null);
  const meeting = state?.meetings.find(m => ['live', 'joining', 'ending'].includes(m.status));
  const expanded = configuring && !meeting;
  useEffect(() => {
    const desktop = window.quickenDesktop;
    if (!desktop) return;
    void desktop.getDetection().then(setDetection);
    return desktop.onDetection(setDetection);
  }, []);
  useEffect(() => { window.quickenDesktop?.setChickenExpanded(expanded); }, [expanded]);
  useEffect(() => {
    document.title = 'Quicken chicken';
    document.documentElement.classList.add('popup-document');
    let socket: WebSocket, retry: ReturnType<typeof setTimeout>, disposed = false;
    function connect() {
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/socket`);
      socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', role: 'viewer', token: accessToken() }));
      socket.onmessage = e => { const data = JSON.parse(e.data); if (data.type === 'state') { setState(data); setConnected(true); } };
      socket.onclose = e => { setConnected(false); if (!disposed && e.code !== 1008) retry = setTimeout(connect, 2000); };
    }
    connect();
    return () => { disposed = true; socket.close(); clearTimeout(retry); document.documentElement.classList.remove('popup-document'); };
  }, []);
  const speaking = meeting?.interventions.some(i => i.state === 'speaking');
  const status = !connected ? 'Connecting…' : !meeting ? detection?.apps.length ? 'Mic active' : 'Ready' : meeting.status === 'ending' ? 'Finishing transcript…' : meeting.paused ? 'Paused' : speaking ? 'Speaking…' : meeting.bridgeConnected || meeting.mode === 'demo' ? 'Listening' : 'Waiting for audio…';
  const latest = meeting?.interventions.filter(i => i.state === 'speaking' || i.state === 'spoken').at(-1);
  const prerequisites = setup.mode !== 'meeting' ? (['ready','installed'].includes(state?.localAI?.status || '') ? '' : state?.localAI?.status === 'missing' ? 'Download local AI first.' : state?.localAI?.detail || 'Set up local AI first.') : !state?.settings.hasOpenaiKey ? 'Add an OpenAI key in Settings.' : !state.settings.hasRecallKey ? 'Add a Recall key in Settings.' : !state.settings.publicBaseUrl ? 'Start a test bridge in Settings.' : '';
  async function importAgenda(file?: File) {
    if (!file) return;
    setImporting(true); setError('');
    try {
      const body = new FormData(); body.append('file', file);
      const data = await api<{ agenda: Meeting['agenda'] }>('/agenda/import', { method: 'POST', body });
      setSetup(previous => ({ ...previous, agenda: data.agenda.map(a => `${a.title} (${a.minutes} min)`).join('\n') }));
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not read that agenda.'); }
    finally { setImporting(false); }
  }
  async function start() {
    if (starting.current || meeting || !connected || prerequisites || importing) return;
    const agenda = parseAgenda(setup.agenda);
    if (!agenda.length) { setError('Add at least one agenda item.'); return; }
    if (setup.mode === 'meeting' && !setup.meetingUrl.trim()) { setError('Add a meeting link.'); return; }
    starting.current = true; setBusy(true); setError('');
    // Open synchronously with the click so browsers allow the audio setup window.
    const audio = setup.mode !== 'meeting' ? window.open('about:blank', 'quicken-rehearsal', 'width=900,height=780') : null;
    try {
      const created = await api<Meeting>('/meetings', { method: 'POST', body: JSON.stringify({ title: agenda[0].title.slice(0,120), agenda, mode: setup.mode, processing:setup.mode==='meeting'?'cloud':'local', meetingUrl: setup.meetingUrl.trim(), intensity: 'balanced' }) });
      const result = await api<{ bridgeUrl?: string }>(`/meetings/${created.id}/start`, { method: 'POST' });
      try { localStorage.setItem('quicken-quick-start', JSON.stringify({ mode: setup.mode, agenda: setup.agenda })); } catch { /* Storage can be disabled; activation still succeeds. */ }
      setConfiguring(false);
      if (result.bridgeUrl) {
        if (audio && !audio.closed) audio.location.href = result.bridgeUrl;
        else setError('Allow popups, then choose Open audio to finish connecting.');
      }
    } catch (e) { audio?.close(); setError(e instanceof Error ? e.message : 'Could not activate Quicken.'); }
    finally { starting.current = false; setBusy(false); }
  }
  async function openAudio() {
    if (!meeting) return;
    const audio = window.open('about:blank', 'quicken-rehearsal', 'width=900,height=780');
    setError('');
    try {
      const result = await api<{ bridgeUrl: string }>(`/meetings/${meeting.id}/bridge`);
      if (audio) audio.location.href = result.bridgeUrl;
      else setError('Allow popups to open the audio setup window.');
    } catch (e) { audio?.close(); setError(e instanceof Error ? e.message : 'Could not open audio.'); }
  }
  async function control(path: string, body?: unknown) {
    if (!meeting) return;
    setError('');
    try { await api(`/meetings/${meeting.id}${path}`, { method: body ? 'PATCH' : 'POST', ...(body ? { body: JSON.stringify(body) } : {}) }); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not update the meeting.'); }
  }
  return <main className={`chicken-popup ${speaking ? 'speaking' : ''} ${expanded ? 'configuring' : ''}`}>
    <div className="chicken-drag" title="Drag Quicken anywhere"><img src="/chicken.png" alt="Quicken the chicken" draggable={false} /></div>
    <section className="chicken-bubble">
      <header><strong>Quicken</strong><button className="icon-button" aria-label="Hide chicken" onClick={() => { if (window.quickenDesktop) window.quickenDesktop.closeChicken(); else window.close(); }}><X size={15}/></button></header>
      <p className="chicken-status" role="status"><span className={`tiny-dot ${meeting && !meeting.paused && connected ? 'active' : ''}`}/>{status}</p>
      {!expanded && (meeting || !!detection?.apps.length) && <p className="chicken-topic">{speaking && latest ? latest.text : meeting ? meeting.agenda[meeting.currentAgendaIndex]?.title : detection?.apps.join(', ')}</p>}
      {expanded && <form className="chicken-setup" onSubmit={event => { event.preventDefault(); void start(); }}>
        <label htmlFor="quick-mode">Listen through</label>
        <select id="quick-mode" value={setup.mode} disabled={busy} onChange={e => setSetup({ ...setup, mode: e.target.value as QuickSetup['mode'] })}>
          <option value="local">On this Mac</option><option value="rehearsal">Rehearsal · mic only</option><option value="meeting">Cloud bot</option>
        </select>
        <p className="chicken-help">{setup.mode === 'local' ? <><Headphones size={13}/>Headphones + BlackHole 2ch</> : setup.mode === 'rehearsal' ? <><ShieldCheck size={13}/>Local AI · headphones</> : <><Cloud size={13}/>OpenAI + Recall</>}</p>
        {setup.mode === 'meeting' && <><label htmlFor="quick-link">Meeting link</label><input id="quick-link" type="url" required maxLength={2000} placeholder="https://meet.google.com/…" value={setup.meetingUrl} disabled={busy} onChange={e => setSetup({ ...setup, meetingUrl: e.target.value })}/></>}
        <div className="chicken-agenda-label"><label htmlFor="quick-agenda">Your agenda</label><button type="button" className="text-button" disabled={busy || importing} onClick={() => upload.current?.click()}><Upload size={12}/>{importing ? 'Reading…' : 'Upload'}</button></div>
        <input ref={upload} type="file" hidden accept=".txt,.md,.csv,.pdf,.docx" aria-label="Upload agenda" onChange={e => { void importAgenda(e.target.files?.[0]); e.target.value = ''; }}/>
        <textarea id="quick-agenda" value={setup.agenda} maxLength={30_000} rows={4} disabled={busy || importing} onChange={e => setSetup({ ...setup, agenda: e.target.value })}/>
        {prerequisites && <div className="chicken-prerequisites"><p>{prerequisites}</p><button type="button" className="text-button" onClick={() => openMain({ view: 'connections' })}>{setup.mode === 'meeting' ? 'Connect services' : 'Set up local AI'}<ArrowUpRight size={13}/></button></div>}
        <div className="chicken-setup-actions"><button className="primary" aria-label="Start Quicken" disabled={busy || importing || !connected || !!prerequisites}><Play size={13}/>{busy ? 'Activating…' : 'Start'}</button><button type="button" className="text-button" disabled={busy} onClick={() => { setConfiguring(false); setError(''); }}>Cancel</button></div>
      </form>}
      {error && <p role="alert" className="error-text">{error}</p>}
      {!expanded && <div className="chicken-controls">
        {!meeting && <button className="primary" aria-label="Activate Quicken" disabled={!connected || busy} onClick={() => { setError(''); setConfiguring(true); }}><Play size={14}/>Activate</button>}
        {meeting && meeting.status !== 'ending' && <><button className="secondary" onClick={() => void control('', { paused: !meeting.paused })}>{meeting.paused ? <Play size={14}/> : <Pause size={14}/>} {meeting.paused ? 'Resume' : 'Pause'}</button><button className="secondary" onClick={() => void control('/stop-speaking')}><VolumeX size={14}/>Quiet</button><button className="secondary" onClick={() => void control('/end')}><Square size={12}/>End</button></>}
        <button className="icon-button" aria-label="Open Quicken" onClick={() => openMain({ meetingId: meeting?.id })}><ArrowUpRight size={17}/></button>
      </div>}
      {meeting && meeting.status !== 'ending' && ['local', 'rehearsal'].includes(meeting.mode) && !meeting.bridgeConnected && <button className="text-button chicken-audio" onClick={() => void openAudio()}>Open audio<ArrowUpRight size={13}/></button>}
    </section>
  </main>;
}
