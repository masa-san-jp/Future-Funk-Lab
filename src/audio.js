import { dbGain, patternSeconds, stepSeconds, fadeEdges } from './core.js';
export function audioBuffer(context, channels, rate) {
  const buffer=context.createBuffer(channels.length,channels[0].length,rate);
  channels.forEach((c,i)=>buffer.copyToChannel(c,i));return buffer;
}
function filter(context, type, frequency, slope, q) {
  const input=context.createGain(), output=context.createGain(), nodes=[input,output];
  if(slope===6){
    const k=Math.tan(Math.PI*frequency/context.sampleRate), n=1/(1+k);
    const b=type==='lowpass'?[k*n,k*n]:[n,-n];
    const node=context.createIIRFilter(b,[1,(k-1)*n]);nodes.push(node);input.connect(node);node.connect(output);
  } else {
    let prior=input;
    for(let i=0;i<(slope===24?2:1);i++){
      const node=context.createBiquadFilter();node.type=type;node.frequency.value=frequency;node.Q.value=20*Math.log10(q ?? Math.SQRT1_2);nodes.push(node);prior.connect(node);prior=node;
    }
    prior.connect(output);
  }
  return {input,output,nodes};
}
function crossover(context,input,frequency,slope,nodes){
  const q=slope===12?0.5:Math.SQRT1_2;
  const low=filter(context,'lowpass',frequency,slope,q), high=filter(context,'highpass',frequency,slope,q);
  nodes.push(...low.nodes,...high.nodes);input.connect(low.input);input.connect(high.input);
  if(slope===12){const invert=context.createGain();invert.gain.value=-1;high.output.connect(invert);nodes.push(invert);return {low:low.output,high:invert};}
  return {low:low.output,high:high.output};
}
export function makeTrackGraph(context,track,settings,destination){
  const input=context.createGain(), output=context.createGain(), nodes=[input,output];
  const first=crossover(context,input,settings.low,settings.slope,nodes);
  const upper=crossover(context,first.high,settings.high,settings.slope,nodes);
  // Match the phase rotation of the second crossover on the low band.
  const compensation=crossover(context,first.low,settings.high,settings.slope,nodes);
  const low=context.createGain();compensation.low.connect(low);compensation.high.connect(low);nodes.push(low);
  const bands=[low,upper.low,upper.high].map((source,i)=>{const gain=context.createGain();gain.gain.value=dbGain(track.eq[i]);source.connect(gain);gain.connect(output);nodes.push(gain);return gain;});
  output.gain.value=dbGain(track.volume);output.connect(destination);
  return {input,output,bands,nodes,dispose(){nodes.forEach(n=>n.disconnect());}};
}
export function makePartGraph(context,part,destination){
  const input=context.createGain(),nodes=[input];let last=input;
  for(const [type,setting] of [['highpass',part.hp],['lowpass',part.lp]])if(setting.on){const f=filter(context,type,setting.freq,setting.slope);last.connect(f.input);last=f.output;nodes.push(...f.nodes);}
  last.connect(destination);return {input,nodes,dispose(){nodes.forEach(n=>n.disconnect());}};
}
export function activeTrack(track,tracks,count){return track.index<count && !track.mute && (!tracks.some(t=>t.index<count&&t.solo)||track.solo);}
// Build one periodic signal. Tails crossing the bar line belong at its beginning.
// Clip duration is independent of the eighth-note trigger grid.
export function patternTrack(context,buffer,track,bpm,steps,{loop=true}={}){
  const rate=context.sampleRate,period=Math.round(patternSeconds(bpm,steps)*rate),available=Math.round(buffer.duration*rate);
  const triggers=[];for(let i=0;i<steps;i++)if(track.steps[i])triggers.push(Math.round(i*period/steps));
  const length=loop?period:Math.max(period,(triggers.at(-1)??-available)+available);
  const channels=Array.from({length:buffer.numberOfChannels},()=>new Float32Array(length));
  for(let j=0;j<triggers.length;j++){
    const start=triggers[j],next=triggers[j+1]??(loop?triggers[0]+period:Infinity);
    const n=track.mode==='cut'?Math.min(available,next-start):available;
    for(let c=0;c<channels.length;c++){
      const input=buffer.getChannelData(c),output=channels[c];
      for(let k=0;k<n;k++){
        const source=k*buffer.sampleRate/rate,a=Math.floor(source),fraction=source-a;
        const value=(input[a]||0)*(1-fraction)+(input[a+1]||0)*fraction;
        const fade=track.mode==='cut'&&n<available?Math.min(1,(n-1-k)/Math.max(1,Math.round(.005*rate))):1;
        output[loop?(start+k)%period:start+k]+=value*fade;
      }
    }
  }
  return audioBuffer(context,channels,rate);
}
export class AudioEngine {
  constructor(onStep,onFinish){this.onStep=onStep;this.onFinish=onFinish;this.voices=new Set();this.preview=new Map();this.masterDb=0;this.stopVersion=0;this.playing=false;this.position=0;this.clip=[false,false];this.peak=[-Infinity,-Infinity];}
  async init(){
    if(!this.context){
      const AudioContext=window.AudioContext||window.webkitAudioContext;
      if(!AudioContext)throw Error('このブラウザはWeb Audio APIに対応していません');
      this.context=new AudioContext({sampleRate:44100});
      this.master=this.context.createGain();this.master.gain.value=dbGain(this.masterDb);
      this.split=this.context.createChannelSplitter(2);this.master.connect(this.split);this.master.connect(this.context.destination);
      this.analysers=[0,1].map(i=>{const a=this.context.createAnalyser();a.fftSize=1024;this.split.connect(a,i);return a;});
      this.meterData=new Float32Array(1024);
    }
    await this.context.resume();return this.context;
  }
  configure(tracks,settings,buffers,count){
    this.tracks=tracks;this.settings=settings;this.buffers=buffers;this.count=count;
    if(!this.context)return;
    if(!this.graphs){this.graphs=tracks.map(t=>makeTrackGraph(this.context,t,settings,this.master));}
    this.updateGains();
  }
  rebuildEQ(){if(!this.graphs)return;const old=this.graphs;this.graphs=this.tracks.map(t=>makeTrackGraph(this.context,t,this.settings,this.master));for(const v of this.voices)if(v.track!=null){v.gain.disconnect();v.gain.connect(this.graphs[v.track].input);}old.forEach(g=>g.dispose());this.updateGains();}
  updateGains(){this.graphs?.forEach((g,i)=>{const t=this.tracks[i];g.output.gain.setTargetAtTime(activeTrack(t,this.tracks,this.count)?dbGain(t.volume):0,this.context.currentTime,0.008);g.bands.forEach((b,k)=>b.gain.setTargetAtTime(dbGain(t.eq[k]),this.context.currentTime,0.008));});}
  setMaster(db){this.masterDb=db;this.master?.gain.setTargetAtTime(dbGain(db),this.context.currentTime,0.008);}
  stopVoice(v,when=this.context.currentTime){if(v.stopped)return;v.stopped=true;v.gain.gain.cancelScheduledValues(when);v.gain.gain.setValueAtTime(1,when);v.gain.gain.linearRampToValueAtTime(0,when+0.005);try{v.source.stop(when+0.006);}catch{} }
  playBuffer(buffer,destination,{when=this.context.currentTime,offset=0,loop=false,key=null,track=null,origin=when-offset}={}){
    const source=this.context.createBufferSource(),gain=this.context.createGain();source.buffer=buffer;source.loop=loop;source.connect(gain);gain.connect(destination);
    const duration=buffer.duration;offset=loop?offset%duration:Math.min(offset,duration);
    const v={source,gain,key,track,when,origin,offset,loop,buffer,stopped:false};this.voices.add(v);
    source.onended=()=>{source.disconnect();gain.disconnect();this.voices.delete(v);if(key&&this.preview.get(key)===v){this.preview.delete(key);this.onFinish?.(key);}};
    source.start(Math.max(when,this.context.currentTime),offset);if(key)this.preview.set(key,v);return v;
  }
  stopPreview(key){const voice=this.preview.get(key);if(voice)this.stopVoice(voice);this.preview.delete(key);this.onFinish?.(key);}
  stopPreviews(){for(const key of [...this.preview.keys()])this.stopPreview(key);}
  async playPreview(key,buffer,destination,loop=false,offset=0,track=null){const stopped=this.stopVersion;await this.init();if(stopped!==this.stopVersion)return null;this.stopPreview(key);return this.playBuffer(buffer,destination||this.master,{key,loop,offset,track});}
  replaceTrackBuffer(index,buffer){
    this.buffers[index]=buffer;
    if(this.playing)this.refreshPatternTrack(index);
    for(const voice of [...this.voices])if(voice.track===index&&!voice.stopped&&!voice.pattern){
      const now=this.context.currentTime;
      if(voice.when>now){this.stopVoice(voice);this.playBuffer(buffer,this.graphs[index].input,{when:voice.when,loop:voice.loop,key:voice.key,track:index,origin:voice.origin});continue;}
      const offset=now-voice.origin;
      this.stopVoice(voice);
      if(voice.loop||offset<buffer.duration)this.playBuffer(buffer,this.graphs[index].input,{offset,loop:voice.loop,key:voice.key,track:index,origin:voice.origin});
    }
  }
  refreshPatternTrack(index,prepared=null){
    if(!this.playing||!this.buffers[index]||index>=this.count)return;
    const buffer=prepared||patternTrack(this.context,this.buffers[index],this.tracks[index],this.bpm,this.steps,{loop:this.loop});
    const when=Math.max(this.started,this.context.currentTime),elapsed=Math.max(0,when-this.started),offset=this.loop?elapsed%this.period:elapsed;
    for(const v of this.voices)if(v.pattern&&v.track===index&&!v.stopped){v.stopped=true;v.source.stop(when);}
    if(offset>=buffer.duration)return;
    const voice=this.playBuffer(buffer,this.graphs[index].input,{when,offset,loop:this.loop,track:index,origin:this.started});
    voice.pattern=true;
  }
  start(bpm,steps,loop){
    this.stop(false);this.bpm=bpm;this.steps=steps;this.loop=loop;this.playing=true;
    this.period=Math.round(patternSeconds(bpm,steps)*this.context.sampleRate)/this.context.sampleRate;
    const prepared=Array.from({length:this.count},(_,i)=>this.buffers[i]?patternTrack(this.context,this.buffers[i],this.tracks[i],bpm,steps,{loop}):null);
    this.started=this.context.currentTime+.05-this.position;
    for(let i=0;i<this.count;i++)if(prepared[i])this.refreshPatternTrack(i,prepared[i]);
    this.schedule();this.timer=setInterval(()=>this.schedule(),20);
  }
  schedule(){
    if(!this.playing)return;
    const elapsed=Math.max(0,this.context.currentTime-this.started),end=this.period;
    // This timer only paints the transport; native audio loops never depend on it.
    this.position=this.loop?elapsed%end:Math.min(elapsed,end);
    this.onStep?.(Math.min(this.steps-1,Math.floor(this.position*this.steps/end)),this.position);
    if(!this.loop&&elapsed>=end){this.playing=false;clearInterval(this.timer);this.position=0;this.onStep?.(-1,0);this.onFinish?.('sequence');}
  }
  setLoop(loop){
    if(this.loop===loop)return;this.loop=loop;
    if(!this.playing)return;
    // Keep the current bar phase when changing the type of prepared signal.
    const elapsed=Math.max(0,this.context.currentTime-this.started);
    this.started+=Math.floor(elapsed/this.period)*this.period;
    for(let i=0;i<this.count;i++)this.refreshPatternTrack(i);
  }
  stop(reset=true){this.stopVersion++;clearInterval(this.timer);this.playing=false;for(const v of this.voices)if(!v.key)this.stopVoice(v);if(reset)this.position=0;this.onStep?.(-1,this.position);}
  stopAll(){this.stop();this.stopPreviews();}
  meter(){if(!this.analysers)return [-Infinity,-Infinity];return this.analysers.map((a,i)=>{a.getFloatTimeDomainData(this.meterData);let max=0;for(const x of this.meterData)max=Math.max(max,Math.abs(x));const db=max>0?20*Math.log10(max):-Infinity;this.peak[i]=Math.max(this.peak[i],db);if(db>0)this.clip[i]=true;return db;});}
}
export async function renderPattern({tracks,buffers,count,settings,bpm,steps,masterDb,rate=44100,loop=true}){
  const length=Math.round(patternSeconds(bpm,steps)*rate);
  // Warm the crossover filters with preceding cycles, then export a complete cycle.
  const context=new OfflineAudioContext(2,length*(loop?3:1),rate);
  const master=context.createGain();master.gain.value=dbGain(masterDb);master.connect(context.destination);
  tracks.forEach((track,i)=>{
    if(!buffers[i]||!activeTrack(track,tracks,count))return;
    const graph=makeTrackGraph(context,track,settings,master),source=context.createBufferSource();
    source.buffer=patternTrack(context,buffers[i],track,bpm,steps,{loop});source.loop=loop;source.connect(graph.input);source.start();
  });
  const result=await context.startRendering(),channels=[0,1].map(c=>result.getChannelData(c).slice(loop?length*2:0,loop?length*3:length));
  return loop?channels:fadeEdges(channels,rate);
}
export async function renderPart(channels,rate,part){
  const context=new OfflineAudioContext(2,channels[0].length,rate),graph=makePartGraph(context,part,context.destination);
  const source=context.createBufferSource();source.buffer=audioBuffer(context,channels,rate);source.connect(graph.input);source.start();
  const buffer=await context.startRendering();return fadeEdges([buffer.getChannelData(0).slice(),buffer.getChannelData(1).slice()],rate);
}
