/** Mac audio is captured only after the user explicitly starts a local session. */
export class LocalAudio {
  private microphone?: MediaStream;
  private display?: MediaStream;
  private inputContext?: AudioContext;
  private outputContext?: AudioContext;
  private outputSource?: MediaStreamAudioSourceNode;
  private gains: GainNode[] = [];
  private meterTimer?: ReturnType<typeof setInterval>;
  private closing = false;
  constructor(private onEnded: () => void, private onLevels: (mic: number, meeting: number) => void) {}

  async start(microphoneId: string, virtualOutputId: string) {
    if (!window.quickenDesktop) throw new Error('Open the Quicken desktop app to capture Mac meeting audio.');
    if (!virtualOutputId) throw new Error('Choose BlackHole 2ch so everyone in the meeting can hear Quicken.');
    this.closing = false;
    try {
      // Electron 45 honors restrictOwnAudio on macOS. Excluding our own playback
      // prevents the moderator and the microphone passthrough feeding themselves.
      this.display = await navigator.mediaDevices.getDisplayMedia({
        video: true, audio: { restrictOwnAudio: true, echoCancellation: false, suppressLocalAudioPlayback: false } as MediaTrackConstraints,
      });
      this.display.getVideoTracks().forEach(t => t.stop());
      const audioTrack = this.display.getAudioTracks()[0];
      if (!audioTrack || audioTrack.readyState !== 'live') throw new Error('Mac audio capture is unavailable. Allow Quicken in System Settings → Privacy & Security → Screen & System Audio Recording, then reopen Quicken.');
      audioTrack.addEventListener('ended', () => { if (!this.closing) this.onEnded(); });
      this.microphone = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: microphoneId ? { exact: microphoneId } : undefined, echoCancellation: true, noiseSuppression: true } });
      if (/blackhole|aggregate|multi.?output/i.test(this.microphone.getAudioTracks()[0]?.label || '')) throw new Error('Choose your physical microphone, not BlackHole or an aggregate device.');
      this.microphone.getAudioTracks()[0].addEventListener('ended', () => { if (!this.closing) this.onEnded(); });
      this.inputContext = new AudioContext({ latencyHint: 'interactive' });
      this.outputContext = new AudioContext({ latencyHint: 'interactive' });
      await this.outputContext.setSinkId(virtualOutputId);
      const destination = this.inputContext.createMediaStreamDestination();
      const micSource = this.inputContext.createMediaStreamSource(this.microphone);
      const meetingSource = this.inputContext.createMediaStreamSource(new MediaStream([audioTrack]));
      const micGain = this.inputContext.createGain();
      micSource.connect(micGain).connect(destination);
      meetingSource.connect(destination);
      const passthrough = this.outputContext.createMediaStreamSource(this.microphone);
      const outputGain = this.outputContext.createGain();
      passthrough.connect(outputGain).connect(this.outputContext.destination);
      this.gains = [micGain, outputGain];
      const micMeter = this.inputContext.createAnalyser(), meetingMeter = this.inputContext.createAnalyser();
      micMeter.fftSize = meetingMeter.fftSize = 256;
      micGain.connect(micMeter); meetingSource.connect(meetingMeter);
      const level = (meter: AnalyserNode) => { const samples = new Float32Array(256); meter.getFloatTimeDomainData(samples); return Math.min(1, Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length) * 5); };
      this.meterTimer = setInterval(() => this.onLevels(level(micMeter), level(meetingMeter)), 120);
      await this.inputContext.resume(); await this.outputContext.resume();
      return destination.stream;
    } catch (error) { this.close(); throw error; }
  }
  routeModerator(stream: MediaStream) {
    this.outputSource?.disconnect();
    this.outputSource = this.outputContext!.createMediaStreamSource(stream);
    this.outputSource.connect(this.outputContext!.destination);
  }
  muteMicrophone(muted: boolean) { this.gains.forEach(gain => { gain.gain.value = muted ? 0 : 1; }); }
  close() {
    this.closing = true;
    clearInterval(this.meterTimer);
    this.microphone?.getTracks().forEach(t => t.stop());
    this.display?.getTracks().forEach(t => t.stop());
    void this.inputContext?.close().catch(() => {}); void this.outputContext?.close().catch(() => {});
    this.inputContext = undefined; this.outputContext = undefined;
    this.gains = []; this.outputSource = undefined;
  }
}
