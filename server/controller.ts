import { randomUUID } from 'node:crypto';
import type { Assessment, BridgeCommand, Meeting } from '../shared/types.js';

const policies = { gentle: { cooldown: 120_000, confidence: .9 }, balanced: { cooldown: 60_000, confidence: .8 }, active: { cooldown: 25_000, confidence: .7 } };
export const timeReminderText = (topic: string, remaining: number) => remaining > 0 ? `We have about a minute left for ${topic}. Shall we wrap up or give it more time?` : `We've reached our time for ${topic}. Shall we move on or extend it?`;
export class MeetingController {
  humanSpeaking = false;
  revision = 0;
  speechEndedAt = 0;
  lastSpokeAt = -Infinity;
  pending?: { id: string; revision: number; expiresAt: number };
  activeId?: string;
  private seen = new Map<string, number>();
  private reminded = new Set<number>();
  constructor(public meeting: Meeting, private emit: (cmd: BridgeCommand) => void, private changed: () => void, private now = () => Date.now()) {}
  speech(started: boolean) {
    this.humanSpeaking = started;
    if (started) { this.revision++; this.cancel('interrupted'); }
    else this.speechEndedAt = this.now();
    this.changed();
  }
  assess(assessment: Assessment, revision: number) {
    this.meeting.metrics.assessments++;
    if (revision !== this.revision || this.meeting.status !== 'live') return this.reject();
    this.meeting.topic = assessment.topic;
    this.meeting.openQuestions = assessment.openQuestions;
    this.meeting.decisions = [...new Set([...this.meeting.decisions, ...assessment.decisions])].slice(-100);
    this.meeting.actionItems = [...new Set([...this.meeting.actionItems, ...assessment.actionItems])].slice(-100);
    this.changed();
    if (!assessment.intervene) {
      // A model assessment about the conversation must not erase a time reminder
      // created independently while that assessment was in flight.
      const item = this.meeting.interventions.find(x => x.id === (this.pending?.id || this.activeId));
      if (item && item.reason !== 'time') this.cancel('dismissed');
      return false;
    }
    return this.propose(assessment, revision);
  }
  private reject() { this.meeting.metrics.rejected++; this.changed(); return false; }
  propose(a: Pick<Assessment, 'reason'|'text'|'evidence'|'confidence'>, revision = this.revision) {
    const now = this.now(), p = policies[this.meeting.intensity];
    if (this.meeting.status !== 'live' || this.meeting.paused || this.humanSpeaking || revision !== this.revision || !this.meeting.enabledReasons.includes(a.reason) || a.confidence < p.confidence || !a.text.trim() || this.pending || this.activeId) return this.reject();
    if (a.reason !== 'addressed' && now - this.lastSpokeAt < p.cooldown) return this.reject();
    const fingerprint = a.reason + ':' + a.text.toLowerCase().replace(/\W+/g, ' ').trim();
    if (now - (this.seen.get(fingerprint) ?? -Infinity) < 300_000) return this.reject();
    const id = randomUUID();
    this.meeting.interventions.push({ id, ...a, text: a.text.trim(), proposedAt: now, state: 'queued' });
    this.pending = { id, revision, expiresAt: now + 6_000 };
    this.changed();
    this.tick();
    return true;
  }
  tick() {
    const now = this.now();
    if (this.pending) {
      const pending = this.pending;
      if (this.meeting.paused || this.meeting.status !== 'live' || now > pending.expiresAt || pending.revision !== this.revision) return this.cancel('dismissed');
      if (!this.humanSpeaking && now - this.speechEndedAt >= 450) {
        const item = this.meeting.interventions.find(x => x.id === pending.id)!;
        this.pending = undefined;
        this.activeId = item.id;
        this.emit({ type: 'speak', intervention: item });
      }
    }
    if (this.activeId) {
      const active = this.meeting.interventions.find(x => x.id === this.activeId);
      if (active && now - (active.spokenAt ?? active.proposedAt) > 20_000) this.cancel('interrupted');
    }
    if (!this.meeting.agendaStartedAt || this.meeting.status !== 'live' || this.meeting.mode === 'demo') return;
    const item = this.meeting.agenda[this.meeting.currentAgendaIndex];
    if (!item || this.reminded.has(this.meeting.currentAgendaIndex)) return;
    const remaining = item.minutes * 60_000 - (now - this.meeting.agendaStartedAt);
    if (remaining <= 60_000 && remaining > -60_000 && this.propose({ reason: 'time', text: timeReminderText(item.title,remaining), evidence: 'Agenda timebox', confidence: 1 })) this.reminded.add(this.meeting.currentAgendaIndex);
  }
  playback(id: string, phase: 'started' | 'finished') {
    const item = this.meeting.interventions.find(x => x.id === id);
    if (!item || this.activeId !== id) return;
    if (phase === 'started') {
      if (this.humanSpeaking || this.meeting.paused || this.meeting.status !== 'live') return this.cancel('interrupted');
      item.state = 'speaking'; item.spokenAt = this.now(); this.lastSpokeAt = this.now();
      if (this.speechEndedAt > 0) { item.latencyMs = this.now() - this.speechEndedAt; this.meeting.metrics.responseMs.push(item.latencyMs); }
      this.seen.set(item.reason + ':' + item.text.toLowerCase().replace(/\W+/g, ' ').trim(), this.now());
    } else { item.state = 'spoken'; this.activeId = undefined; }
    this.changed();
  }
  cancel(state: 'interrupted' | 'dismissed') {
    for (const id of [this.pending?.id, this.activeId]) {
      const item = this.meeting.interventions.find(x => x.id === id);
      if (item) item.state = item.spokenAt ? state : 'dismissed';
    }
    this.pending = undefined; this.activeId = undefined;
    this.emit({ type: 'stop' }); this.changed();
  }
  advance(index: number) {
    this.cancel('dismissed'); this.revision++;
    this.meeting.currentAgendaIndex = Math.max(0, Math.min(index, this.meeting.agenda.length - 1));
    this.meeting.agendaStartedAt = this.now(); this.changed();
  }
}
