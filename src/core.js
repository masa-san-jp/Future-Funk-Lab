export const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
export const stepSeconds = bpm => 30 / bpm;
export const patternSeconds = (bpm, steps) => stepSeconds(bpm) * steps;
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
  return { index, steps:Array(32).fill(false), pitch:0, cents:0, eq:[0,0,0], volume:0, mute:false, solo:false, mode:'overlap', previewLoop:false, sync:'auto', syncSteps:4 };
}
// A clip spans a musical interval, not necessarily one sequencer step.
// Repeated notes establish that track's shortest interval. A single note uses
// the next occupied position across the arrangement, including the bar line.
export function trackSpanSteps(tracks,index,count,steps){
  const track=tracks[index];
  if(!track||index>=count||track.sync==='original')return null;
  if(track.sync==='fixed')return track.syncSteps;
  const own=[];for(let s=0;s<steps;s++)if(track.steps[s])own.push(s);
  if(!own.length)return null;
  if(own.length>1)return Math.min(...own.map((s,i)=>(own[(i+1)%own.length]-s+steps)%steps||steps));
  let distance=steps;
  for(let i=0;i<count;i++)for(let s=0;s<steps;s++)if(tracks[i]?.steps[s])distance=Math.min(distance,(s-own[0]+steps)%steps||steps);
  return distance;
}
export function syncedFrames(bpm,steps,span,rate){
  return span==null?null:Math.max(1,Math.round(Math.round(patternSeconds(bpm,steps)*rate)*span/steps));
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
