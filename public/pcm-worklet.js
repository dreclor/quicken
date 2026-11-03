// Capture is connected only after an explicit Start action. PCM never leaves localhost.
class QuickenPCM extends AudioWorkletProcessor {
  constructor() {
    super(); this.samples = new Int16Array(2560); this.offset = 0; this.energy = 0; this.running = true;
    this.port.onmessage = event => {
      if (event.data === 'flush') { this.emit(); this.running = false; this.port.postMessage({ flushed: true }); }
    };
  }
  emit() {
    if (!this.offset) return;
    const pcm = this.samples.slice(0, this.offset);
    this.port.postMessage({ pcm: pcm.buffer, level: Math.sqrt(this.energy / this.offset), duration: this.offset / sampleRate }, [pcm.buffer]);
    this.offset = 0; this.energy = 0;
  }
  process(inputs) {
    if (!this.running) return false;
    const channels = inputs[0]; if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let value = 0; for (const channel of channels) value += channel[i]; value = Math.max(-1, Math.min(1, value / channels.length));
      this.samples[this.offset++] = value < 0 ? value * 32768 : value * 32767; this.energy += value * value;
      if (this.offset === this.samples.length) this.emit();
    }
    return true;
  }
}
registerProcessor('quicken-pcm', QuickenPCM);
