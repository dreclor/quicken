import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Meeting, Settings } from '../shared/types.js';

export type RecordData = { meeting: Meeting; bridgeToken: string; botId?: string };
export class Store {
  records = new Map<string, RecordData>();
  settings: Settings;
  accessToken: string;
  constructor(public dir: string) {
    mkdirSync(join(dir, 'meetings'), { recursive: true, mode: 0o700 });
    const accessFile = join(dir, 'access-token');
    this.accessToken = existsSync(accessFile) ? readFileSync(accessFile, 'utf8').trim() : randomBytes(32).toString('hex');
    writeFileSync(accessFile, this.accessToken, { mode: 0o600 });
    const saved = existsSync(join(dir, 'settings.json')) ? JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) : {};
    this.settings = { recallApiKey: saved.recallApiKey || process.env.RECALL_API_KEY || '', openaiApiKey: saved.openaiApiKey || process.env.OPENAI_API_KEY || '', recallRegion: saved.recallRegion || process.env.RECALL_REGION || 'us-west-2', publicBaseUrl: saved.publicBaseUrl || process.env.PUBLIC_BASE_URL || '', realtimeModel: saved.realtimeModel || process.env.REALTIME_MODEL || 'gpt-realtime-2.1-mini', notesModel: saved.notesModel || process.env.NOTES_MODEL || 'gpt-6-luna' };
    for (const file of readdirSync(join(dir, 'meetings')).filter(x => x.endsWith('.json'))) {
      try { const r: RecordData = JSON.parse(readFileSync(join(dir, 'meetings', file), 'utf8')); r.meeting.processing ||= 'cloud'; r.meeting.bridgeConnected = false; if(r.meeting.status==='ending'){r.meeting.status='ended';r.meeting.endedAt||=Date.now();r.bridgeToken=randomBytes(32).toString('hex');r.meeting.error='Quicken closed while finishing this transcript. Saved words are preserved; generate notes to continue.';} if(r.meeting.notesStatus==='generating'){r.meeting.notesStatus='error';r.meeting.error='Notes generation was interrupted. Retry AI notes.';} if (r.meeting.status === 'live' || r.meeting.status === 'joining') r.meeting.error = 'App restarted. Reconnect the meeting bridge or end this session.'; this.records.set(r.meeting.id, r); } catch { /* A damaged session file must not prevent other meetings from loading. */ }
    }
  }
  private atomic(file: string, data: unknown) { const target = join(this.dir, file); writeFileSync(target + '.tmp', JSON.stringify(data, null, 2), { mode: 0o600 }); renameSync(target + '.tmp', target); }
  save(record: RecordData) { this.records.set(record.meeting.id, record); this.atomic(`meetings/${record.meeting.id}.json`, record); }
  saveSettings() { this.atomic('settings.json', this.settings); }
  publicSettings() { const { openaiApiKey, recallApiKey, ...rest } = this.settings; return { ...rest, hasOpenaiKey: !!openaiApiKey, hasRecallKey: !!recallApiKey }; }
  state() { return { meetings: [...this.records.values()].map(x => x.meeting).sort((a, b) => b.createdAt - a.createdAt), settings: this.publicSettings() }; }
}
