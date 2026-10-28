export const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
// Steps are stored as sixteenth-note ticks; the grid only sets which ticks are editable.
export const TICKS = 64, RESOLUTIONS = [8, 16], PATTERN_TICKS = [8, 16, 32, 64];
export const tickSeconds = bpm => 15 / bpm;
export const ticksPerStep = resolution => 16 / resolution;
export const gridSeconds = (bpm, resolution = 8) => tickSeconds(bpm) * ticksPerStep(resolution);
export const patternSeconds = (bpm, lengthTicks) => tickSeconds(bpm) * lengthTicks;
export const displaySteps = (lengthTicks, resolution) => lengthTicks / ticksPerStep(resolution);
// Trigger frames shared by playback and export. Swing delays every odd step of
// the current grid: the off-beat of a two-step pair sits at swing% of the pair.
export function triggerFrames(track,{lengthTicks,resolution=8,swing=50},period){
  const unit=ticksPerStep(resolution),frames=[];
  for(let t=0;t<lengthTicks;t+=unit)if(track.steps[t]){
    const offbeat=(t/unit)%2===1,position=offbeat?t-unit+2*unit*swing/100:t;
    frames.push(Math.round(position*period/lengthTicks));
  }
  return frames;
}
// Odd ticks cannot be shown on an eighth-note grid; count them before switching.
export const offbeatTicks = tracks => tracks.reduce((n,t)=>n+t.steps.filter((on,i)=>on&&i%2).length,0);
export function sourceBpmFromLoop(originalDuration,range,quarterBeats){
  const length=originalDuration*(range[1]-range[0]);
  if(!(length>0)||!Number.isFinite(quarterBeats)||quarterBeats<=0)throw Error('範囲と拍数を指定してください');
  const bpm=60*quarterBeats/length;
  if(bpm<30||bpm>300)throw Error('この範囲と拍数では原曲BPMが30〜300の範囲外になります。拍数・範囲を確認してください');
  return Number(bpm.toFixed(3));
}
export const dbGain = db => db === -Infinity ? 0 : 10 ** (db / 20);
export const sliderDb = value => Number(value) <= -60 ? -Infinity : Number(value);
export const formatDb = value => value === -Infinity ? '−∞' : `${value > 0 ? '+' : ''}${Number(value).toFixed(1)}`;
export const formatTime = n => `${Math.floor(Math.max(0,n) / 60)}:${(Math.max(0,n)%60).toFixed(3).padStart(6,'0')}`;
export function makeTrack(index) {
  return { index, steps:Array(TICKS).fill(false), pitch:0, cents:0, eq:[0,0,0], volume:0, mute:false, solo:false, mode:'overlap', previewLoop:false, sync:'auto', syncSteps:4 };
}
// A clip spans a musical interval, not necessarily one sequencer step.
// Repeated notes establish that track's shortest interval. A single note uses
// the next occupied position across the arrangement, including the bar line.
// Spans are in ticks and ignore swing; syncSteps stays in eighth notes.
export function trackSpanTicks(tracks,index,count,steps){
  const track=tracks[index];
  if(!track||index>=count||track.sync==='original')return null;
  if(track.sync==='fixed')return track.syncSteps*2;
  const own=[];for(let s=0;s<steps;s++)if(track.steps[s])own.push(s);
  if(!own.length)return null;
  if(own.length>1)return Math.min(...own.map((s,i)=>(own[(i+1)%own.length]-s+steps)%steps||steps));
  let distance=steps;
  for(let i=0;i<count;i++)for(let s=0;s<steps;s++)if(tracks[i]?.steps[s])distance=Math.min(distance,(s-own[0]+steps)%steps||steps);
  return distance;
}
export function syncedFrames(bpm,lengthTicks,span,rate){
  return span==null?null:Math.max(1,Math.round(Math.round(patternSeconds(bpm,lengthTicks)*rate)*span/lengthTicks));
}
export function boundaries(start, end, count) {
  return Array.from({length:count+1}, (_,i)=> start+(end-start)*i/count);
}
// Quantize interior cuts to the sampled range's beat origin; preserve both ends.
export function quantizeBoundaries(points, grid, minimum=.001){
  const result=[...points],origin=points[0];
  for(let i=1;i<result.length-1;i++)result[i]=snapBoundary(result[i],i,result,grid,origin,minimum);
  return result;
}
export function snapBoundary(value, index, points, grid=0, origin=0, min=0.001) {
  const lower = points[index-1]+min, upper = points[index+1]-min;
  if (lower > upper) return points[index];
  if (!grid) return clamp(value, lower, upper);
  const first = Math.ceil((lower-origin)/grid), last = Math.floor((upper-origin)/grid);
  if(first>last) return points[index];
  return origin+clamp(Math.round((value-origin)/grid),first,last)*grid;
}
export function stereo(channels) {
  return [channels[0], channels[1] || channels[0]];
}
export function midChannels(channels) {
  const [l,r]=stereo(channels), mid=new Float32Array(l.length);
  for(let i=0;i<mid.length;i++) mid[i]=(l[i]+r[i])*0.5;
  return [mid,mid.slice()];
}
export function monoChannels(channels) { return [midChannels(channels)[0]]; }
export function sliceChannels(channels,start,end,rate) {
  const a=Math.round(start*rate), b=Math.round(end*rate);
  return stereo(channels).map(c=>c.slice(a,b));
}
export function fadeEdges(channels,rate,ms=5) {
  const length=channels[0].length, fade=Math.min(Math.round(rate*ms/1000),Math.floor(length/2));
  for(const c of channels) for(let i=0;i<fade;i++) {const g=i/fade;c[i]*=g;c[length-1-i]*=g;}
  return channels;
}
export function encodeWav(channels,rate) {
  const count=channels.length, length=channels[0].length, data=new ArrayBuffer(44+length*count*2), v=new DataView(data);
  const text=(offset,s)=>[...s].forEach((c,i)=>v.setUint8(offset+i,c.charCodeAt(0)));
  text(0,'RIFF');v.setUint32(4,36+length*count*2,true);text(8,'WAVE');text(12,'fmt ');
  v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,count,true);v.setUint32(24,rate,true);
  v.setUint32(28,rate*count*2,true);v.setUint16(32,count*2,true);v.setUint16(34,16,true);text(36,'data');v.setUint32(40,length*count*2,true);
  let offset=44;
  for(let i=0;i<length;i++)for(let c=0;c<count;c++){let x=clamp(channels[c][i]||0,-1,1);v.setInt16(offset,Math.round(x*(x<0?32768:32767)),true);offset+=2;}
  return data;
}
// Chrome cannot decode AIFF. Rewrites its PCM as a WAV with the same depth and rate, without
// converting values, so decodeAudioData resamples it the same way as a WAV. Null if not AIFF.
const AIFF_CODECS={NONE:'swap',twos:'swap',sowt:'copy',fl32:'float',FL32:'float',raw:'copy'};
export function aiffToWav(bytes){
  const text=(at,n=4)=>String.fromCharCode(...bytes.subarray(at,at+n));
  if(bytes.length<12||text(0)!=='FORM'||!['AIFF','AIFC'].includes(text(8)))return null;
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let comm=null,ssnd=null;
  for(let at=12;at+8<=bytes.length;){const id=text(at),size=v.getUint32(at+4);if(id==='COMM')comm={at:at+8,size};if(id==='SSND')ssnd={at:at+8,size};at+=8+size+(size&1);}
  if(!comm||!ssnd||comm.size<18)throw Error('AIFFのヘッダーが壊れています');
  const channels=v.getUint16(comm.at),frames=v.getUint32(comm.at+2),bits=v.getUint16(comm.at+6),exponent=v.getUint16(comm.at+8)&0x7fff;
  const rate=Math.round((v.getUint32(comm.at+10)*2**32+v.getUint32(comm.at+14))*2**(exponent-16383-63));
  const codec=text(8)==='AIFC'&&comm.size>=22?text(comm.at+18):'NONE',mode=AIFF_CODECS[codec];
  if(!mode)throw Error(`このAIFFの圧縮形式（${codec.trim()}）には対応していません`);
  // Samples below a byte boundary are stored left-justified, so whole bytes keep their scale.
  const width=Math.ceil(bits/8),float=mode==='float';
  if(!channels||!rate||!width||width>4||float&&bits!==32||mode==='copy'&&codec==='raw'&&width!==1)throw Error('AIFFのヘッダーが壊れています');
  const start=ssnd.at+8+v.getUint32(ssnd.at),length=frames*channels*width;
  if(start+length>bytes.length)throw Error('AIFFの音声データが途中で切れています');
  const out=new Uint8Array(44+length),w=new DataView(out.buffer),pcm=bytes.subarray(start,start+length);
  const put=(at,s)=>[...s].forEach((c,i)=>out[at+i]=c.charCodeAt(0));
  put(0,'RIFF');w.setUint32(4,36+length,true);put(8,'WAVE');put(12,'fmt ');w.setUint32(16,16,true);w.setUint16(20,float?3:1,true);w.setUint16(22,channels,true);
  w.setUint32(24,rate,true);w.setUint32(28,rate*channels*width,true);w.setUint16(32,channels*width,true);w.setUint16(34,width*8,true);put(36,'data');w.setUint32(40,length,true);
  if(mode==='copy'&&width>1||codec==='raw')out.set(pcm,44);
  else if(width===1)for(let i=0;i<length;i++)out[44+i]=pcm[i]^0x80; // AIFF 8-bit is signed, WAV 8-bit unsigned.
  else for(let i=0;i<length;i+=width)for(let b=0;b<width;b++)out[44+i+b]=pcm[i+width-1-b];
  return out;
}
const CRC_TABLE=Array.from({length:256},(_,n)=>{let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
export function crc32(bytes){let c=0xffffffff;for(const b of bytes)c=CRC_TABLE[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
// Uncompressed (STORE) ZIP. Audio barely compresses, and this avoids a dependency.
export function zipStore(files,date=new Date()){
  const time=(date.getHours()<<11)|(date.getMinutes()<<5)|(date.getSeconds()>>1),day=((date.getFullYear()-1980)<<9)|((date.getMonth()+1)<<5)|date.getDate();
  const entries=files.map(f=>({name:new TextEncoder().encode(f.name),data:f.data instanceof Uint8Array?f.data:new Uint8Array(f.data)})).map(e=>({...e,crc:crc32(e.data)}));
  const size=entries.reduce((n,e)=>n+30+e.name.length+e.data.length+46+e.name.length,22),out=new Uint8Array(size),v=new DataView(out.buffer);
  const common=(at,e)=>{v.setUint16(at,20,true);v.setUint16(at+2,0x800,true);v.setUint16(at+4,0,true);v.setUint16(at+6,time,true);v.setUint16(at+8,day,true);v.setUint32(at+10,e.crc,true);v.setUint32(at+14,e.data.length,true);v.setUint32(at+18,e.data.length,true);v.setUint16(at+22,e.name.length,true);v.setUint16(at+24,0,true);};
  let offset=0;
  for(const e of entries){e.offset=offset;v.setUint32(offset,0x04034b50,true);common(offset+4,e);out.set(e.name,offset+30);out.set(e.data,offset+30+e.name.length);offset+=30+e.name.length+e.data.length;}
  const directory=offset;
  for(const e of entries){v.setUint32(offset,0x02014b50,true);v.setUint16(offset+4,20,true);common(offset+6,e);v.setUint16(offset+32,0,true);v.setUint16(offset+34,0,true);v.setUint16(offset+36,0,true);v.setUint32(offset+38,0,true);v.setUint32(offset+42,e.offset,true);out.set(e.name,offset+46);offset+=46+e.name.length;}
  v.setUint32(offset,0x06054b50,true);v.setUint16(offset+8,entries.length,true);v.setUint16(offset+10,entries.length,true);v.setUint32(offset+12,offset-directory,true);v.setUint32(offset+16,directory,true);
  return out;
}
// Energy-onset autocorrelation; confidence exposes ambiguous/non-rhythmic sources.
export function detectBpm(channels,rate) {
  const signal=channels[0], hop=Math.max(1,Math.floor(rate/200)), frames=Math.min(Math.floor(signal.length/hop),12000);
  const envelope=new Float64Array(frames);let prev=0;
  for(let i=0;i<frames;i++){let energy=0;for(let j=0;j<hop;j++){const x=signal[i*hop+j];energy+=x*x;}energy=Math.sqrt(energy/hop);envelope[i]=Math.max(0,energy-prev);prev=energy;}
  const fps=rate/hop;let best=0,bpm=120, norm=0;
  for(const x of envelope)norm+=x*x;
  for(let b=60;b<=200;b++){const lag=Math.round(fps*60/b);let score=0;for(let i=lag;i<frames;i++)score+=envelope[i]*envelope[i-lag];score/=Math.max(1,frames-lag);if(score>best){best=score;bpm=b;}}
  const confidence=norm ? best*frames/norm : 0;
  return {bpm,confidence};
}
