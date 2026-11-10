import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Pause, Play, Square, Upload, VolumeX, X } from 'lucide-react';
import { accessToken, api } from './api';
import { parseAgenda, type AppState, type Meeting } from '../shared/types';

type QuickSetup = { agenda: string };
function savedSetup(): QuickSetup {
  const defaults: QuickSetup = { agenda: '' };
  try {
    const saved = JSON.parse(localStorage.getItem('quicken-quick-start') || '{}');
    return { agenda: typeof saved.agenda === 'string' ? saved.agenda.slice(0, 30_000) : defaults.agenda };
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
  const prerequisites = ['ready','installed'].includes(state?.localAI?.status || '') ? '' : state?.localAI?.detail || 'Set up local AI first.';
  const lastShown = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (meeting?.mode !== 'local' || !latest || latest.id === lastShown.current) return;
    lastShown.current = latest.id;
    window.quickenDesktop?.showChicken();
  }, [meeting?.mode, latest]);

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
    starting.current = true; setBusy(true); setError('');
    // Open synchronously with the click so browsers allow the audio setup window.
    const audio = window.open('about:blank', 'quicken-rehearsal', 'width=900,height=780');
    try {
      const created = await api<Meeting>('/meetings', { method: 'POST', body: JSON.stringify({ title: agenda[0]?.title.slice(0,120) || 'Meeting', agenda, mode: 'local', processing:'local', intensity: 'balanced' }) });
      const result = await api<{ bridgeUrl?: string }>(`/meetings/${created.id}/start`, { method: 'POST' });
      try { localStorage.setItem('quicken-quick-start', JSON.stringify({ agenda: setup.agenda })); } catch { /* Storage can be disabled; activation still succeeds. */ }
      setConfiguring(false);
      if (result.bridgeUrl) {
        if (audio && !audio.closed) audio.location.href = result.bridgeUrl + '&autostart=1';
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
      if (audio) audio.location.href = meeting.mode === 'local' ? result.bridgeUrl.replace('/bridge#', '/bridge?retry=' + Date.now() + '#') + '&autostart=1' : result.bridgeUrl;
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
      {!expanded && (meeting || !!detection?.apps.length) && <p className="chicken-topic">{latest && (speaking || meeting?.mode === 'local') ? latest.text : meeting ? meeting.agenda[meeting.currentAgendaIndex]?.title : detection?.apps.join(', ')}</p>}
      {expanded && <form className="chicken-setup" onSubmit={event => { event.preventDefault(); void start(); }}>
        <div className="chicken-agenda-label"><label htmlFor="quick-agenda">Your agenda</label><button type="button" className="text-button" disabled={busy || importing} onClick={() => upload.current?.click()}><Upload size={12}/>{importing ? 'Reading…' : 'Upload'}</button></div>
        <input ref={upload} type="file" hidden accept=".txt,.md,.csv,.pdf,.docx" aria-label="Upload agenda" onChange={e => { void importAgenda(e.target.files?.[0]); e.target.value = ''; }}/>
        <textarea id="quick-agenda" value={setup.agenda} maxLength={30_000} rows={4} disabled={busy || importing} onChange={e => setSetup({ ...setup, agenda: e.target.value })}/>
        {prerequisites && <div className="chicken-prerequisites"><p>{prerequisites}</p><button type="button" className="text-button" onClick={() => openMain({ view: 'connections' })}>Set up local AI<ArrowUpRight size={13}/></button></div>}
        <div className="chicken-setup-actions"><button className="primary" aria-label="Start Quicken" disabled={busy || importing || !connected || !!prerequisites}><Play size={13}/>{busy ? 'Activating…' : 'Start'}</button><button type="button" className="text-button" disabled={busy} onClick={() => { setConfiguring(false); setError(''); }}>Cancel</button></div>
      </form>}
      {error && <p role="alert" className="error-text">{error}</p>}
      {!expanded && <div className="chicken-controls">
        {!meeting && <button className="primary" aria-label="Start meeting" disabled={!connected || busy} onClick={() => { if (prerequisites) openMain({ view: 'connections' }); else void start(); }}><Play size={14}/>Start</button>}
        {!meeting && <button className="text-button" onClick={() => { setError(''); setConfiguring(true); }}>Add agenda</button>}
        {meeting && meeting.status !== 'ending' && <><button className="secondary" onClick={() => void control('', { paused: !meeting.paused })}>{meeting.paused ? <Play size={14}/> : <Pause size={14}/>} {meeting.paused ? 'Resume' : 'Pause'}</button><button className="secondary" onClick={() => void control('/stop-speaking')}><VolumeX size={14}/>Dismiss</button><button className="secondary" onClick={() => void control('/end')}><Square size={12}/>End</button></>}
        <button className="icon-button" aria-label="Open Quicken" onClick={() => openMain({ meetingId: meeting?.id })}><ArrowUpRight size={17}/></button>
      </div>}
      {meeting && meeting.status !== 'ending' && ['local', 'rehearsal'].includes(meeting.mode) && !meeting.bridgeConnected && <button className="text-button chicken-audio" onClick={() => void openAudio()}>Open audio<ArrowUpRight size={13}/></button>}
    </section>
  </main>;
}
