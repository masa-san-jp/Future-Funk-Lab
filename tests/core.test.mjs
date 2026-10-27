import test from 'node:test';
import assert from 'node:assert/strict';
import { boundaries, snapBoundary, encodeWav, gridSeconds, patternSeconds, midChannels, detectBpm, triggerFrames, offbeatTicks, makeTrack } from '../src/core.js';
import { transform, encodeMp3 } from '../src/dsp.js';
const rate=44100;
const tone=(seconds=1,freq=440)=>Float32Array.from({length:Math.round(seconds*rate)},(_,i)=>.5*Math.sin(2*Math.PI*freq*i/rate));
function frequency(data){let crossings=0;const a=Math.floor(data.length*.25),b=Math.floor(data.length*.75);for(let i=a+1;i<b;i++)if(data[i-1]<=0&&data[i]>0)crossings++;return crossings*rate/(b-a);}
test('8分・16分グリッドと、16分単位のパターン長',()=>{assert.equal(gridSeconds(120),.25);assert.equal(gridSeconds(120,16),.125);assert.equal(patternSeconds(120,16),2);assert.equal(patternSeconds(120,32),4);assert.equal(patternSeconds(120,64),8);assert.equal(patternSeconds(60,8),2);});
test('境界は隣接区間を越えず、グリッドが収まらない場合は保持',()=>{assert.deepEqual(boundaries(2,6,4),[2,3,4,5,6]);assert.equal(snapBoundary(.49,1,[0,.4,1],.25),.5);assert.equal(snapBoundary(2,1,[0,.4,1]),.999);assert.equal(snapBoundary(.01,1,[0,.01,.02],.25),.01);});
test('Midは正規化し、同相L/Rで6dB増幅しない',()=>{assert.deepEqual([...midChannels([new Float32Array([1,-1]),new Float32Array([1,-1])])[0]],[1,-1]);assert.deepEqual([...midChannels([new Float32Array([1,-1]),new Float32Array([-1,1])])[0]],[0,0]);});
test('タイムストレッチは長さを変えピッチを維持',()=>{const input=tone(2);const output=transform([input,input],rate,1.5,0);assert.equal(output[0].length,Math.round(input.length/1.5));assert.ok(Math.abs(frequency(output[0])-440)<5);assert.ok(output[0].every(Number.isFinite));});
test('ピッチ変更は長さを維持し、短い素材も処理する',()=>{const input=tone(1);const output=transform([input,input],rate,1,12);assert.equal(output[0].length,input.length);assert.ok(Math.abs(frequency(output[0])-880)<8);const short=tone(.005);assert.equal(transform([short,short],rate,1,-12)[0].length,short.length);});
test('WAVはステレオPCM16ヘッダーとクリップ処理を持つ',()=>{const data=encodeWav([new Float32Array([2,-2]),new Float32Array([.5,-.5])],rate),view=new DataView(data);assert.equal(view.getUint16(22,true),2);assert.equal(view.getUint32(24,true),rate);assert.equal(view.getUint32(40,true),8);assert.equal(view.getInt16(44,true),32767);assert.equal(view.getInt16(48,true),-32768);});
test('MP3はモノ・ステレオの両方を実際にエンコード',()=>{for(const channels of [[tone(.2)],[tone(.2),tone(.2)]]){const data=encodeMp3(channels,rate);assert.ok(data.length>1000);assert.equal(data[0],255);assert.equal(data[1]&224,224);}});
test('BPM自動解析は120BPMのクリック列を認識し、無音は低信頼度',()=>{const signal=new Float32Array(rate*8);for(let beat=0;beat<16;beat++)for(let j=0;j<200;j++)signal[Math.round(beat*rate*.5)+j]=Math.exp(-j/30);const result=detectBpm([signal],rate);assert.ok(Math.abs(result.bpm-120)<=1);assert.equal(detectBpm([new Float32Array(rate)],rate).confidence,0);});

test('拍の吸着は選択範囲の始点を基準にし、範囲の両端を保持する',async()=>{
  const {quantizeBoundaries}=await import('../src/core.js');
  const points=[.137,1.151,2.122,3.161,4.137],snapped=quantizeBoundaries(points,.25);
  assert.equal(snapped[0],points[0]);assert.equal(snapped.at(-1),points.at(-1));
  for(let i=1;i<snapped.length-1;i++)assert.ok(Math.abs((snapped[i]-.137)/.25-Math.round((snapped[i]-.137)/.25))<1e-10);
});

test('任意長の音は周回境界を越えて加算され、cutは次の発音で切れる',async()=>{
  const {patternTrack}=await import('../src/audio.js');
  const context={sampleRate:100,createBuffer(channels,length,rate){const data=Array.from({length:channels},()=>new Float32Array(length));return {numberOfChannels:channels,length,sampleRate:rate,duration:length/rate,copyToChannel(c,i){data[i].set(c);},getChannelData(i){return data[i];}};}};
  const input=context.createBuffer(1,150,100);input.getChannelData(0).fill(1);
  const track={steps:[false,false,false,false,false,false,true,false],mode:'overlap'},timing={bpm:120,lengthTicks:8,resolution:8,swing:50};
  const overlap=patternTrack(context,input,track,timing).getChannelData(0);
  assert.equal(overlap.length,100);assert.equal(overlap[0],2);assert.equal(overlap[30],1);assert.equal(overlap[80],2);
  track.mode='cut';const cut=patternTrack(context,input,track,timing).getChannelData(0);
  assert.equal(cut[0],1);assert.equal(cut[80],1);assert.equal(cut[74],0);
});

test('BPM変換は総時間だけでなく、16個のアタック位置を欠落なく保つ',()=>{
  const input=new Float32Array(rate*8);
  for(let beat=0;beat<16;beat++)for(let i=0;i<600;i++)input[Math.round((.137+beat*.5)*rate)+i]=Math.exp(-i/100)*Math.cos(i*.3);
  for(const tempo of [.5,.75,1.5,2]){
    const output=transform([input,input],rate,tempo,0)[0];assert.equal(output.length,Math.round(input.length/tempo));
    for(let beat=0;beat<16;beat++){
      const target=(.137+beat*.5)/tempo;let amplitude=0,position=0;
      for(let i=Math.max(0,Math.round((target-.04)*rate));i<Math.min(output.length,Math.round((target+.04)*rate));i++)if(Math.abs(output[i])>amplitude){amplitude=Math.abs(output[i]);position=i/rate;}
      assert.ok(amplitude>.25,`tempo ${tempo}, beat ${beat}: attack missing`);assert.ok(Math.abs(position-target)<1/rate,`tempo ${tempo}, beat ${beat}: attack shifted`);
    }
  }
});

test('選択したループの拍数から小数BPMを算出し、元音源の長さで校正する',async()=>{
  const {sourceBpmFromLoop}=await import('../src/core.js');assert.equal(sourceBpmFromLoop(8,[.125,.375],4),120);assert.equal(sourceBpmFromLoop(8,[0,2.013/8],4),119.225);assert.throws(()=>sourceBpmFromLoop(8,[.1,.1],4));assert.throws(()=>sourceBpmFromLoop(8,[0,1],100));
});


test('複数拍の素材長を配置から求め、休符・同時発音・周回・原寸を扱う',async()=>{
  // Ticks are sixteenth notes: eighth-note step s is tick 2s, and spans come back in ticks.
  const {makeTrack,trackSpanTicks,syncedFrames}=await import('../src/core.js');
  const tracks=Array.from({length:4},(_,i)=>makeTrack(i));
  for(const s of [0,8,16])tracks[0].steps[s]=true;tracks[3].steps[24]=true;
  assert.equal(trackSpanTicks(tracks,0,4,32),8);assert.equal(trackSpanTicks(tracks,3,4,32),8);
  tracks[1].steps[24]=true;assert.equal(trackSpanTicks(tracks,1,4,32),8);
  tracks[0].sync='original';assert.equal(trackSpanTicks(tracks,0,4,32),null);
  tracks[0].sync='fixed';tracks[0].syncSteps=7;assert.equal(trackSpanTicks(tracks,0,4,32),14);
  const lone=[makeTrack(0)];lone[0].steps[10]=true;assert.equal(trackSpanTicks(lone,0,1,32),32);
  for(const n of [3,5,7]){lone[0].sync='fixed';lone[0].syncSteps=n;assert.equal(syncedFrames(120,32,trackSpanTicks(lone,0,1,32),44100),n*11025);}
  const sixteenth=[makeTrack(0)];for(const t of [0,3,6])sixteenth[0].steps[t]=true;assert.equal(trackSpanTicks(sixteenth,0,1,16),3);
});

test('スウィングは選んでいるグリッドの裏のステップだけを遅らせる',()=>{
  const track=makeTrack(0),period=44100*2;for(const t of [0,1,2,3])track.steps[t]=true;
  // 120 BPM, 16 ticks = 2 s. A 16th step is 0.125 s; 66% puts the off-beat at 0.165 s.
  assert.deepEqual(triggerFrames(track,{lengthTicks:16,resolution:16,swing:50},period),[0,5513,11025,16538]);
  assert.deepEqual(triggerFrames(track,{lengthTicks:16,resolution:16,swing:66},period),[0,Math.round(.165*44100),11025,Math.round((.25+.165)*44100)]);
  // On the eighth grid only even ticks play, and the swung step is tick 2.
  assert.deepEqual(triggerFrames(track,{lengthTicks:16,resolution:8,swing:66},period),[0,Math.round(.33*44100)]);
  assert.equal(offbeatTicks([track]),2);
});

test('ZIP（無圧縮）は既知のCRC32と、ローカルヘッダ・中央ディレクトリ・終端レコードを持つ',async()=>{
  const {crc32,zipStore}=await import('../src/core.js');
  assert.equal(crc32(new TextEncoder().encode('123456789')),0xcbf43926);
  const a=new TextEncoder().encode('hello'),b=new Uint8Array([0,1,2,255]);
  const zip=zipStore([{name:'track01.wav',data:a},{name:'track03.wav',data:b}],new Date(2026,9,28,12,34,56)),v=new DataView(zip.buffer);
  assert.equal(v.getUint32(0,true),0x04034b50);assert.equal(v.getUint16(8,true),0);assert.equal(v.getUint32(14,true),crc32(a));assert.equal(v.getUint32(18,true),5);
  assert.equal(new TextDecoder().decode(zip.subarray(30,41)),'track01.wav');assert.deepEqual([...zip.subarray(41,46)],[...a]);
  const end=zip.length-22;assert.equal(v.getUint32(end,true),0x06054b50);assert.equal(v.getUint16(end+10,true),2);
  const directory=v.getUint32(end+16,true);assert.equal(v.getUint32(directory,true),0x02014b50);assert.equal(v.getUint32(directory+42,true),0);
  const second=directory+46+11;assert.equal(v.getUint32(second,true),0x02014b50);assert.equal(v.getUint32(second+42,true),46);assert.equal(v.getUint32(second+16,true),crc32(b));
  assert.equal(v.getUint16(10,true),(12<<11)|(34<<5)|28);assert.equal(v.getUint16(12,true),((2026-1980)<<9)|(10<<5)|28);
});
