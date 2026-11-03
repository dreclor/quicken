import type { LocalEngine } from '../server/local/engine';
import type { LocalAIStatus } from '../shared/types';

export class FakeLocalEngine implements LocalEngine {
  status: LocalAIStatus = { status: 'ready', detail: 'Test fixture', model: 'Test fixture', language: 'English' };
  listener?: Parameters<LocalEngine['startSpeech']>[0];
  finalOnFlush = '';
  calls = { prepare: 0, audio: 0, complete: 0, voice: 0 };
  async setup() {}
  async prepare() { this.calls.prepare++; }
  async startSpeech(listener: Parameters<LocalEngine['startSpeech']>[0]) { this.listener = listener; }
  async audio() { this.calls.audio++; }
  async flush() { if (this.finalOnFlush) { this.listener?.({event:'final',text:this.finalOnFlush}); this.finalOnFlush=''; } }
  stopSpeech() { this.listener = undefined; }
  async complete(_system: string, input: string, options?: {schema?: object}) {
    this.calls.complete++;
    if (options?.schema && 'properties' in options.schema && 'summary' in (options.schema as any).properties) {
      const row = JSON.parse(input).transcript[0];
      return JSON.stringify({summary:[{text:row.text,sourceId:row.id,quote:row.text}],decisions:[],actionItems:[],openQuestions:[]});
    }
    return options?.schema ? JSON.stringify({intervene:false,reason:'addressed',text:'',evidence:'',confidence:1,topic:'Launch',openQuestions:[],decisions:[],actionItems:[]}) : '# Local notes\n\n' + input;
  }
  async voice() { this.calls.voice++; return Buffer.from('fixture'); }
  close() { this.listener = undefined; }
}
