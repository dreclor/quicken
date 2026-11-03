import {describe,it,expect} from 'vitest';
import {recallTranscriptEntry} from '../shared/recall-transcript';

const sentence={words:[{text:'Ship',start_timestamp:{relative:0}},{text:'Friday.',start_timestamp:{relative:.4}}],participant:{id:0,name:'Alex'}};
describe('Recall transcript formats',()=>{
  it('reads Output Media, raw data, and nested realtime envelopes consistently',()=>{
    const formats=[{transcript:sentence},sentence,{data:sentence},{event:'transcript.data',data:{data:sentence,transcript:{id:'transcript-metadata'}}}];
    const entries=formats.map(payload=>recallTranscriptEntry(payload,1000,9000));
    for(const entry of entries)expect(entry).toMatchObject({speaker:'Alex',text:'Ship Friday.',source:'recall',at:1000});
    expect(new Set(entries.map(e=>e?.id)).size).toBe(1);
  });
  it('uses absolute timestamps when present and tolerates missing speaker metadata',()=>{
    const entry=recallTranscriptEntry({transcript:{words:[{text:'Ready.',start_timestamp:{absolute:'2026-10-28T10:00:00Z',relative:2}}]}},1000);
    expect(entry).toMatchObject({speaker:'Participant',at:Date.parse('2026-10-28T10:00:00Z')});
    expect(recallTranscriptEntry({words:[{text:'Ready.'}]},1000,9000)?.at).toBe(9000);
  });
  it('ignores partial, empty, and malformed events without disrupting live audio',()=>{
    const invalid=[null,[],{}, {event:'transcript.partial_data',data:{data:sentence}}, {transcript:{...sentence,is_final:false}}, {words:'invalid'}, {words:[{}]}, {words:[]}, {words:[{text:'  '}]}];
    for(const payload of invalid)expect(recallTranscriptEntry(payload)).toBeUndefined();
  });
  it('does not merge long utterances sharing the same first 150 characters',()=>{
    const payload=(tail:string)=>({words:[{text:'word '.repeat(100)+tail,start_timestamp:{relative:5}}]});
    const a=recallTranscriptEntry(payload('Monday')),b=recallTranscriptEntry(payload('Friday'));
    expect(a?.id).not.toBe(b?.id);expect(a!.id.length).toBeLessThan(150);
    expect(recallTranscriptEntry(payload('Monday'))?.id).toBe(a?.id);
  });
});
