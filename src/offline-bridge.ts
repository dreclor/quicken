import type { Intervention, Meeting } from '../shared/types';

export class OfflineBridge {
  private socket?: WebSocket;
  private context?: AudioContext;
  private capture?: AudioWorkletNode;
  private microphone?: MediaStream;
  private output?: MediaStreamAudioDestinationNode;
  private playback?: AudioBufferSourceNode;
  private chunks = new Set<AudioBufferSourceNode>();
  private nextAudioAt = 0;
  private streamComplete = false;
  private proposed?: Intervention;
  private audible = false;
  private humanSpeaking = false;
  private silence = 0;
  private closed = false;
  private ending = false;
  private meeting?: Meeting;
  private resolveState?: () => void;
  private resolveReady?: () => void;
  private rejectReady?: (error: Error) => void;
  private resolveFlushed?: () => void;
  constructor(private sessionId: string, private token: string, private status: (text: string) => void, private onRemoteAudio?: (stream: MediaStream) => void, private onEnd?: () => void) {}
  private send(data: unknown) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(data)); }
  async start(stream?: MediaStream) {
    this.status('Preparing fully local audio…'); this.closed = false;
    // Resume during the user's click. All later playback uses this same context.
    this.context = new AudioContext({ sampleRate: 16_000, latencyHint: 'interactive' }); await this.context.resume();
    this.output = this.context.createMediaStreamDestination(); this.onRemoteAudio?.(this.output.stream);
    this.socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/socket`);
    const state = new Promise<void>(resolve => { this.resolveState = resolve; });
    this.socket.onopen = () => this.send({ type: 'auth', role: 'bridge', sessionId: this.sessionId, token: this.token });
    this.socket.onmessage = event => void this.command(JSON.parse(event.data));
    this.socket.onclose = () => { if (!this.closed) { this.status(this.ending ? 'Meeting ended. Your transcript has been saved.' : 'Local connection closed. Reconnect audio to continue.'); this.shutdown(); } };
    await this.withTimeout(state, 10_000, 'The local controller did not respond.');
    if (this.meeting?.processing !== 'local' || this.closed) throw new Error('This is not an active local session.');
    const ready = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.send({ type: 'local-start' }); await this.withTimeout(ready, 120_000, 'The local engine could not start.');
    if (this.closed || this.ending) throw new Error('The session ended while connecting.');
    this.microphone = stream || await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (this.closed || this.ending) { this.microphone.getTracks().forEach(t => t.stop()); throw new Error('The session ended while connecting.'); }
    await this.context.audioWorklet.addModule('/pcm-worklet.js');
    this.capture = new AudioWorkletNode(this.context, 'quicken-pcm');
    const mute = this.context.createGain(); mute.gain.value = 0;
    this.context.createMediaStreamSource(this.microphone).connect(this.capture).connect(mute).connect(this.context.destination);
    this.capture.port.onmessage = event => {
      if (event.data.flushed) { this.resolveFlushed?.(); return; }
      if (this.closed) return;
      const { pcm, level, duration } = event.data;
      if (!this.ending) {
        if (level >= 0.012) {
          this.silence = 0;
          if (!this.humanSpeaking) { this.humanSpeaking = true; this.stopSpeaking(); this.send({ type: 'speech', started: true }); }
        } else if (this.humanSpeaking && (this.silence += duration) >= 0.48) {
          this.humanSpeaking = false; this.send({ type: 'speech', started: false });
        }
      }
      if (this.socket && this.socket.bufferedAmount > 128_000) { this.status('Audio is falling behind. Reconnect to continue.'); this.shutdown(); return; }
      const bytes = new Uint8Array(pcm); let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
      this.send({ type: 'local-audio', pcm: btoa(binary) });
    };
    this.microphone.getTracks().forEach(track => track.addEventListener('ended', () => { if (!this.closed && !this.ending) { this.status('Microphone disconnected. Reconnect audio.'); this.shutdown(); } }));
    this.status('Listening · fully local');
  }
  private async withTimeout<T>(promise: Promise<T>, ms: number, message: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
    finally { clearTimeout(timer); }
  }
  private async command(command: any) {
    if (command.type === 'state') { this.meeting = command.meeting; this.resolveState?.(); this.resolveState = undefined; if (this.meeting?.paused) this.stopSpeaking(); }
    else if (command.type === 'local-ready') { this.resolveReady?.(); this.resolveReady = undefined; }
    else if (command.type === 'stop') this.stopSpeaking();
    else if (command.type === 'speak' && !this.humanSpeaking && !this.ending && !this.closed && !this.meeting?.paused) { this.proposed = command.intervention; this.streamComplete = false; this.nextAudioAt = 0; this.send({ type: 'local-voice', id: this.proposed!.id }); }
    else if (command.type === 'local-voice') await this.play(command.id, command.wav);
    else if (command.type === 'local-voice-chunk') this.playChunk(command.id, command.pcm, command.rate);
    else if (command.type === 'local-voice-done' && command.id === this.proposed?.id) { this.streamComplete = true; this.finishPlayback(); }
    else if (command.type === 'end') await this.finish();
    else if (command.type === 'local-drained') { this.status('Meeting ended. Your transcript has been saved.'); this.shutdown(); }
    else if (command.type === 'error') { this.rejectReady?.(new Error(command.message)); this.status(command.message); this.shutdown(); }
    else if (command.type === 'voice-error') { this.stopSpeaking(); this.status(command.message); }
  }
  private playChunk(id: string, pcm: string, rate: number) {
    if (!this.proposed || this.proposed.id !== id || !this.context || this.humanSpeaking || this.meeting?.paused || this.closed || this.ending) return;
    const bytes=Uint8Array.from(atob(pcm),c=>c.charCodeAt(0));if(!bytes.length||bytes.length%2||rate<8000||rate>48000)return;
    const samples=new DataView(bytes.buffer);const buffer=this.context.createBuffer(1,bytes.length/2,rate), channel=buffer.getChannelData(0);
    for(let i=0;i<channel.length;i++)channel[i]=samples.getInt16(i*2,true)/32768;
    const source=this.context.createBufferSource();source.buffer=buffer;source.connect(this.context.destination);source.connect(this.output!);
    this.chunks.add(source);source.onended=()=>{this.chunks.delete(source);source.disconnect();this.finishPlayback();};
    const start=Math.max(this.context.currentTime+0.025,this.nextAudioAt);this.nextAudioAt=start+buffer.duration;source.start(start);
    if(!this.audible){this.audible=true;this.send({type:'playback',id,phase:'started'});this.status('Quicken is speaking · fully local');}
  }
  private finishPlayback() {
    if(!this.streamComplete||this.chunks.size||!this.proposed||!this.audible)return;
    const intervention=this.proposed;
    this.send({type:'transcript',entry:{id:'moderator-'+intervention.id,text:intervention.text,speaker:'Quicken',source:'moderator'}});
    this.send({type:'playback',id:intervention.id,phase:'finished'});this.proposed=undefined;this.audible=false;this.status('Listening · fully local');
  }
  private async play(id: string, wav: string) {
    const intervention = this.proposed;
    if (!intervention || intervention.id !== id || this.closed || this.ending || this.humanSpeaking || this.meeting?.paused || !this.context) return;
    try {
      const bytes = Uint8Array.from(atob(wav), c => c.charCodeAt(0));
      const decoded = await this.context.decodeAudioData(bytes.buffer);
      if (this.proposed !== intervention || this.closed || this.ending || this.humanSpeaking || this.meeting?.paused) return;
      const source = this.context.createBufferSource(); source.buffer = decoded;
      source.connect(this.context.destination); source.connect(this.output!); this.playback = source;
      source.onended = () => {
        if (this.playback !== source) return;
        this.send({ type: 'transcript', entry: { id: 'moderator-' + id, text: intervention.text, speaker: 'Quicken', source: 'moderator' } });
        this.send({ type: 'playback', id, phase: 'finished' }); this.playback = undefined; this.proposed = undefined; this.audible = false;
        this.status('Listening · fully local');
      };
      await this.context.resume();
      if (this.proposed !== intervention || this.ending || this.closed) return;
      source.start(); this.audible = true; this.send({ type: 'playback', id, phase: 'started' }); this.status('Quicken is speaking · fully local');
    } catch { this.status('Local voice playback failed. Listening continues.'); this.stopSpeaking(); }
  }
  stopSpeaking() {
    const intervention = this.proposed;
    if (this.playback) { this.playback.onended = null; try { this.playback.stop(); } catch { /* Already stopped. */ } this.playback.disconnect(); }
    for(const source of this.chunks){source.onended=null;try{source.stop();}catch{}source.disconnect();}this.chunks.clear();this.streamComplete=false;this.nextAudioAt=0;
    if (intervention && this.audible) this.send({ type: 'transcript', entry: { id: 'moderator-' + intervention.id, text: '[Quicken began an intervention and was interrupted.]', speaker: 'Quicken', source: 'moderator' } });
    this.playback = undefined; this.proposed = undefined; this.audible = false;
  }
  private async finish() {
    if (this.ending || this.closed) return;
    this.ending = true; this.stopSpeaking(); this.status('Finishing the local transcript…');
    this.microphone?.getTracks().forEach(track => { track.enabled = false; });
    if (this.capture) {
      const flushed = new Promise<void>(resolve => { this.resolveFlushed = resolve; }); this.capture.port.postMessage('flush');
      await this.withTimeout(flushed, 500, 'Capture flush timed out.').catch(() => {}); this.capture.disconnect();
    }
    this.send({ type: 'local-drain' });
  }
  enableAudio() { return this.context?.resume() || Promise.resolve(); }
  shutdown() {
    if (this.closed) return;
    this.closed = true; this.stopSpeaking(); this.capture?.disconnect();
    this.microphone?.getTracks().forEach(track => track.stop()); void this.context?.close().catch(() => {}); this.socket?.close(); this.onEnd?.();
  }
}
