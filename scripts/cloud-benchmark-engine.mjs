// Benchmark only. Callers supply synthetic fixtures; no saved meetings are read.
export class CloudBenchmarkEngine {
  constructor(model, onRequest = () => {}) { this.model = model; this.onRequest = onRequest; }
  async prepare() { if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required for the cloud benchmark.'); }
  async complete(system, input, options = {}) {
    await this.prepare();
    const start = performance.now();
    const record = { model: this.model, firstTokenMs: null };
    const body = {
      model: this.model, instructions: system, input, store: false, stream: true,
      service_tier: 'default', reasoning: { effort: 'none' }, temperature: 0.1,
      max_output_tokens: Math.max(16, options.maxTokens ?? 320),
      ...(options.schema ? { text: { format: { type: 'json_schema', name: 'QuickenResult', strict: true, schema: options.schema } } } : {})
    };
    try {
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST', headers: { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000)
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(`Cloud HTTP ${response.status}: ${error.error?.code || error.error?.type || 'request failed'}`);
      }
      let buffer = '', text = '', completed;
      const decoder = new TextDecoder();
      const accept = line => {
        if (!line.startsWith('data: ')) return;
        const raw = line.slice(6).trim(); if (raw === '[DONE]') return;
        const event = JSON.parse(raw);
        if (event.type === 'response.output_text.delta') {
          record.firstTokenMs ??= Math.round(performance.now() - start);
          text += event.delta;
        }
        if (['response.completed', 'response.incomplete', 'response.failed'].includes(event.type)) completed = event.response;
        if (event.type === 'error') throw new Error(`Cloud stream error: ${event.code || 'unknown'}`);
      };
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n')) !== -1) { accept(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
      }
      buffer += decoder.decode(); if (buffer.trim()) accept(buffer);
      Object.assign(record, { ms: Math.round(performance.now() - start), text, usage: completed?.usage, serviceTier: completed?.service_tier, returnedModel: completed?.model, status: completed?.status, incompleteDetails: completed?.incomplete_details });
      if (!completed || completed.status !== 'completed' || !text.trim()) throw new Error(`Cloud response ${completed?.status || 'missing completion'}: ${completed?.incomplete_details?.reason || 'empty or refused'}`);
      this.onRequest(record);
      return text.trim();
    } catch (error) {
      this.onRequest({ ...record, ms: Math.round(performance.now() - start), error: String(error) });
      throw error;
    }
  }
  close() {}
}
