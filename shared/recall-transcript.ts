import type { TranscriptEntry } from './types.js';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : undefined;

// A compact, stable content ID prevents retries from duplicating utterances.
// Hash the entire text rather than truncating an ID built from its first words.
function fingerprint(value: string) {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < value.length; i++) hash = BigInt.asUintN(64, (hash ^ BigInt(value.charCodeAt(i))) * 0x100000001b3n);
  return hash.toString(16).padStart(16, '0');
}

export function recallTranscriptEntry(payload: unknown, startedAt?: number, receivedAt = Date.now()): TranscriptEntry | undefined {
  const root = object(payload);
  if (!root) return;
  const data = object(root.data), inner = object(data?.data);
  const envelopes = [root, data, inner].filter((v): v is ObjectValue => !!v);
  if (envelopes.some(v => v.event === 'transcript.partial_data' || v.type === 'transcript.partial_data' || v.is_final === false)) return;
  // Output Media's local socket wraps words in `transcript`; newer realtime
  // events wrap them in `data.data`. A metadata-only transcript is not speech.
  let transcript: ObjectValue | undefined, parent: ObjectValue | undefined;
  for (const candidate of [inner, data, root]) {
    if (!candidate) continue;
    if (Array.isArray(candidate.words)) { transcript = candidate; parent = candidate; break; }
    const nested = object(candidate.transcript);
    if (Array.isArray(nested?.words)) { transcript = nested; parent = candidate; break; }
  }
  if (!transcript || transcript.is_final === false) return;
  const words = transcript.words as unknown[];
  if (!words.length || words.some(w => typeof object(w)?.text !== 'string')) return;
  const text = words.map(w => (w as ObjectValue).text as string).join(' ').trim();
  if (!text) return;
  const participant = object(transcript.participant) || object(parent?.participant);
  const speaker = typeof participant?.name === 'string' && participant.name.trim() ? participant.name.trim().slice(0, 120) : 'Participant';
  const timestamp = object(object(words[0])?.start_timestamp);
  const absolute = typeof timestamp?.absolute === 'string' ? Date.parse(timestamp.absolute) : NaN;
  const relative = typeof timestamp?.relative === 'number' && Number.isFinite(timestamp.relative) && timestamp.relative >= 0 ? timestamp.relative : undefined;
  const at = Number.isFinite(absolute) ? absolute : relative !== undefined && startedAt !== undefined ? startedAt + relative * 1000 : receivedAt;
  const identity = JSON.stringify([participant?.id ?? speaker, timestamp?.absolute ?? relative ?? null, text]);
  return { id: `recall-${fingerprint(identity)}`, speaker, text: text.slice(0, 20_000), at, source: 'recall' };
}
