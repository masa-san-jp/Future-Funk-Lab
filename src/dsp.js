import { SoundTouch, SimpleFilter } from 'soundtouchjs';
import { Mp3Encoder } from '@breezystack/lamejs';
import { stereo, clamp } from './core.js';
function stretchSegment(channels, rate, tempo, semitones, outputLength=null) {
  const [left,right]=stereo(channels);
  if(tempo===1 && semitones===0) return [left.slice(),right.slice()];
  const length=outputLength??Math.max(1,Math.round(left.length/tempo));
  const output=[new Float32Array(length),new Float32Array(length)];
  const pipe=new SoundTouch();pipe.stretch.setParameters(rate,0,0,8);pipe.tempo=tempo;pipe.pitchSemitones=semitones;
  // Pad the source to flush SoundTouch's lookahead, including short samples.
  const source={extract(target,frames,position){
    for(let i=0;i<frames;i++){target[2*i]=left[position+i]||0;target[2*i+1]=right[position+i]||0;}
    return frames;
  }};
  const filter=new SimpleFilter(source,pipe), block=new Float32Array(8192);
  let offset=0;
  while(offset<length){const n=filter.extract(block,Math.min(4096,length-offset));if(!n)throw Error('音声変換に失敗しました');for(let i=0;i<n;i++){output[0][offset+i]=block[2*i];output[1][offset+i]=block[2*i+1];}offset+=n;}
  return output;
}
// Locate attacks in source frames. Stereo channels share the same time anchors.
export function detectOnsets(channels,rate){
  const [left,right]=stereo(channels),length=left.length,hop=128,window=256;
  const frames=Math.ceil(length/hop),flux=new Float64Array(frames);let previous=0,maximum=0;
  for(let i=0;i<frames;i++){
    let energy=0;
    for(let j=i*hop;j<Math.min(length,i*hop+window);j++)energy+=(left[j]*left[j]+right[j]*right[j])*.5;
    const value=Math.sqrt(energy/window);flux[i]=Math.max(0,value-previous);previous=value;maximum=Math.max(maximum,flux[i]);
  }
  const result=[];let last=-Infinity;
  for(let i=0;i<frames;i++){
    let mean=0;for(let j=Math.max(0,i-12);j<i;j++)mean+=flux[j];mean/=Math.min(12,i)||1;
    if(flux[i]<Math.max(.002,maximum*.12,mean*2.5)||flux[i]<(flux[i-1]||0)||flux[i]<(flux[i+1]||0))continue;
    const start=Math.max(0,(i-1)*hop),end=Math.min(length,(i+1)*hop+window);let difference=0;
    for(let j=start;j<end;j++)difference=Math.max(difference,Math.abs(left[j]-(left[j-1]||0)),Math.abs(right[j]-(right[j-1]||0)));
    let position=start;
    for(let j=start;j<end;j++)if(Math.max(Math.abs(left[j]-(left[j-1]||0)),Math.abs(right[j]-(right[j-1]||0)))>=difference*.35){position=j;break;}
    if(position-last>rate*.06){result.push(position);last=position;}
  }
  return result;
}
export function transform(channels,rate,tempo=1,semitones=0){
  const source=stereo(channels);
  if(tempo===1&&semitones===0)return source.map(c=>c.slice());
  const attacks=detectOnsets(source,rate);
  if(attacks.length<2)return stretchSegment(source,rate,tempo,semitones);
  const length=Math.max(1,Math.round(source[0].length/tempo)),output=[new Float32Array(length),new Float32Array(length)];
  const anchors=[0,...attacks.filter(i=>i>0),source[0].length],attackSet=new Set(attacks),pitchRatio=2**(semitones/12);
  for(let i=0;i<anchors.length-1;i++){
    const start=anchors[i],end=anchors[i+1],outStart=Math.round(start/tempo),outEnd=Math.round(end/tempo),outLength=outEnd-outStart;
    if(outLength<=0)continue;
    const segment=source.map(c=>c.subarray(start,end));
    const processed=stretchSegment(segment,rate,tempo,semitones,outLength);
    if(attackSet.has(start)){
      // Keep the attack at its exact mapped frame. Change pitch locally without
      // stretching the attack, then crossfade into the time-stretched body.
      const patch=Math.min(outLength,Math.floor(rate*.025),Math.floor((end-start)/pitchRatio));
      const fade=Math.min(Math.floor(rate*.008),Math.floor(patch/2));
      for(let j=0;j<patch;j++){
        const position=j*pitchRatio,a=Math.floor(position),fraction=position-a;
        const weight=fade>1&&j>=patch-fade?(patch-1-j)/(fade-1):1;
        for(let c=0;c<2;c++){
          const attack=(segment[c][a]||0)*(1-fraction)+(segment[c][a+1]||0)*fraction;
          processed[c][j]=attack*weight+processed[c][j]*(1-weight);
        }
      }
    }
    for(let c=0;c<2;c++)output[c].set(processed[c],outStart);
  }
  return output;
}
export function encodeMp3(channels,rate) {
  const encoder=new Mp3Encoder(channels.length,rate,192), chunks=[];
  const pcm=channels.map(c=>Int16Array.from(c,x=>Math.round(clamp(x,-1,1)*(x<0?32768:32767))));
  for(let i=0;i<pcm[0].length;i+=1152){const bytes=encoder.encodeBuffer(pcm[0].subarray(i,i+1152),pcm[1]?.subarray(i,i+1152));if(bytes.length)chunks.push(bytes.slice());}
  const end=encoder.flush();if(end.length)chunks.push(end.slice());
  const result=new Uint8Array(chunks.reduce((n,b)=>n+b.length,0));let offset=0;for(const c of chunks){result.set(c,offset);offset+=c.length;}return result;
}
