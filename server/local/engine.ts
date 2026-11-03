import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { open, rename, rm, readFile, readdir, cp } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import type { LocalAIStatus } from '../../shared/types.js';

export const languageModel = {
  name: 'Qwen3 4B · local', file: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf', bytes: 2497281120,
  sha: '3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597',
  url: 'https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/a06e946bb6b655725eafa393f4a9745d460374c9/Qwen3-4B-Instruct-2507-Q4_K_M.gguf'
};
type SpeechEvent = { event: 'partial' | 'final'; text: string };
export type VoiceChunk = { pcm: Buffer; rate: number };
export interface LocalEngine {
  status: LocalAIStatus;
  setup(): Promise<void>;
  prepare(): Promise<void>;
  startSpeech(listener: (event: SpeechEvent) => void): Promise<void>;
  audio(pcm: string): Promise<void>;
  flush(): Promise<void>;
  stopSpeech(): void;
  complete(system: string, input: string, options?: { schema?: object; maxTokens?: number; signal?: AbortSignal }): Promise<string>;
  voice(text: string): Promise<Buffer>;
  streamVoice?(text: string, chunk: (value: VoiceChunk) => void): Promise<void>;
  close(): void;
}

export class OfflineEngine implements LocalEngine {
  status: LocalAIStatus;
  readonly directory: string;
  private nativeDir: string;
  private speech?: ChildProcessWithoutNullStreams;
  private llm?: ChildProcessWithoutNullStreams;
  private rpcId = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private listener?: (event: SpeechEvent) => void;
  private initializing?: Promise<void>;
  private installing?: Promise<void>;
  private speechLoaded = false;
  private closing = false;
  private address = '';
  private secret = randomBytes(32).toString('hex');
  private voiceTasks = new Map<string, Promise<Buffer>>();
  private voiceChildren = new Set<ChildProcessWithoutNullStreams>();
  constructor(private changed: () => void, options: { directory?: string; nativeDir?: string } = {}) {
    this.directory = options.directory || process.env.QUICKEN_MODELS_DIR || join(homedir(), 'Library/Application Support/Quicken/LocalModels');
    this.nativeDir = options.nativeDir || process.env.QUICKEN_NATIVE_DIR || resolve('native/bin');
    this.status = { status: 'missing', detail: 'Download the local models once. Meetings then work without AI accounts or internet access.', model: languageModel.name, language: 'English' };
    if (process.platform !== 'darwin' || process.arch !== 'arm64') this.set('unavailable', 'Local AI currently requires an Apple Silicon Mac.');
    else if (!existsSync(join(this.nativeDir, 'quicken-speech')) || !existsSync(join(this.nativeDir, 'quicken-llm')) || !existsSync(join(this.nativeDir, 'quicken-voice'))) this.set('unavailable', 'The local engine is not built. Build the native helpers or install the packaged Mac app.');
    else if (this.installed()) this.set('installed', 'Local models installed. Ready to warm up.');
  }
  private installed() {
    try { return statSync(join(this.directory, languageModel.file)).size === languageModel.bytes && existsSync(join(this.directory, 'speech-ready.json')); } catch { return false; }
  }
  private set(status: LocalAIStatus['status'], detail: string, progress?: number) {
    this.status = { ...this.status, status, detail, progress }; this.changed();
  }
  private async hashFile(file: string) {
    const hash = createHash('sha256'); for await (const part of createReadStream(file)) hash.update(part); return hash.digest('hex');
  }
  setup() {
    if (this.installing) return this.installing;
    if (this.status.status === 'unavailable') return Promise.reject(new Error(this.status.detail));
    this.installing = (async () => {
      this.set('downloading', 'Preparing local models…');
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const licenses = existsSync(join(this.nativeDir, 'licenses')) ? join(this.nativeDir, 'licenses') : resolve(this.nativeDir, '../licenses');
      await cp(licenses, join(this.directory, 'licenses'), { recursive: true });
      const target = join(this.directory, languageModel.file);
      if (!existsSync(target) || await this.hashFile(target) !== languageModel.sha) {
        const partial = target + '.part';
        const response = await fetch(languageModel.url, { signal: AbortSignal.timeout(30 * 60_000) });
        if (!response.ok || !response.body) throw new Error(`Model download failed (${response.status}). Try again.`);
        const file = await open(partial, 'w', 0o600), hash = createHash('sha256'); let received = 0, reported = 0;
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value: chunk } = await reader.read(); if (done) break;
            let offset = 0; while (offset < chunk.length) { const written = await file.write(chunk, offset, chunk.length - offset); offset += written.bytesWritten; }
            hash.update(chunk); received += chunk.length;
            if (Date.now() - reported > 500) { reported = Date.now(); this.set('downloading', `Language model: ${Math.round(received / 1048576)} / ${Math.round(languageModel.bytes / 1048576)} MB`, received / languageModel.bytes); }
          }
        } finally { reader.releaseLock(); await file.close(); }
        if (received !== languageModel.bytes || hash.digest('hex') !== languageModel.sha) { await rm(partial, { force: true }); throw new Error('The model download did not pass its integrity check. Please retry.'); }
        await rename(partial, target);
      }
      this.set('downloading', 'Installing the English streaming speech model…');
      await this.callSpeech('install', { directory: join(this.directory, 'speech') }, 30 * 60_000);
      this.speechLoaded = true;
      writeFileSync(join(this.directory, 'speech-ready.json'), JSON.stringify({ engine: 'FluidAudio 0.18.2', model: 'Parakeet EOU 120M / 160ms' }), { mode: 0o600 });
      this.set('installed', 'Models installed. Warming up local AI…');
      await this.prepare();
    })().catch(error => { this.set('error', error.message); throw error; }).finally(() => { this.installing = undefined; });
    return this.installing;
  }
  private ensureSpeech() {
    if (this.speech && !this.speech.killed) return;
    const child = spawn(join(this.nativeDir, 'quicken-speech'), [], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HF_HUB_OFFLINE: '1' } });
    this.speech = child;
    createInterface({ input: child.stdout }).on('line', line => {
      let value: any; try { value = JSON.parse(line); } catch { return; }
      if (value.event === 'partial' || value.event === 'final') this.listener?.(value);
      if (value.id && this.pending.has(value.id)) {
        const pending = this.pending.get(value.id)!; this.pending.delete(value.id); clearTimeout(pending.timer);
        if (value.ok) pending.resolve(value); else pending.reject(new Error(String(value.error || 'Local speech failed.')));
      }
    });
    child.stderr.on('data', () => {}); // No meeting content in application logs.
    const failed = () => {
      if (this.speech !== child) return;
      this.speech = undefined; this.speechLoaded = false;
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('The local speech engine stopped. Reconnect audio to retry.')); }
      this.pending.clear();
      if (!this.closing) this.set('error', 'The local speech engine stopped. Reconnect audio to retry.');
    };
    child.on('error', failed); child.on('exit', failed);
  }
  private callSpeech(op: string, args: object = {}, timeout = 20_000): Promise<any> {
    if (this.closing) return Promise.reject(new Error('Quicken closed.'));
    this.ensureSpeech(); const id = ++this.rpcId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('The local speech engine timed out. Reconnect audio to retry.')); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.speech!.stdin.write(JSON.stringify({ id, op, ...args }) + '\n', error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); } });
    });
  }
  prepare() {
    if (this.status.status === 'ready' && this.llm && this.speechLoaded) return Promise.resolve();
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      if (!this.installed()) throw new Error('Download local AI in Connections before starting a local session.');
      this.set('loading', 'Warming up speech recognition and the local moderator…');
      if (!this.speechLoaded) { await this.callSpeech('load', { directory: join(this.directory, 'speech') }, 120_000); this.speechLoaded = true; }
      if (!this.llm) {
        const port = await new Promise<number>((resolve, reject) => {
          const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = (server.address() as any).port; server.close(() => resolve(port)); });
        });
        this.address = `http://127.0.0.1:${port}`;
        const child = spawn(join(this.nativeDir, 'quicken-llm'), ['-m', join(this.directory, languageModel.file), '--host', '127.0.0.1', '--port', String(port), '-c', '8192', '-np', '1', '-ngl', '99', '-t', '4', '--no-webui', '--offline', '--no-slots'], { env: { ...process.env, LLAMA_API_KEY: this.secret }, stdio: ['pipe', 'pipe', 'pipe'] });
        this.llm = child;
        child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
        child.on('error', () => { this.llm = undefined; }); child.on('exit', () => { if (this.llm === child) { this.llm = undefined; if (!this.closing) this.set('error', 'The local language model stopped. Reconnect to retry.'); } });
        let ready = false;
        for (let i = 0; i < 240 && this.llm === child; i++) {
          try { ready = (await fetch(this.address + '/health', { headers: { Authorization: `Bearer ${this.secret}` }, signal: AbortSignal.timeout(1000) })).ok; } catch { /* Loading. */ }
          if (ready) break;
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        if (!ready) { child.kill(); throw new Error('The local language model could not start. Close memory-heavy apps and retry.'); }
      }
      this.set('ready', 'All AI runs on this Mac. No API keys needed.');
    })().catch(error => { this.set('error', error.message); throw error; }).finally(() => { this.initializing = undefined; });
    return this.initializing;
  }
  async startSpeech(listener: (event: SpeechEvent) => void) {
    await this.prepare(); this.listener = undefined; await this.callSpeech('reset');
    // Prime the streaming encoder's initial context before the user speaks.
    // This avoids clipping the first wake word immediately after Start.
    for (let i = 0; i < 6; i++) await this.audio(Buffer.alloc(5120).toString('base64'));
    this.listener = listener;
  }
  audio(pcm: string) { return this.callSpeech('audio', { pcm }).then(() => {}); }
  flush() { return this.callSpeech('flush').then(() => {}); }
  stopSpeech() { this.listener = undefined; }
  async complete(system: string, input: string, options: { schema?: object; maxTokens?: number; signal?: AbortSignal } = {}) {
    await this.prepare();
    const response = await fetch(this.address + '/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${this.secret}`, 'Content-Type': 'application/json' },
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
      body: JSON.stringify({ messages: [{ role: 'system', content: system }, { role: 'user', content: input }], temperature: 0.1, max_tokens: options.maxTokens ?? 320, cache_prompt: true, ...(options.schema ? { response_format: { type: 'json_object', schema: options.schema } } : {}) })
    });
    if (!response.ok) throw new Error(`Local model returned ${response.status}.`);
    const result = await response.json() as any; const text = result.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('The local model returned an empty response.');
    return text as string;
  }
  private voiceKey(text: string) { return createHash('sha256').update('AVSpeech:Samantha:0.5:' + text).digest('hex'); }
  private voicePath(text: string) { return join(this.directory, 'voice-cache', this.voiceKey(text) + '.wav'); }
  async streamVoice(text: string, chunk: (value: VoiceChunk) => void) {
    if (this.closing) throw new Error('Quicken closed.');
    const file = this.voicePath(text);
    if (existsSync(file)) {
      const wav = await readFile(file); chunk({pcm:wav.subarray(44),rate:wav.readUInt32LE(24)}); return;
    }
    const parts: Buffer[]=[]; let sampleRate=22050;
    await new Promise<void>((resolve,reject)=>{
      const child=spawn(join(this.nativeDir,'quicken-voice'),[],{stdio:['pipe','pipe','pipe']});this.voiceChildren.add(child);
      let detail=''; const timeout=setTimeout(()=>child.kill(),15_000);
      child.stderr.on('data',data=>{detail=(detail+data.toString()).slice(-1000);});
      createInterface({input:child.stdout}).on('line',line=>{
        try {const value=JSON.parse(line);const pcm=Buffer.from(value.pcm,'base64');sampleRate=value.rate;if(pcm.length){parts.push(pcm);chunk({pcm,rate:sampleRate});}}catch{/* Ignore non-protocol diagnostics. */}
      });
      child.on('error',error=>{clearTimeout(timeout);this.voiceChildren.delete(child);reject(error);});
      child.on('close',code=>{clearTimeout(timeout);this.voiceChildren.delete(child);if(code===0&&parts.length)resolve();else reject(new Error(detail.trim()||'Local voice could not generate audio. Check the installed English voice.'));});
      child.stdin.end(text);
    });
    const pcm=Buffer.concat(parts), header=Buffer.alloc(44);
    header.write('RIFF');header.writeUInt32LE(pcm.length+36,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(sampleRate,24);header.writeUInt32LE(sampleRate*2,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40);
    const dir=join(this.directory,'voice-cache');mkdirSync(dir,{recursive:true,mode:0o700});
    const temporary=file+'.'+randomBytes(4).toString('hex')+'.tmp';
    writeFileSync(temporary,Buffer.concat([header,pcm]),{mode:0o600});await rename(temporary,file);
    const cached=(await readdir(dir)).filter(x=>x.endsWith('.wav'));
    if(cached.length>128)await Promise.all(cached.filter(x=>join(dir,x)!==file).slice(0,cached.length-128).map(x=>rm(join(dir,x),{force:true})));
  }
  voice(text: string) {
    const key = this.voiceKey(text);
    if (this.voiceTasks.has(key)) return this.voiceTasks.get(key)!;
    const task = (async () => {
      await this.streamVoice(text,()=>{}); return await readFile(this.voicePath(text));
    })().finally(() => this.voiceTasks.delete(key));
    this.voiceTasks.set(key, task); return task;
  }
  close() {
    this.closing = true; this.listener = undefined;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Quicken closed.')); }
    this.pending.clear(); this.speech?.kill(); this.llm?.kill(); this.speech = undefined; this.llm = undefined;
    for(const child of this.voiceChildren)child.kill();this.voiceChildren.clear();
  }
}
