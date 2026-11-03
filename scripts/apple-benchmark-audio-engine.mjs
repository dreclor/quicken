// Test-only composition: production ASR/voice and Apple's actual on-device LLM.
import { OfflineEngine } from '../server/local/engine.ts';
import { AppleBenchmarkEngine } from './apple-benchmark-engine.mjs';

export class AppleAudioBenchmarkEngine extends OfflineEngine {
  apple = new AppleBenchmarkEngine();
  label = 'Apple on-device';
  constructor(changed, { client, label, ...options } = {}) {
    super(changed, options);
    if (client) this.apple = client;
    if (label) this.label = label;
  }
  async prepare() {
    if (this.status.status === 'ready') return;
    if (this.applePreparing) return this.applePreparing;
    // Reuse the production speech RPC without starting the Qwen subprocess.
    this.applePreparing = (async () => {
      await this.apple.prepare();
      if (!this.speechLoaded) {
        await this.callSpeech('load', { directory: this.directory + '/speech' }, 120_000);
        this.speechLoaded = true;
      }
      await this.apple.complete('Reply with OK only.', 'Ready', { maxTokens: 8 });
      this.status = { status: 'ready', model: this.label + ' · benchmark', language: 'English', detail: 'Benchmark only' };
    })().finally(() => { this.applePreparing = undefined; });
    return this.applePreparing;
  }
  async complete(system, input, options) { await this.prepare(); return this.apple.complete(system, input, options); }
  close() { this.apple.close(); super.close(); }
}
