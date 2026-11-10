import { useEffect, useRef, useState } from 'react';
import { Cloud, Headphones, Mic, MicOff, RotateCcw, ShieldCheck, Volume2 } from 'lucide-react';
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
  const [muted, setMuted] = useState(false), [levels, setLevels] = useState([0, 0]);
  function reportAudioError(message: string) {
    setStatus(message);
    setError(true);
    if (local) {
      void fetch('/api/bridge/' + encodeURIComponent(query.get('session') || '') + '/audio-error', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'x-bridge-token': query.get('token') || ''},
        body: JSON.stringify({message: message.slice(0, 500)}),
      }).catch(() => {});
    }
  }
  async function start() {
    bridge.current?.shutdown(); audio.current?.close(); setError(false); setConnecting(true); setMuted(false);
    try {
      let stream: MediaStream | undefined;
      if (local) {
        const graph = new LocalAudio(() => {
          bridge.current?.shutdown(); setStarted(false); setError(true); reportAudioError('An audio device disconnected. Reconnect to continue.');
        }, (mic, meeting) => setLevels([mic, meeting]));
        audio.current = graph;
        stream = await graph.start('');
      }
      const ended = () => { audio.current?.close(); setStarted(false); };
      const b = offline ? new OfflineBridge(query.get('session') || '', query.get('token') || '', setStatus, undefined, ended) : new MeetingBridge(query.get('session') || '', query.get('token') || '', rehearsal, setStatus, undefined, ended);
      bridge.current = b;
      await b.start(stream); setStarted(true);
      if (local && query.has('autostart')) window.quickenDesktop?.hideMeetingAudio?.();
    } catch (e) {
      bridge.current?.shutdown(); audio.current?.close(); reportAudioError(e instanceof Error ? e.message : 'Audio connection failed.'); setStarted(false);
    } finally { setConnecting(false); }
  }
  useEffect(() => { if (local && query.has('autostart')) window.quickenDesktop?.startMeetingAudio?.(); else if (!rehearsal && !local) void start(); return () => { bridge.current?.shutdown(); audio.current?.close(); }; }, []);
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
      <p>Quicken shows suggestions in the chicken overlay.</p>
      <div className="button-row"><button data-start-meeting disabled={connecting} onClick={start}><Mic size={17}/>{connecting ? 'Connecting…' : started ? 'Reconnect audio' : 'Start meeting audio'}</button>{started && <button className="secondary" onClick={() => { audio.current?.muteMicrophone(!muted); setMuted(!muted); }}>{muted ? <Mic size={16}/> : <MicOff size={16}/>} {muted ? 'Unmute me' : 'Mute me'}</button>}</div>
      {started && <div className="audio-meters"><label>Your mic<meter value={levels[0]} min={0} max={1}/></label><label>Meeting<meter value={levels[1]} min={0} max={1}/></label></div>}
      <details className="compact-details audio-help"><summary>Audio help</summary><p>Choose your physical microphone in Quicken. Keep speakers on headphones to prevent feedback.  Keep your usual microphone selected in the meeting app.</p><p>{offline ? 'Audio stays on this Mac.' : 'Audio is sent to OpenAI.'} Screen video is never sent or saved.</p></details>
      <p className="attendee-note">Let attendees know Quicken is transcribing.</p>
    </section> : rehearsal && <>
      {!offline && <p className="muted">Microphone audio is sent to OpenAI.</p>}
      <div className="button-row"><button disabled={connecting} onClick={start}><Mic size={17}/>{connecting ? 'Connecting…' : started ? 'Reconnect audio' : 'Start microphone'}</button><button className="secondary icon-button" title="Enable audio" aria-label="Enable audio" onClick={() => void bridge.current?.enableAudio()}><Volume2 size={18}/></button></div>
    </>}

    {!rehearsal && !local && error && <button onClick={start}><RotateCcw size={17}/>Reconnect</button>}
  </main>;
}
