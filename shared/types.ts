import { z } from 'zod';

export const reasonSchema = z.enum(['off_track', 'unanswered', 'ambiguous', 'time', 'addressed']);
export type Reason = z.infer<typeof reasonSchema>;
export const reasonLabels: Record<Reason, string> = { off_track: 'Topic drift', unanswered: 'Open questions', ambiguous: 'Clear commitments', time: 'Time reminders', addressed: 'Direct questions' };
export const agendaSchema = z.object({ id: z.string().max(80), title: z.string().min(1).max(240), minutes: z.number().min(1).max(120) });
export type AgendaItem = z.infer<typeof agendaSchema>;
export const createMeetingSchema = z.object({
  title: z.string().min(1).max(120), meetingUrl: z.string().max(2000).default(''),
  mode: z.enum(['meeting', 'rehearsal', 'local', 'demo']), agenda: z.array(agendaSchema).max(30).default([]),
  processing: z.enum(['local', 'cloud']).default('local'),
  intensity: z.enum(['gentle', 'balanced', 'active']).default('balanced'),
  enabledReasons: z.array(reasonSchema).default(['off_track', 'unanswered', 'ambiguous', 'time', 'addressed'])
});
export type MeetingInput = z.infer<typeof createMeetingSchema>;
export const assessmentSchema = z.object({
  intervene: z.boolean(), reason: reasonSchema, text: z.string().max(300),
  evidence: z.string().max(500), confidence: z.number().min(0).max(1),
  topic: z.string().max(240), openQuestions: z.array(z.string().max(350)).max(20),
  decisions: z.array(z.string().max(350)).max(20),
  actionItems: z.array(z.string().max(350)).max(20)
});
export type Assessment = z.infer<typeof assessmentSchema>;
export type TranscriptEntry = { id: string; speaker: string; text: string; at: number; source: 'recall' | 'realtime' | 'moderator' | 'demo' | 'local' };
export type Intervention = { id: string; reason: Reason; text: string; evidence: string; confidence: number; proposedAt: number; spokenAt?: number; state: 'queued' | 'speaking' | 'spoken' | 'interrupted' | 'dismissed'; latencyMs?: number };
export type Meeting = MeetingInput & {
  id: string; createdAt: number; startedAt?: number; endedAt?: number;
  status: 'draft' | 'joining' | 'live' | 'ending' | 'ended' | 'error'; paused: boolean;
  bridgeConnected: boolean; currentAgendaIndex: number; agendaStartedAt?: number;
  topic: string; openQuestions: string[]; decisions: string[]; actionItems: string[];
  transcript: TranscriptEntry[]; interventions: Intervention[]; notes: string;
  notesStatus: 'none' | 'generating' | 'ready' | 'error'; error?: string; botStatus?: string;
  metrics: { responseMs: number[]; assessments: number; rejected: number };
};
export type Settings = { recallApiKey: string; openaiApiKey: string; recallRegion: string; publicBaseUrl: string; realtimeModel: string; notesModel: string };
export type PublicSettings = Omit<Settings, 'recallApiKey' | 'openaiApiKey'> & { hasOpenaiKey: boolean; hasRecallKey: boolean };
export type AppleAvailability = { available: boolean; reason: 'available' | 'disabled' | 'unsupported' | 'notReady' | 'helperMissing' | 'unavailable' };
export type LocalModelPreference = 'auto' | 'qwen';
export type LocalAIStatus = { provider?: 'apple' | 'qwen'; preference?: LocalModelPreference; apple?: AppleAvailability; qwenInstalled?: boolean; speechInstalled?: boolean; status: 'checking' | 'unavailable' | 'missing' | 'installed' | 'downloading' | 'loading' | 'ready' | 'error'; detail: string; progress?: number; model: string; language: string };
export type AppState = { meetings: Meeting[]; settings: PublicSettings; localAI?: LocalAIStatus };
export const usesLocalAI = (meeting: Pick<Meeting, 'processing' | 'mode'>) => meeting.processing === 'local' && meeting.mode !== 'demo';
export type BridgeCommand = { type: 'speak'; intervention: Intervention } | { type: 'stop' } | { type: 'state'; meeting: Meeting } | { type: 'end'; drainMs: number };

export function parseAgenda(text: string): AgendaItem[] {
  return text.split(/\r?\n/).map(s => s.replace(/^\s*(?:#{1,6}\s*|[-*•]\s*|\d+[.)]\s*)/, '').trim())
    .filter(Boolean).slice(0, 30).map((line, i) => {
      const time = line.match(/(?:\(|\[|\b)(\d{1,3})\s*(?:minutes?|mins?|m)\b\)?\]?/i);
      return { id: `item-${i + 1}`, title: line.replace(time?.[0] ?? '\u0000', '').replace(/^\s*[|:–—-]\s*|\s*[|:–—-]\s*$/g, '').trim().slice(0, 240) || `Topic ${i + 1}`, minutes: Math.max(1, Math.min(120, Number(time?.[1] || 10))) };
    });
}
