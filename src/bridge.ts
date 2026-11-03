import type { BridgeCommand, Meeting, TranscriptEntry, Intervention } from '../shared/types';
import { assessmentTool, moderatorInstructions } from '../shared/prompt';
import { recallTranscriptEntry } from '../shared/recall-transcript';

export class MeetingBridge {
  private socket?: WebSocket;
  private pc?: RTCPeerConnection;
  private dc?: RTCDataChannel;
  private mic?: MediaStream;
  private audio = new Audio();
  private recallTranscript?: WebSocket;
  private meeting?: Meeting;
  private revision = 0;
  private humanSpeaking = false;
  private responseActive = false;
  private pendingAnalysis = false;
  private pendingSpeech?: Intervention;
  private speakingId?: string;
  private spokenText = '';
  private wasAudible = false;
  private closed = false;
  private renewTimer?: ReturnType<typeof setTimeout>;
  private transcriptRetry?: ReturnType<typeof setTimeout>;
  private drainTimer?: ReturnType<typeof setTimeout>;
  private resolveMeeting?: () => void;
  constructor(private sessionId:string,private token:string,private rehearsal:boolean,private status:(text:string)=>void,private onRemoteAudio?:(stream:MediaStream)=>void,private onEnd?:()=>void) { this.audio.autoplay=true; }
  private send(data:unknown) { if(this.socket?.readyState===WebSocket.OPEN)this.socket.send(JSON.stringify(data)); }
  private event(data:unknown) { if(this.dc?.readyState==='open')this.dc.send(JSON.stringify(data)); }
  async start(stream?:MediaStream) {
    this.closed=false;this.status('Connecting to the meeting controller…');
    const ready=new Promise<void>(resolve=>{this.resolveMeeting=resolve;});
    this.socket=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/socket`);
    this.socket.onopen=()=>this.send({type:'auth',role:'bridge',sessionId:this.sessionId,token:this.token});
    this.socket.onmessage=e=>this.command(JSON.parse(e.data));
    this.socket.onclose=()=>{if(!this.closed){this.status('Controller disconnected. Audio stopped. Reconnect to continue.');this.shutdown();}};
    await Promise.race([ready,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Controller connection timed out.')),10_000))]);
    this.status('Opening the live audio connection…');
    this.mic=stream||await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:this.rehearsal,noiseSuppression:this.rehearsal,autoGainControl:this.rehearsal}});
    if(this.closed){this.mic.getTracks().forEach(t=>t.stop());throw new Error('The meeting ended while audio was connecting.');}
    await this.connectRtc();
    if(!this.rehearsal)this.connectTranscript();
  }
  private async connectRtc() {
    this.pc=new RTCPeerConnection();
    this.pc.ontrack=e=>{if(this.closed)return;this.audio.srcObject=e.streams[0];this.onRemoteAudio?.(e.streams[0]);void this.audio.play().catch(()=>this.status('Click Enable audio to hear Quicken.'));};
    this.pc.onconnectionstatechange=()=>{
      if(this.pc?.connectionState==='failed'&&!this.closed){this.report('Audio connection failed. Reconnect the bridge.');this.stopSpeaking();}
    };
    for(const track of this.mic!.getTracks())this.pc.addTrack(track,this.mic!);
    this.dc=this.pc.createDataChannel('oai-events');
    this.dc.onmessage=e=>this.handle(JSON.parse(e.data));
    this.dc.onopen=()=>{if(!this.closed){this.send({type:'ready'});this.status('Listening · direct live audio');}};
    const offer=await this.pc.createOffer();await this.pc.setLocalDescription(offer);
    const response=await fetch(`/api/bridge/${this.sessionId}/session`,{method:'POST',headers:{'Content-Type':'application/sdp','x-bridge-token':this.token},body:offer.sdp});
    if(!response.ok){const e=await response.json().catch(()=>({error:'Could not connect to the voice model.'}));throw new Error(e.error);}
    await this.pc.setRemoteDescription({type:'answer',sdp:await response.text()});
    // Realtime sessions last at most 60 minutes. Renew with the latest durable meeting state.
    this.renewTimer=setTimeout(()=>void this.renew(),55*60_000);
  }
  private async renew() {
    if(this.closed)return;
    if(this.humanSpeaking||this.speakingId){this.renewTimer=setTimeout(()=>void this.renew(),5000);return;}
    this.status('Refreshing the audio session…');this.dc?.close();this.pc?.close();this.responseActive=false;
    try{await this.connectRtc();}catch(e){this.report(e instanceof Error?e.message:'Could not renew the audio session.');}
  }
  private command(command:BridgeCommand|{type:'revision';revision:number}|{type:'error';message:string}) {
    if(command.type==='state'){
      this.meeting=command.meeting;this.resolveMeeting?.();this.resolveMeeting=undefined;
      if(!this.closed)this.event({type:'session.update',session:{type:'realtime',instructions:moderatorInstructions(command.meeting)}});
      if(command.meeting.paused)this.stopSpeaking();
    }else if(command.type==='revision')this.revision=command.revision;
    else if(command.type==='stop')this.stopSpeaking();
    else if(command.type==='end')this.finishTranscript(command.drainMs);
    else if(command.type==='speak'){
      if(this.humanSpeaking||this.meeting?.paused||this.closed)return;
      if(this.responseActive)this.pendingSpeech=command.intervention;
      else this.speak(command.intervention);
    }else if(command.type==='error')this.report(command.message);
  }
  private speak(intervention: Intervention) {
    this.pendingSpeech=undefined;this.speakingId=intervention.id;this.spokenText='';this.wasAudible=false;this.responseActive=true;
    this.event({type:'response.create',response:{output_modalities:['audio'],tools:[],tool_choice:'none',max_output_tokens:250,metadata:{kind:'speech',intervention_id:this.speakingId},instructions:`Read only this approved moderator sentence, exactly as written, with a calm natural voice. No preamble or additional commentary: ${JSON.stringify(intervention.text)}`}});
  }
  private assess() {
    if(!this.meeting||this.humanSpeaking||this.closed||this.meeting.status==='ended')return;
    if(this.responseActive){this.pendingAnalysis=true;return;}
    this.pendingAnalysis=false;this.responseActive=true;
    this.event({type:'response.create',response:{output_modalities:['text'],tools:[assessmentTool],tool_choice:{type:'function',name:'assess_meeting'},max_output_tokens:1000,metadata:{kind:'assessment',revision:String(this.revision)},instructions:moderatorInstructions(this.meeting)+'\nAssess the most recent conversation now. Call assess_meeting; never produce speech during assessment.'}});
  }
  private handle(e:any) {
    // During shutdown, accept final words but never start another assessment or
    // voice response, including responses already in flight when End was clicked.
    if(this.closed&&e.type!=='conversation.item.input_audio_transcription.completed')return;
    if(e.type==='input_audio_buffer.speech_started'){
      this.humanSpeaking=true;this.revision++;this.pendingAnalysis=false;
      this.stopSpeaking();this.send({type:'speech',started:true});this.status('Listening…');
    }else if(e.type==='input_audio_buffer.speech_stopped'){
      this.humanSpeaking=false;this.send({type:'speech',started:false});
    }else if(e.type==='input_audio_buffer.committed')this.assess();
    else if(e.type==='conversation.item.input_audio_transcription.completed'&&this.rehearsal){
      this.transcript({id:e.item_id,text:e.transcript,speaker:this.meeting?.mode==='local'?'Participant':'You',source:'realtime',at:Date.now()});
    }else if(e.type==='output_audio_buffer.started'&&this.speakingId){
      this.wasAudible=true;
      this.send({type:'playback',id:this.speakingId,phase:'started'});this.status('Quicken is speaking');
    }else if(e.type==='output_audio_buffer.stopped'&&this.speakingId){
      if(this.wasAudible&&this.spokenText)this.transcript({id:`moderator-${this.speakingId}`,text:this.spokenText,speaker:'Quicken',source:'moderator',at:Date.now()});
      this.send({type:'playback',id:this.speakingId,phase:'finished'});this.speakingId=undefined;this.status('Listening · direct live audio');
    }else if(e.type==='response.output_audio_transcript.done'){
      this.spokenText=e.transcript;
    }else if(e.type==='response.done'){
      this.responseActive=false;
      if(e.response?.status==='completed'&&e.response?.metadata?.kind==='assessment'){
        for(const item of e.response.output||[]){
          if(item.type==='function_call'&&item.name==='assess_meeting'){
            try{const assessment=JSON.parse(item.arguments);this.send({type:'assessment',assessment,revision:Number(e.response.metadata.revision)});this.event({type:'conversation.item.create',item:{type:'function_call_output',call_id:item.call_id,output:'Assessment received. The application controls whether and when to speak. Wait for its next response request.'}});}
            catch{this.report('Could not read a moderator assessment. Listening continues.');}
          }
        }
      }else if(e.response?.status==='failed')this.report(`Voice response failed: ${e.response.status_details?.error?.message||'unknown provider error'}`);
      if(this.pendingSpeech&&!this.humanSpeaking&&!this.meeting?.paused)this.speak(this.pendingSpeech);
      else if(this.pendingAnalysis&&!this.humanSpeaking)this.assess();
    }else if(e.type==='error'){
      if(!['response_cancel_not_active','output_audio_buffer_clear_empty'].includes(e.error?.code))this.report(e.error?.message||'Voice service error');
    }
  }
  private connectTranscript() {
    if(this.closed)return;
    this.recallTranscript=new WebSocket('wss://meeting-data.bot.recall.ai/api/v1/transcript');
    this.recallTranscript.onmessage=e=>{
      try{
        const entry=recallTranscriptEntry(JSON.parse(e.data),this.meeting?.startedAt);
        if(entry)this.transcript(entry);
      }catch{this.report('A transcript event could not be read. Live audio is still connected.');}
    };
    this.recallTranscript.onclose=()=>{if(!this.closed)this.transcriptRetry=setTimeout(()=>this.connectTranscript(),3000);};
  }
  private transcript(entry:TranscriptEntry){entry.id=entry.id.slice(0,150);this.send({type:'transcript',entry});}
  private report(message:string){this.status(message);this.send({type:'error',message:message.slice(0,500)});}
  stopSpeaking(){
    this.pendingSpeech=undefined;
    if(this.responseActive)this.event({type:'response.cancel'});
    if(this.speakingId){
      this.event({type:'output_audio_buffer.clear'});
      if(this.wasAudible)this.transcript({id:`moderator-${this.speakingId}`,text:'[Quicken began an intervention and was interrupted.]',speaker:'Quicken',source:'moderator',at:Date.now()});
    }
    this.wasAudible=false;this.spokenText='';
    this.speakingId=undefined;
  }
  enableAudio(){return this.audio.play();}
  private finishTranscript(drainMs:number){
    if(this.closed)return;
    this.closed=true;this.status('Finishing the transcript…');this.stopSpeaking();this.audio.pause();
    clearTimeout(this.renewTimer);clearTimeout(this.transcriptRetry);
    // Muted tracks send silence, allowing VAD to finalize a sentence that was
    // still being spoken at End. Keep the data channel open for the result.
    this.mic?.getTracks().forEach(t=>{t.enabled=false;});
    this.drainTimer=setTimeout(()=>{
      this.send({type:'drained'});this.status('Meeting ended. Your transcript has been saved.');this.shutdown();
    },Math.max(0,Math.min(drainMs,4000)));
  }
  shutdown(){
    this.closed=true;this.onEnd?.();clearTimeout(this.renewTimer);clearTimeout(this.transcriptRetry);clearTimeout(this.drainTimer);
    this.stopSpeaking();this.dc?.close();this.pc?.close();this.mic?.getTracks().forEach(t=>t.stop());
    this.audio.pause();this.audio.srcObject=null;this.recallTranscript?.close();this.socket?.close();
  }
}
