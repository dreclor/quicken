import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { release } from 'node:os';
import { createInterface } from 'node:readline';
import type { AppleAvailability } from '../../shared/types.js';

type CompletionOptions = { schema?: object; maxTokens?: number; signal?: AbortSignal };
export interface AppleClient {
  availability(): Promise<AppleAvailability>;
  complete(system: string, input: string, options?: CompletionOptions): Promise<string>;
  close(): void;
}
function orderedSchema(schema: any): any {
  return { ...schema, ...(schema.properties ? { propertyOrder: Object.keys(schema.properties), properties: Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, orderedSchema(value)])) } : {}), ...(schema.items ? { items: orderedSchema(schema.items) } : {}) };
}

export class NativeAppleClient implements AppleClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; cleanup: () => void }>();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(private binary: string) {}
  async availability(): Promise<AppleAvailability> {
    if (process.platform !== 'darwin' || process.arch !== 'arm64' || Number(release().split('.')[0]) < 25) return { available: false, reason: 'unsupported' };
    if (!existsSync(this.binary)) return { available: false, reason: 'helperMissing' };
    try { const value = await this.call('availability', {}, undefined, 15_000); return { available: value.available === true, reason: value.reason }; }
    catch { return { available: false, reason: 'unavailable' }; }
  }
  complete(system: string, input: string, options: CompletionOptions = {}) {
    const task = this.queue.catch(() => {}).then(async () => {
      options.signal?.throwIfAborted();
      const value = await this.call('complete', { system, input, maxTokens: options.maxTokens ?? 320, ...(options.schema ? { schema: JSON.stringify(orderedSchema(options.schema)) } : {}) }, options.signal);
      if (!value.text?.trim()) throw new Error('Apple AI returned an empty response.');
      return value.text.trim() as string;
    });
    this.queue = task;
    return task;
  }
  private stop(error: Error) {
    const child = this.child; this.child = undefined; child?.kill();
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(error); }
    this.pending.clear();
  }
  private start() {
    if (this.closed) throw new Error('Quicken closed.');
    if (this.child) return;
    const child = spawn(this.binary, [], { stdio: ['pipe', 'pipe', 'pipe'] }); this.child = child;
    child.stderr.on('data', () => {});
    createInterface({ input: child.stdout }).on('line', line => {
      let value: any; try { value = JSON.parse(line); } catch { return; }
      const pending = this.pending.get(value.id); if (!pending) return;
      this.pending.delete(value.id); pending.cleanup();
      if (value.ok) pending.resolve(value); else pending.reject(new Error(String(value.error || 'Apple AI could not complete this request.')));
    });
    const failed = () => { if (this.child === child) this.stop(new Error('Apple AI stopped. Check local AI in Settings.')); };
    child.on('error', failed); child.on('exit', failed);
  }
  private call(op: string, args: object, signal?: AbortSignal, timeout = 120_000): Promise<any> {
    signal?.throwIfAborted(); this.start(); const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const abort = () => this.stop(new Error('Apple AI request cancelled.'));
      const timer = setTimeout(() => this.stop(new Error('Apple AI took too long. Check local AI in Settings.')), timeout);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      this.pending.set(id, { resolve, reject, cleanup }); signal?.addEventListener('abort', abort, { once: true });
      this.child!.stdin.write(JSON.stringify({ id, op, ...args }) + '\n', error => { if (error) this.stop(error); });
    });
  }
  close() { this.closed = true; this.stop(new Error('Quicken closed.')); }
}
