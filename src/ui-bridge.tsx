import { useEffect, useRef, useState } from 'react';
import { AudioLines, Settings2, ArrowRight, Cloud, Headphones, Mic, MicOff, Monitor, RotateCcw, ShieldCheck, Volume2 } from 'lucide-react';
import { MeetingBridge } from './bridge';
import { LocalAudio } from './local-audio';
import { OfflineBridge } from './offline-bridge';

export function BridgeView() {
  const query = new URLSearchParams(location.hash.slice(1));
  const rehearsal = query.has('rehearsal'), local = query.has('local'), offline = query.has('offline');
  const bridge = useRef<MeetingBridge | OfflineBridge | undefined>(undefined);
  const audio = useRef<LocalAudio | undefined>(undefined);
  const [status, setStatus] = useState(local ? 'Connect audio' : rehearsal ? 'Ready' : 'Connecting…');
  const [started, setStarted] = useState(false), [error, setError] = useState(false), [connecting, setConnecting] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]), [micId, setMicId] = useState(''), [outputId, setOutputId] = useState('');
  const [muted, setMuted] = useState(false), [levels, setLevels] = useState([0, 0]);
  async function scanDevices() {
    setError(false);
    try {
      const permission = await navigator.mediaDevices.getUserMedia({ audio: true });
      permission.getTracks().forEach(t => t.stop());
      const list = await navigator.mediaDevices.enumerateDevices();
      setDevices(list);
      setMicId(list.find(d => d.kind === 'audioinput' && d.deviceId !== 'default' && !/blackhole|aggregate|multi.?output/i.test(d.label))?.deviceId || '');
      setOutputId(list.find(d => d.kind === 'audiooutput' && /blackhole 2ch/i.test(d.label))?.deviceId || '');
      setStatus('Choose devices');
    } catch (e) { setError(true); setStatus(e instanceof Error ? e.message : 'Could not read audio devices.'); }
  }
  async function start() {
    bridge.current?.shutdown(); audio.current?.close(); setError(false); setConnecting(true); setMuted(false);
    try {
      let stream: MediaStream | undefined;
      if (local) {
        const graph = new LocalAudio(() => {
          bridge.current?.shutdown(); setStarted(false); setError(true); setStatus('An audio device disconnected. Reconnect to continue.');
        }, (mic, meeting) => setLevels([mic, meeting]));
        audio.current = graph;
        stream = await graph.start(micId, outputId);
      }
      const routeAudio = local ? (stream: MediaStream) => audio.current?.routeModerator(stream) : undefined;
      const ended = () => { audio.current?.close(); setStarted(false); };
      const b = offline ? new OfflineBridge(query.get('session') || '', query.get('token') || '', setStatus, routeAudio, ended) : new MeetingBridge(query.get('session') || '', query.get('token') || '', rehearsal, setStatus, routeAudio, ended);
      bridge.current = b;
      await b.start(stream); setStarted(true);
    } catch (e) {
      bridge.current?.shutdown(); audio.current?.close(); setStatus(e instanceof Error ? e.message : 'Connection failed'); setError(true); setStarted(false);
    } finally { setConnecting(false); }
  }
  useEffect(() => { if (!rehearsal && !local) void start(); return () => { bridge.current?.shutdown(); audio.current?.close(); }; }, []);
  const displayStatus: Record<string,string> = {
    'Listening · fully local':'Listening', 'Listening · direct live audio':'Listening',
    'Quicken is speaking · fully local':'Speaking…', 'Quicken is speaking':'Speaking…',
    'Meeting ended. Your transcript has been saved.':'Transcript saved',
    'Finishing the local transcript…':'Saving transcript…', 'Finishing the transcript…':'Saving transcript…',
    'Preparing fully local audio…':'Preparing…'
  };
  return <main className={`bridge-screen ${local ? 'local-bridge' : ''}`}>
    <img className={`bridge-chicken ${status.includes('speaking') ? 'talking' : ''}`} src="/chicken.png" alt="Quicken the chicken"/>
    <h1>Quicken<span>.</span></h1>
    <p role="status" className={error ? 'error-text' : ''}>{displayStatus[status] || status}</p>
    <div className="audio-badges"><span>{offline ? <ShieldCheck size={14}/> : <Cloud size={14}/>} {offline ? 'Local AI' : 'Cloud AI'}</span><span><Headphones size={14}/>Headphones</span></div>
    {local ? <section className="local-audio-setup">
      <div className="audio-route" aria-label="Your microphone and Quicken’s voice go through BlackHole into the meeting"><div className="route-inputs"><span><Mic size={20}/>Your mic</span><span><img src="/chicken.png" alt=""/>Quicken</span></div><ArrowRight className="route-arrow" size={19}/><div className="route-node"><AudioLines size={23}/>BlackHole 2ch</div><ArrowRight className="route-arrow" size={19}/><div className="route-node"><Monitor size={23}/>Meeting</div></div>
      <div className="routing-settings"><div><Mic size={16}/><span>Meeting microphone</span><strong>BlackHole 2ch</strong></div><div><Headphones size={16}/><span>Meeting & Mac speakers</span><strong>Headphones</strong></div></div>
      {!devices.length ? <button className="secondary full" onClick={scanDevices}><Settings2 size={16}/>Choose devices</button> : <div className="two-fields">
        <label className="field-label">Your microphone<select disabled={started || connecting} value={micId} onChange={e => setMicId(e.target.value)}>{devices.filter(d => d.kind === 'audioinput' && !/blackhole|aggregate|multi.?output/i.test(d.label)).map(d => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}</select></label>
        <label className="field-label">Meeting output<select disabled={started || connecting} value={outputId} onChange={e => setOutputId(e.target.value)}><option value="">Select BlackHole 2ch</option>{devices.filter(d => d.kind === 'audiooutput' && /blackhole 2ch/i.test(d.label)).map(d => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}</select></label>
      </div>}
      {!outputId && <div className="driver-links"><a href="https://existential.audio/blackhole/" target="_blank" rel="noreferrer">Install BlackHole</a><button className="text-button" onClick={scanDevices}><RotateCcw size={12}/>Refresh devices</button></div>}
      <div className="button-row"><button disabled={!outputId || connecting} onClick={start}><Mic size={17}/>{connecting ? 'Connecting…' : started ? 'Reconnect audio' : 'Start meeting audio'}</button>{started && <button className="secondary" onClick={() => { audio.current?.muteMicrophone(!muted); setMuted(!muted); }}>{muted ? <Mic size={16}/> : <MicOff size={16}/>} {muted ? 'Unmute me' : 'Mute me'}</button>}</div>
      {started && <div className="audio-meters"><label>Your mic<meter value={levels[0]} min={0} max={1}/></label><label>Meeting<meter value={levels[1]} min={0} max={1}/></label></div>}
      <details className="compact-details audio-help"><summary>Audio help</summary><p>Choose your physical microphone in Quicken. Keep speakers on headphones to prevent feedback. Restore your meeting app’s usual microphone after closing Quicken.</p><p>{offline ? 'Audio stays on this Mac.' : 'Audio is sent to OpenAI.'} Screen video is never sent or saved.</p></details>
      <p className="attendee-note">Let attendees know Quicken is transcribing.</p>
    </section> : rehearsal && <>
      {!offline && <p className="muted">Microphone audio is sent to OpenAI.</p>}
      <div className="button-row"><button disabled={connecting} onClick={start}><Mic size={17}/>{connecting ? 'Connecting…' : started ? 'Reconnect audio' : 'Start microphone'}</button><button className="secondary icon-button" title="Enable audio" aria-label="Enable audio" onClick={() => void bridge.current?.enableAudio()}><Volume2 size={18}/></button></div>
    </>}

    {!rehearsal && !local && error && <button onClick={start}><RotateCcw size={17}/>Reconnect</button>}
  </main>;
}
