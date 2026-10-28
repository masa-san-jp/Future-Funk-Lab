import './style.css';
import { clamp, aiffToWav, makeTrack, boundaries, quantizeBoundaries, snapBoundary, stereo, midChannels, monoChannels, sliceChannels, fadeEdges, encodeWav, zipStore, crc32, formatTime, formatDb, sliderDb, sourceBpmFromLoop, patternSeconds, gridSeconds, trackSpanTicks, syncedFrames, displaySteps, ticksPerStep, offbeatTicks, PATTERN_TICKS } from './core.js';
import { AudioEngine, audioBuffer, makePartGraph, renderPattern, renderPart, activeTrack } from './audio.js';
import { Waveform } from './waveform.js';
import { serializeProject, parseProject, checkSource, projectFileName } from './project.js';
import { autosave } from './autosave.js';
const $=id=>document.getElementById(id);
const steps=()=>displaySteps(state.lengthTicks,state.resolution);
const timing=()=>({bpm:state.bpm,lengthTicks:state.lengthTicks,resolution:state.resolution,swing:state.swing});
const state={bpm:120,sourceBpm:120,rate:44100,original:null,channels:null,range:[0,1],committed:null,points:[],count:4,lengthTicks:32,resolution:8,swing:50,snap:false,loop:true,sourceLoop:false,tracks:Array.from({length:8},(_,i)=>makeTrack(i)),settings:{low:300,high:3000,slope:12},buffers:[],parts:[{name:'ボーカル',key:'vocal',hp:{on:true,freq:200,slope:12},lp:{on:false,freq:2000,slope:12}},{name:'ベース',key:'bass',hp:{on:false,freq:200,slope:12},lp:{on:true,freq:250,slope:12}}],partGraphs:[],busy:false,generation:0,recorded:null,recording:false,sourceName:'',sourceFile:null,selectedTrack:0};
let sourcePlayhead=0,sourceAudioBuffer=null,sourceSeekVersion=0,tempoFollowsSource=true,endpointMenuTime=0,padPlaybackVersion=0,loopBeatsOverride=null;
let workerCounter=0,workerJobs=new Map();
const workerUrl=URL.createObjectURL(new Blob([WORKER_SOURCE],{type:'text/javascript'}));
const worker=new Worker(workerUrl);URL.revokeObjectURL(workerUrl);
worker.onmessage=({data})=>{const job=workerJobs.get(data.id);if(!job)return;workerJobs.delete(data.id);if(data.error)job.reject(Error(data.error));else job.resolve(data.result);};
worker.onerror=()=>{for(const job of workerJobs.values())job.reject(Error('音声処理ワーカーが停止しました。ページを再読み込みしてください'));workerJobs.clear();};
function job(type,channels,extra={}){return new Promise((resolve,reject)=>{const id=++workerCounter;workerJobs.set(id,{resolve,reject});worker.postMessage({id,type,channels,rate:state.rate,...extra});});}
function status(message,error=false){$('status').textContent=message;$('status').className=error?'error':state.busy?'busy':'';}
function failure(error){console.error(error);status(error.message||String(error),true);}
function guarded(fn){return (...args)=>Promise.resolve().then(()=>fn(...args)).catch(failure);}
function bind(id,event,fn){$(id).addEventListener(event,guarded(fn));}
function refreshAvailability(){document.querySelectorAll('[data-needs-source]').forEach(e=>e.disabled=!state.channels||state.busy);document.querySelectorAll('[data-needs-chop]').forEach(e=>e.disabled=!state.committed||state.busy);document.querySelectorAll('[data-part-play],[data-part-export]').forEach(e=>e.disabled=!state.channels||state.busy);document.querySelectorAll('[data-track-play],.chop-pad').forEach(e=>e.disabled=!state.committed||state.busy||Number(e.dataset.trackPlay??e.dataset.pad)>=state.count);$('chop-count').disabled=state.busy||!state.committed;$('global-bpm').disabled=state.busy;$('source-bpm').disabled=state.busy;$('source-file').disabled=state.busy||state.recording;$('demo').disabled=state.busy||state.recording;$('record').disabled=state.busy||state.recording;$('record-stop').disabled=!state.recording;$('record-save').disabled=!state.recorded;$('project-open').disabled=state.busy||state.recording;$('autosave-restore').disabled=state.busy||state.recording;$('autosave-discard').disabled=state.busy;$('project-source-pick').disabled=state.busy||state.recording;}
function busy(value){state.busy=value;refreshAvailability();}
function numeric(id,min,max,fn){bind(id,'change',()=>{const value=Number($(id).value);if(!Number.isFinite(value)||$(id).value==='')throw Error('数値を入力してください');const next=clamp(value,min,max);$(id).value=next;return fn(next);});}
function download(data,name,type){const blob=data instanceof Blob?data:new Blob([data],{type});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);}
const engine=new AudioEngine((step,position)=>{document.querySelectorAll('.step.playhead').forEach(e=>e.classList.remove('playhead'));if(step>=0)document.querySelectorAll(`.step[data-step="${step}"]`).forEach(e=>e.classList.add('playhead'));$('transport-time').textContent=formatTime(position);$('seq-play').classList.toggle('active',engine.playing);},key=>{if(key==='sequence')$('seq-play').classList.remove('active');if(key.startsWith('pad-'))updateChopPlayback();document.querySelectorAll(`[data-preview="${key}"]`).forEach(e=>{e.classList.remove('active');e.setAttribute('aria-pressed','false');});});
async function initAudio(){await engine.init();state.rate=engine.context.sampleRate;engine.configure(state.tracks,state.settings,state.buffers,state.count);return engine.context;}
const sourceWave=new Waveform($('source-wave'),{onRange:range=>{if(state.busy){updateRangeFields();return;}state.range=range.map(t=>t/duration());if(engine.preview.get('source')?.sourceMode==='range')stopSource();updateRangeFields();},onSeek:guarded(time=>playSourceAt(time)),onTogglePlay:guarded(toggleSource),onSetEndpoint:guarded(setSourceEndpoint)});
const chopWave=new Waveform($('chop-wave'),{onBoundary:(index,value,options)=>moveBoundary(index,value,options)});
const partWaves=[];
function duration(){return state.channels?state.channels[0].length/state.rate:0;}
function updateRangeFields(){const d=duration();$('range-start').value=(state.range[0]*d).toFixed(3);$('range-end').value=(state.range[1]*d).toFixed(3);$('range-start').max=d;$('range-end').max=d;$('range-length').textContent=((state.range[1]-state.range[0])*d).toFixed(3)+' s';if(loopBeatsOverride==null&&d)$('loop-beats').value=Math.max(.5,Math.round((state.range[1]-state.range[0])*d*state.bpm/60*2)/2);updatePatternLength();sourceWave.range=state.range.map(t=>t*d);sourceWave.draw();}
function sourceVoicePosition(voice){
  let elapsed=engine.context.currentTime-voice.origin;
  if(voice.loop)elapsed%=voice.buffer.duration;
  return clamp((voice.sourceStart||0)+elapsed,0,duration());
}
function updateSourceCursor(){
  sourceWave.cursor=state.channels?sourcePlayhead:null;
  $('source-position').textContent=`${formatTime(sourcePlayhead)} / ${formatTime(duration())}`;
  sourceWave.draw();
}
function stopSource(){
  sourceSeekVersion++;
  const voice=engine.preview.get('source');
  if(voice&&!voice.stopped)sourcePlayhead=sourceVoicePosition(voice);
  engine.stopPreview('source');updateSourceCursor();
}
async function playSourceAt(time,mode='full'){
  if(!state.channels||state.busy)return;
  const version=++sourceSeekVersion,generation=state.generation;
  await initAudio();
  if(version!==sourceSeekVersion||generation!==state.generation||state.busy)return;
  const start=mode==='range'?state.range[0]*duration():0;
  if(mode==='full'&&!sourceAudioBuffer)sourceAudioBuffer=audioBuffer(engine.context,state.channels,state.rate);
  const buffer=mode==='range'?audioBuffer(engine.context,sliceChannels(state.channels,start,state.range[1]*duration(),state.rate),state.rate):sourceAudioBuffer;
  const offset=mode==='range'?0:clamp(time,0,Math.max(0,buffer.duration-1/state.rate));
  engine.stopPreview('source');
  const voice=engine.playBuffer(buffer,engine.master,{key:'source',offset,loop:mode==='range'&&state.sourceLoop});
  voice.sourceMode=mode;voice.sourceStart=start;
  voice.gain.gain.setValueAtTime(0,voice.when);voice.gain.gain.linearRampToValueAtTime(1,voice.when+.005);
  voice.source.addEventListener('ended',()=>{if(!voice.stopped&&version===sourceSeekVersion){sourcePlayhead=start+buffer.duration;updateSourceCursor();}});
  sourcePlayhead=start+offset;updateSourceCursor();
  const button=$(mode==='range'?'source-range-play':'source-play');button.classList.add('active');button.setAttribute('aria-pressed','true');
}
async function toggleSource(){
  if(engine.preview.get('source')?.sourceMode==='full'){stopSource();return;}
  await playSourceAt(sourcePlayhead>=duration()-1/state.rate?0:sourcePlayhead);
}
function drawSource(){sourceWave.set(state.channels,state.rate,state.range.map(t=>t*duration()));updateRangeFields();updateSourceCursor();}
function drawParts(){const channels=state.channels?midChannels(state.channels):null;state.mid=channels;partWaves.forEach(w=>w.set(channels,state.rate));state.parts.forEach((_,i)=>$(`part-time-${i}`).textContent=`0:00.000 / ${formatTime(duration())}`);}
function resetSource(){
  clearTimeout(boundaryTimer);boundaryTimer=null;pitchTimers.forEach(clearTimeout);stopSequence();sourceSeekVersion++;sourcePlayhead=0;sourceAudioBuffer=null;tempoFollowsSource=true;loopBeatsOverride=null;state.generation++;state.pitchEpoch=(state.pitchEpoch||0)+1;state.original=null;state.channels=null;state.committed=null;state.mid=null;state.buffers=[];state.points=[];state.range=[0,1];state.recorded=null;state.sourceName='';state.sourceFile=null;state.tracks=Array.from({length:8},(_,i)=>makeTrack(i));engine.graphs?.forEach(g=>g.dispose());engine.graphs=null;state.partGraphs.forEach(g=>g.dispose());state.partGraphs=[];
  $('source-name').textContent='音源が選択されていません';$('record-name').textContent='未録音';$('source-file').value='';setSourceTool('select');sourceWave.zoom=1;sourceWave.scroll=0;$('zoom').value=1;$('zoom-value').textContent='×1';$('wave-scroll').value=0;$('wave-scroll').max=0;$('wave-scroll').disabled=true;drawSource();drawParts();chopWave.set(null,state.rate);chopWave.points=[];$('chop-pads').replaceChildren();$('chop-info').textContent='サンプリング範囲を確定してください';renderTracks();refreshAvailability();
}
async function setSource(channels,name,{recorded=false,knownBpm=null,file}={}){
  resetSource();const generation=state.generation;busy(true);status('音源のBPMを解析しています…');
  try {
    state.original=stereo(channels).map(c=>c.slice());state.sourceName=name;state.sourceFile=file;$('source-name').textContent=name;hideAutosaveBanner();markSourceChanged();
    if(recorded){state.recorded=state.original.map(c=>c.slice());$('record-name').textContent=`${name} · 未保存`;}
    const detected=knownBpm?{bpm:knownBpm,confidence:1}:await job('detect',state.original);
    if(generation!==state.generation)return;
    state.sourceBpm=detected.bpm;state.bpm=detected.bpm;tempoFollowsSource=true;$('source-bpm').value=state.sourceBpm;$('global-bpm').value=state.bpm;$('sequence-bpm').textContent=state.bpm;$('bpm-confidence').textContent=knownBpm?'既知のBPM':detected.confidence<.15?'推定値・必要に応じて修正':'推定値・ループの拍数から補正可';
    if(await rebuildSource())markClean();
  } finally {if(generation===state.generation)busy(false);}
}
// Project reopening relies on decoding a file exactly as it was first loaded.
async function decodeSource(buffer){
  const wav=aiffToWav(new Uint8Array(buffer));let decoded;
  try{decoded=await engine.context.decodeAudioData(wav?wav.buffer:buffer);}catch{throw Error('この形式は読み込めませんでした。WAV・AIFF・MP3・AAC(M4A)・FLAC・Opusのどれかで書き出し直してください');}
  if(decoded.duration<.01)throw Error('音源が短すぎます（10 ms以上必要です）');if(decoded.duration>600)throw Error('音源は10分以内にしてください');
  return [decoded.getChannelData(0).slice(),decoded.getChannelData(Math.min(1,decoded.numberOfChannels-1)).slice()];
}
async function loadFile(file,recorded=false){
  if(!file)return;await initAudio();busy(true);status('音源を読み込んでいます…');
  try{
    const bytes=new Uint8Array(await file.arrayBuffer()),name=file.name||'microphone.wav',source={kind:recorded?'recording':'file',name,blob:file,bytes:bytes.length,crc:crc32(bytes)};
    await setSource(await decodeSource(bytes.buffer),name,{recorded,file:source});
  }
  catch(error){throw Error(`音源を読み込めませんでした。${error.message}`);}finally{busy(false);}
}
async function rebuildSource(){
  if(!state.original)return;clearTimeout(boundaryTimer);const generation=++state.generation;busy(true);stopSequence();status('BPMを変換しています…');
  try{
    if(state.original[0].length/state.rate*state.sourceBpm/state.bpm>600)throw Error('BPM変換後の音源が10分を超えます。BPMを上げるか、短い音源を選択してください');
    const channels=await job('transform',state.original,{tempo:state.bpm/state.sourceBpm,pitch:0});if(generation!==state.generation)return false;
    const relative=duration()?sourcePlayhead/duration():0;state.channels=channels;sourceAudioBuffer=null;sourcePlayhead=relative*duration();drawSource();drawParts();
    state.partGraphs.forEach(g=>g.dispose());state.partGraphs=[];
    if(state.committed)await rebuildChops();
    status(`音源を読み込みました · ${state.sourceBpm} → ${state.bpm} BPM · ${formatTime(duration())}`);
    return generation===state.generation;
  }finally{if(generation===state.generation)busy(false);}
}
const pitchTimers=Array(8),pitchVersions=Array(8).fill(0);
function trackBuildKey(index){
  const t=state.tracks[index];return [state.generation,state.points[index],state.points[index+1],state.bpm,state.lengthTicks,trackSpanTicks(state.tracks,index,state.count,state.lengthTicks),t.pitch,t.cents].join(':');
}
async function trackBuffer(index){
  const key=trackBuildKey(index),a=state.points[index]*duration(),b=state.points[index+1]*duration();
  const channels=sliceChannels(state.channels,a,b,state.rate),track={...state.tracks[index]};
  const span=trackSpanTicks(state.tracks,index,state.count,state.lengthTicks),target=syncedFrames(state.bpm,state.lengthTicks,span,state.rate);
  const tempo=target?channels[0].length/target:1,pitch=track.pitch+track.cents/100;
  const preview=await job('transform',channels,{tempo,pitch:0});
  const shifted=pitch?await job('transform',channels,{tempo,pitch}):preview.map(c=>c.slice());
  const exact=cs=>cs.map(c=>{if(target==null||c.length===target)return c;const out=new Float32Array(target);out.set(c.subarray(0,target));return out;});
  const buffer=audioBuffer(engine.context,fadeEdges(exact(shifted),state.rate),state.rate);
  buffer.chopPreview=audioBuffer(engine.context,fadeEdges(exact(preview),state.rate),state.rate);
  buffer.syncSpan=span;buffer.buildKey=key;return buffer;
}
function applyTrackBuffer(index,buffer){
  state.buffers[index]=buffer;engine.replaceTrackBuffer(index,buffer);drawMini(index);updateTrackTiming(index);
  const voice=engine.preview.get(`pad-${index}`);
  if(voice&&!voice.stopped){const phase=(Math.max(0,engine.context.currentTime-voice.origin)%voice.buffer.duration)/voice.buffer.duration;startPadVoice(index,phase*buffer.chopPreview.duration);}
}
function updateTrackTiming(index){
  const buffer=state.buffers[index];if(!buffer)return;
  const original=(state.points[index+1]-state.points[index])*duration(),span=buffer.syncSpan;
  const text=span==null?`原寸 ${buffer.duration.toFixed(3)} s`:`${span/ticksPerStep(state.resolution)}ステップ / ${buffer.duration.toFixed(3)} s（元 ${original.toFixed(3)} s）`;
  const label=document.querySelector(`[data-track-length="${index}"]`);if(label)label.textContent=buffer.duration.toFixed(3)+' s';
  const timing=document.querySelector(`[data-sync-length="${index}"]`);if(timing)timing.textContent=text;
  const pad=document.querySelector(`[data-pad-length="${index}"]`);if(pad)pad.textContent=span==null?`${original.toFixed(3)} s`:`${buffer.duration.toFixed(3)} s · ${span/ticksPerStep(state.resolution)}ステップ`;
}
function queueSync(){
  for(let i=0;i<state.count;i++)if(state.buffers[i]?.buildKey!==trackBuildKey(i))queuePitch(i,false);
}
async function rebuildChops({preservePad=false}={}){
  state.pitchEpoch=(state.pitchEpoch||0)+1;const epoch=state.pitchEpoch;
  pitchTimers.forEach(clearTimeout);if(preservePad)engine.stop();else engine.stopAll();state.buffers=[];engine.buffers=state.buffers;
  const results=await Promise.all(Array.from({length:state.count},(_,i)=>trackBuffer(i)));
  if(epoch!==state.pitchEpoch)return;
  state.buffers=results;engine.configure(state.tracks,state.settings,state.buffers,state.count);
  if(preservePad){const playback=getChopPlayback();if(playback){const start=(state.points[playback.index]-state.committed[0])*duration(),end=(state.points[playback.index+1]-state.committed[0])*duration();if(Math.abs(start-playback.start)>.5/state.rate||Math.abs(end-playback.end)>.5/state.rate)startPadVoice(playback.index,playback.position>=start&&playback.position<end?(playback.position-start)/(end-start)*state.buffers[playback.index].chopPreview.duration:0);}}
  drawChops();renderTracks();refreshAvailability();
}
function quantizeChops(){
  if(!state.committed||!state.snap)return;
  const points=quantizeBoundaries(state.points.map(t=>t*duration()),gridSeconds(state.bpm,state.resolution),Math.max(.001,1/state.rate));
  state.points=points.map(t=>t/duration());
}
function drawChops(){
  if(!state.committed)return;const [a,b]=state.committed.map(t=>t*duration());
  const channels=sliceChannels(state.channels,a,b,state.rate);chopWave.gridSeconds=gridSeconds(state.bpm,state.resolution);chopWave.set(channels,state.rate,null,state.points.map(t=>t*duration()-a));
  $('chop-info').textContent=`${state.count}区間 → トラック1〜${state.count} · ${(b-a).toFixed(3)} s`;
  $('chop-pads').innerHTML=Array.from({length:state.count},(_,i)=>`<button class="chop-pad" data-pad="${i}" data-preview="pad-${i}" aria-pressed="false"><strong>${i+1}</strong><small data-pad-length="${i}">${((state.points[i+1]-state.points[i])*duration()).toFixed(3)} s</small><span>↻ ループ試聴</span></button>`).join('');
  document.querySelectorAll('[data-pad]').forEach(b=>{b.addEventListener('click',guarded(()=>playPad(Number(b.dataset.pad))));const active=engine.preview.has(`pad-${b.dataset.pad}`);b.classList.toggle('active',active);b.setAttribute('aria-pressed',active);});
  for(let i=0;i<state.count;i++)updateTrackTiming(i);updateChopPlayback();
}
let boundaryTimer;
async function flushBoundary(){if(!boundaryTimer)return;clearTimeout(boundaryTimer);boundaryTimer=null;await rebuildChops({preservePad:true});}
function moveBoundary(index,value,options={}){
  if(!state.committed||state.busy)return;
  const start=state.committed[0]*duration(),points=state.points.map(t=>t*duration()-start),grid=state.snap?gridSeconds(state.bpm,state.resolution):0;
  // Keyboard requests below 11ms advance to the adjacent grid point while snapped.
  if(grid&&options.keyboard)value=points[index]+options.direction*grid;
  const next=snapBoundary(value,index,points,grid,0,Math.max(1/state.rate,.001));state.points[index]=(next+start)/duration();
  chopWave.points=state.points.map(t=>t*duration()-start);chopWave.draw();
  clearTimeout(boundaryTimer);boundaryTimer=setTimeout(guarded(async()=>{boundaryTimer=null;busy(true);try{await rebuildChops({preservePad:true});status('チョップ位置を更新しました');}finally{busy(false);}}),100);
}
async function sample(){
  await initAudio();if(!state.channels)return;
  if((state.range[1]-state.range[0])*duration()<state.count*.001)throw Error('分割数×1 ms以上の範囲を選んでください');
  state.committed=[...state.range];state.points=boundaries(...state.committed,state.count);quantizeChops();busy(true);
  try{await rebuildChops();status(`${state.count}区間をトラックに割り当てました。ステップをクリックしてパターンを作成できます。`);}finally{busy(false);}
}
async function playPad(index){
  if(state.busy||!state.committed||index>=state.count)return;
  const version=++padPlaybackVersion,generation=state.generation;
  await initAudio();if(version!==padPlaybackVersion||generation!==state.generation||state.busy)return;
  const key=`pad-${index}`,wasPlaying=engine.preview.has(key);
  stopChopPreview();if(wasPlaying)return;
  await flushPitch();if(version!==padPlaybackVersion||generation!==state.generation||state.busy)return;startPadVoice(index);
}
function startPadVoice(index,offset=0){
  const buffer=state.buffers[index]?.chopPreview;if(!buffer)return;
  stopChopPreview();
  const voice=engine.playBuffer(buffer,engine.master,{key:`pad-${index}`,loop:true,offset:Math.min(offset,buffer.duration-1/state.rate)});
  const first=Math.round(state.points[index]*duration()*state.rate),last=Math.round(state.points[index+1]*duration()*state.rate),origin=Math.round(state.committed[0]*duration()*state.rate);
  voice.chopIndex=index;voice.chopStart=(first-origin)/state.rate;voice.chopSourceLength=(last-first)/state.rate;
  document.querySelector(`[data-pad="${index}"]`)?.classList.add('active');document.querySelector(`[data-pad="${index}"]`)?.setAttribute('aria-pressed','true');
  updateChopPlayback();
}
function getChopPlayback(){
  for(const [key,voice] of engine.preview)if(key.startsWith('pad-')&&!voice.stopped){
    const length=voice.buffer.duration,loopPosition=Math.max(0,engine.context.currentTime-voice.origin)%length,start=voice.chopStart;
    const sourceLength=voice.chopSourceLength??length;
    return {index:voice.chopIndex,start,end:start+sourceLength,duration:length,loopPosition,position:start+loopPosition/length*sourceLength};
  }
  return null;
}
function updateChopPlayback(){
  const playback=getChopPlayback();
  if(playback){
    chopWave.cursor=playback.position;chopWave.playbackRange=[playback.start,playback.end];chopWave.draw();
    $('chop-position').textContent=`区間${playback.index+1} · ${formatTime(playback.loopPosition)} / ${formatTime(playback.duration)} · 範囲内位置 ${formatTime(playback.position)}`;
    $('chop-progress').value=playback.loopPosition/playback.duration;
  }else if(chopWave.cursor!=null||chopWave.playbackRange){
    chopWave.cursor=null;chopWave.playbackRange=null;chopWave.draw();$('chop-position').textContent='停止中';$('chop-progress').value=0;
  }
}
function stopChopPreview(){for(const key of [...engine.preview.keys()])if(key.startsWith('pad-'))engine.stopPreview(key);}
function buildParts(){
  $('parts').innerHTML=state.parts.map((p,i)=>`<article class="part"><h3>${p.name}<span>${p.key.toUpperCase()}</span></h3><div class="row"><button data-part-play="${i}" data-preview="part-${i}" aria-pressed="false">▶ 再生</button><button data-part-stop="${i}">■ 停止</button><div class="grow"></div><select id="part-format-${i}" aria-label="${p.name}の書き出し形式"><option value="wav">WAV</option><option value="mp3">MP3</option></select><button data-part-export="${i}">↓ 書き出し</button></div>${['hp','lp'].map(type=>`<div class="filter-row"><label><input type="checkbox" data-part="${i}" data-filter="${type}" data-param="on" ${p[type].on?'checked':''}>${type==='hp'?'HPF':'LPF'}</label><select data-part="${i}" data-filter="${type}" data-param="slope" aria-label="${p.name}${type}勾配">${[6,12,24].map(n=>`<option value="${n}" ${n===p[type].slope?'selected':''}>−${n} dB/oct</option>`).join('')}</select><input type="number" data-part="${i}" data-filter="${type}" data-param="freq" min="${type==='hp'?50:200}" max="${type==='hp'?2000:8000}" value="${p[type].freq}" aria-label="${p.name}${type}カットオフ Hz"><input type="range" data-part="${i}" data-filter="${type}" data-param="freq" min="${type==='hp'?50:200}" max="${type==='hp'?2000:8000}" value="${p[type].freq}" aria-label="${p.name}${type}周波数スライダー"></div>`).join('')}<canvas id="part-wave-${i}" class="wave small" tabindex="0" aria-label="${p.name}の波形。クリックでシーク"></canvas><div class="part-time"><span id="part-time-${i}">0:00.000 / 0:00.000</span><span>Hz · クリックでシーク</span></div><input id="part-seek-${i}" type="range" min="0" max="1" step="0.001" value="0" aria-label="${p.name}の再生位置" style="width:100%"></article>`).join('');
  state.parts.forEach((_,i)=>{partWaves[i]=new Waveform($(`part-wave-${i}`),{onSeek:time=>seekPart(i,time)});bind(`part-seek-${i}`,'input',()=>seekPart(i,Number($(`part-seek-${i}`).value)*duration()));});
  document.querySelectorAll('[data-part-play]').forEach(b=>b.addEventListener('click',guarded(()=>playPart(Number(b.dataset.partPlay)))));
  document.querySelectorAll('[data-part-stop]').forEach(b=>b.addEventListener('click',()=>engine.stopPreview(`part-${b.dataset.partStop}`)));
  document.querySelectorAll('[data-part-export]').forEach(b=>b.addEventListener('click',guarded(()=>exportPart(Number(b.dataset.partExport)))));
  document.querySelectorAll('[data-filter]').forEach(input=>input.addEventListener(input.type==='range'?'input':'change',guarded(()=>{
    const i=Number(input.dataset.part),type=input.dataset.filter,param=input.dataset.param;
    if(param==='on')state.parts[i][type][param]=input.checked;else{const value=Number(input.value);if(!Number.isFinite(value))throw Error('フィルター値を数値で入力してください');state.parts[i][type][param]=param==='freq'?clamp(value,Number(input.min),Number(input.max)):value;}
    document.querySelectorAll(`[data-part="${i}"][data-filter="${type}"][data-param="${param}"]`).forEach(e=>{if(param!=='on')e.value=state.parts[i][type][param];});refreshPartGraph(i);
  })));
}
function refreshPartGraph(index){
  if(!engine.context)return;const old=state.partGraphs[index],graph=makePartGraph(engine.context,state.parts[index],engine.master);state.partGraphs[index]=graph;
  const voice=engine.preview.get(`part-${index}`);if(voice){voice.gain.disconnect();voice.gain.connect(graph.input);}old?.dispose();
}
async function playPart(index,offset=0,force=false){
  if(!state.mid||state.busy)return;const stopped=engine.stopVersion,generation=state.generation;await initAudio();if(stopped!==engine.stopVersion||generation!==state.generation||!state.mid)return;const key=`part-${index}`;
  if(engine.preview.has(key)&&!force){engine.stopPreview(key);return;}
  if(!state.partGraphs[index])refreshPartGraph(index);
  const voice=await engine.playPreview(key,audioBuffer(engine.context,state.mid,state.rate),state.partGraphs[index].input,false,clamp(offset,0,Math.max(0,duration()-.001)));
  if(voice)document.querySelector(`[data-part-play="${index}"]`).classList.add('active');
}
async function seekPart(index,time){if(!state.mid)return;partWaves[index].cursor=time;partWaves[index].draw();$(`part-seek-${index}`).value=time/duration();$(`part-time-${index}`).textContent=`${formatTime(time)} / ${formatTime(duration())}`;if(engine.preview.has(`part-${index}`))await playPart(index,time,true);}
async function encodeAudio(channels,format){
  return format==='mp3'?{data:await job('mp3',channels),ext:'mp3',type:'audio/mpeg'}:{data:encodeWav(channels,state.rate),ext:'wav',type:'audio/wav'};
}
async function saveAudio(channels,format,name){
  if(format==='mp3')status('MP3にエンコードしています…');
  const file=await encodeAudio(channels,format);download(file.data,`${name}.${file.ext}`,file.type);
}
async function exportPart(index){
  busy(true);status(`${state.parts[index].name}を書き出しています…`);
  try{const channels=await renderPart(state.mid,state.rate,state.parts[index]);await saveAudio(channels,$(`part-format-${index}`).value,`future-funk-${state.parts[index].key}-${state.bpm}bpm`);status(`${state.parts[index].name}を書き出しました`);}finally{busy(false);}
}
// Compact view shows one 40px row per track plus a single editor for the selected
// track; detail view keeps every editor inline. Both share these pieces.
let trackView='compact';
try{if(localStorage.getItem('ffl:view')==='detail')trackView='detail';}catch{}
const trackName=i=>`TRACK ${String(i+1).padStart(2,'0')}`;
const trackLength=i=>state.buffers[i]?state.buffers[i].duration.toFixed(3)+' s':'EMPTY';
function trackButtonsHtml(i,{stop=true}={}){
  const track=state.tracks[i];
  return `<button data-track-play="${i}" data-preview="track-${i}" aria-pressed="false" aria-label="トラック${i+1}試聴">▶</button>${stop?`<button data-track-stop="${i}" aria-label="トラック${i+1}試聴停止">■</button>`:''}<button data-track-mute="${i}" aria-pressed="${track.mute}" aria-label="トラック${i+1}ミュート">M</button><button data-track-solo="${i}" aria-pressed="${track.solo}" aria-label="トラック${i+1}ソロ">S</button>`;
}
function trackEditorHtml(i,{transport=true}={}){
  const track=state.tracks[i];
  const loop=`<button data-track-loop="${i}" aria-pressed="${track.previewLoop}" aria-label="トラック${i+1}試聴ループ">↻</button>`;
  const head=transport?trackButtonsHtml(i).replace('<button data-track-mute',`${loop}<button data-track-mute`):loop;
  return `<div class="edit-line">${head}<select data-track-mode="${i}" aria-label="トラック${i+1}発音方式"><option value="overlap" ${track.mode==='overlap'?'selected':''}>重ねる</option><option value="cut" ${track.mode==='cut'?'selected':''}>切る</option></select><label>PITCH <input type="number" data-track-pitch="${i}" min="-12" max="12" step="1" value="${track.pitch}"></label><label>¢ <input type="number" data-track-cents="${i}" min="-50" max="50" step="1" value="${track.cents}"></label></div><div class="edit-line sync-controls"><label>長さ <select data-track-sync="${i}" aria-label="トラック${i+1}の長さ同期"><option value="auto" ${track.sync==='auto'?'selected':''}>配置に同期</option><option value="fixed" ${track.sync==='fixed'?'selected':''}>ステップ数を指定</option><option value="original" ${track.sync==='original'?'selected':''}>原寸</option></select></label><label>8分音符 × <input type="number" data-track-sync-steps="${i}" aria-label="トラック${i+1}の同期ステップ数" min="0.25" max="128" step="0.25" value="${track.syncSteps}" ${track.sync!=='fixed'?'disabled':''}></label><output data-sync-length="${i}" class="hint"></output></div><div class="edit-line">${['LOW','MID','HI'].map((name,k)=>`<label><span class="eq-label">${name}</span><input type="range" min="-60" max="0" step="0.5" value="${track.eq[k]===-Infinity?-60:track.eq[k]}" data-track-eq="${i}" data-band="${k}" aria-label="トラック${i+1} ${name} dB"><input type="text" id="eq-value-${i}-${k}" data-track-eq-db="${i}" data-band="${k}" value="${formatDb(track.eq[k])}" aria-label="トラック${i+1} ${name}数値 dB" style="width:42px;min-height:23px;font-size:10px;padding:3px"></label>`).join('')}</div><div class="edit-line"><label>OUT <input type="range" min="-60" max="6" step="0.5" value="${track.volume===-Infinity?-60:track.volume}" data-track-volume="${i}" aria-label="トラック${i+1}出力 dB"><input type="text" data-track-db="${i}" value="${formatDb(track.volume)}" aria-label="トラック${i+1}出力数値 dB" style="width:58px;min-height:23px;font-size:10px;padding:3px">dB</label></div>`;
}
function trackStepsHtml(i){
  const track=state.tracks[i];
  return `<div class="steps" style="grid-template-columns:repeat(${steps()},minmax(18px,1fr))">${Array.from({length:steps()},(_,s)=>{const tick=s*ticksPerStep(state.resolution);return `<button class="step ${track.steps[tick]?'active':''}" data-track-step="${i}" data-step="${s}" data-tick="${tick}" aria-label="トラック${i+1} ステップ${s+1}" aria-pressed="${track.steps[tick]}" ${!state.committed||i>=state.count?'disabled':''}><span>${s+1}</span></button>`;}).join('')}</div>`;
}
function renderTracks(){
  if(state.selectedTrack>=state.count)state.selectedTrack=0;
  const compact=trackView==='compact';
  $('tracks').innerHTML=state.tracks.map((_,i)=>{
    const empty=!state.committed||i>=state.count?'empty':'';
    if(!compact)return `<div class="track-row ${empty}" data-track="${i}"><div><div class="track-label"><strong>${trackName(i)}</strong><span data-track-length="${i}">${trackLength(i)}</span></div><canvas id="track-wave-${i}" aria-label="トラック${i+1}の波形"></canvas></div><div>${trackEditorHtml(i)}</div><div>${trackStepsHtml(i)}</div></div>`;
    const selected=i===state.selectedTrack;
    return `<div class="track-row compact ${empty} ${selected?'selected':''}" data-track="${i}"><div class="track-label"><button class="track-select" data-track-select="${i}" aria-pressed="${selected}" aria-label="${trackName(i)}を編集">${trackName(i)}</button><span data-track-length="${i}">${trackLength(i)}</span><canvas id="track-wave-${i}" aria-label="トラック${i+1}の波形"></canvas></div><div class="track-buttons">${trackButtonsHtml(i,{stop:false})}</div><div>${trackStepsHtml(i)}</div></div>`;
  }).join('');
  const editor=$('track-editor');
  editor.classList.toggle('hidden',!compact);
  editor.innerHTML=compact?`<div class="track-editor-head"><strong>編集中：${trackName(state.selectedTrack)}</strong></div>${trackEditorHtml(state.selectedTrack,{transport:false})}`:'';
  document.querySelector('.sequencer').classList.toggle('compact',compact);
  for(const view of ['compact','detail'])$(`view-${view}`).setAttribute('aria-pressed',trackView===view);
  state.tracks.forEach((_,i)=>{drawMini(i);updateTrackTiming(i);});updatePatternLength();refreshAvailability();
  for(const [key,voice] of engine.preview)if(key.startsWith('track-')&&!voice.stopped)document.querySelectorAll(`[data-track-play="${key.slice(6)}"]`).forEach(b=>b.classList.add('active'));
  // 64 cells need more room than the shared column; let the table scroll instead.
  document.querySelector('.sequencer').style.minWidth=steps()>32?`${(compact?280:575)+steps()*21+24}px`:'';
}
function setTrackView(view){
  trackView=view;try{localStorage.setItem('ffl:view',view);}catch{}
  renderTracks();
}
bind('view-compact','click',()=>setTrackView('compact'));
bind('view-detail','click',()=>setTrackView('detail'));
// Track controls are rendered in two places, so events are delegated from the section.
const pressAll=(attr,i,value)=>document.querySelectorAll(`[data-track-${attr}="${i}"]`).forEach(b=>b.setAttribute('aria-pressed',value));
const trackClicks={
  trackStep(button,i){const t=state.tracks[i],tick=Number(button.dataset.tick);t.steps[tick]=!t.steps[tick];button.classList.toggle('active',t.steps[tick]);button.setAttribute('aria-pressed',t.steps[tick]);engine.refreshPatternTrack(i);queueSync();},
  trackPlay:(_,i)=>previewTrack(i),
  trackStop:(_,i)=>engine.stopPreview(`track-${i}`),
  trackLoop(_,i){const t=state.tracks[i];t.previewLoop=!t.previewLoop;pressAll('loop',i,t.previewLoop);const voice=engine.preview.get(`track-${i}`);if(voice)voice.source.loop=voice.loop=t.previewLoop;},
  trackMute(_,i){const t=state.tracks[i];t.mute=!t.mute;pressAll('mute',i,t.mute);engine.updateGains();},
  trackSolo(_,i){const t=state.tracks[i];t.solo=!t.solo;pressAll('solo',i,t.solo);engine.updateGains();},
  trackSelect(_,i){state.selectedTrack=i;renderTracks();}
};
const trackChanges={
  trackMode(input,i){state.tracks[i].mode=input.value;engine.refreshPatternTrack(i);},
  trackSync(input,i){state.tracks[i].sync=input.value;document.querySelectorAll(`[data-track-sync-steps="${i}"]`).forEach(e=>e.disabled=input.value!=='fixed');queueSync();},
  trackSyncSteps(input,i){const value=Number(input.value);if(!Number.isFinite(value)||value<.25||value>128)throw Error('同期ステップ数は0.25〜128で指定してください');state.tracks[i].syncSteps=value;queueSync();},
  trackPitch:(input,i)=>setTrackPitch(input,i,'pitch'),
  trackCents:(input,i)=>setTrackPitch(input,i,'cents'),
  trackEqDb(input,i){const band=Number(input.dataset.band),value=parseDb(input.value,0);state.tracks[i].eq[band]=value;input.value=formatDb(value);document.querySelector(`[data-track-eq="${i}"][data-band="${band}"]`).value=value===-Infinity?-60:value;engine.updateGains();},
  trackDb(input,i){const value=parseDb(input.value,6);state.tracks[i].volume=value;input.value=formatDb(value);document.querySelector(`[data-track-volume="${i}"]`).value=value===-Infinity?-60:value;engine.updateGains();}
};
const trackInputs={
  trackEq(input,i){const band=Number(input.dataset.band);state.tracks[i].eq[band]=sliderDb(input.value);$(`eq-value-${i}-${band}`).value=formatDb(state.tracks[i].eq[band]);engine.updateGains();},
  trackVolume(input,i){state.tracks[i].volume=sliderDb(input.value);document.querySelector(`[data-track-db="${i}"]`).value=formatDb(state.tracks[i].volume);engine.updateGains();}
};
function setTrackPitch(input,i,type){
  const value=Number(input.value);if(!Number.isFinite(value))throw Error('ピッチを数値で入力してください');
  state.tracks[i][type]=clamp(Math.round(value),type==='pitch'?-12:-50,type==='pitch'?12:50);input.value=state.tracks[i][type];queuePitch(i);
}
function delegate(type,handlers,selector){
  $('sequence').addEventListener(type,event=>{
    const element=event.target.closest(selector);if(!element||element.disabled)return;
    const key=Object.keys(handlers).find(k=>k in element.dataset);if(key)guarded(handlers[key])(element,Number(element.dataset[key]));
  });
}
delegate('click',trackClicks,'button');delegate('change',trackChanges,'input,select');delegate('input',trackInputs,'input[type=range]');
function drawMini(index){const canvas=$(`track-wave-${index}`),ctx=canvas.getContext('2d'),width=canvas.width=240,height=canvas.height=70;ctx.clearRect(0,0,width,height);const buffer=state.buffers[index];if(!buffer)return;const data=buffer.getChannelData(0);ctx.strokeStyle='#65d4c0';ctx.beginPath();for(let x=0;x<width;x++){const a=Math.floor(x/width*data.length),b=Math.floor((x+1)/width*data.length);let max=0;for(let j=a;j<b;j++)max=Math.max(max,Math.abs(data[j]));ctx.moveTo(x,height/2-max*height*.44);ctx.lineTo(x,height/2+max*height*.44);}ctx.stroke();}
async function previewTrack(index){
  const stopped=engine.stopVersion,generation=state.generation;await flushPitch();await initAudio();if(stopped!==engine.stopVersion||generation!==state.generation||!state.buffers[index])return;const key=`track-${index}`;if(engine.preview.has(key)){engine.stopPreview(key);return;}
  const voice=await engine.playPreview(key,state.buffers[index],engine.graphs[index].input,state.tracks[index].previewLoop,0,index);if(voice)document.querySelectorAll(`[data-track-play="${index}"]`).forEach(b=>b.classList.add('active'));
}
const pendingPitch=new Map();
function launchTrackBuild(index,version,epoch,pitchChange){
  const promise=trackBuffer(index).then(buffer=>{
    if(version!==pitchVersions[index]||epoch!==state.pitchEpoch)return;
    applyTrackBuffer(index,buffer);
    status(pitchChange?`トラック${index+1}のピッチを更新しました（長さを維持）`:`トラック${index+1}の同期長を更新しました`);
  }).finally(()=>{if(pendingPitch.get(index)===promise)pendingPitch.delete(index);});
  pendingPitch.set(index,promise);return promise;
}
function queuePitch(index,pitchChange=true){
  if(!state.committed||index>=state.count)return;
  clearTimeout(pitchTimers[index]);const version=++pitchVersions[index],epoch=state.pitchEpoch;
  if(!pitchChange){const output=document.querySelector(`[data-sync-length="${index}"]`);if(output)output.textContent='同期長を更新中…';}
  pitchTimers[index]=setTimeout(()=>{pitchTimers[index]=null;launchTrackBuild(index,version,epoch,pitchChange).catch(failure);},60);
}
async function flushPitch(){
  do{
    for(let i=0;i<pitchTimers.length;i++)if(pitchTimers[i]){clearTimeout(pitchTimers[i]);pitchTimers[i]=null;launchTrackBuild(i,++pitchVersions[i],state.pitchEpoch,false);}
    await Promise.all([...pendingPitch.values()]);
  }while(pendingPitch.size||pitchTimers.some(Boolean));
}
function parseDb(text,max){text=text.trim().replace('−','-');if(!text||text==='-∞'||text==='-Infinity')return -Infinity;const n=Number(text);if(!Number.isFinite(n))throw Error('dBには数値または -∞ を入力してください');return n<=-60?-Infinity:clamp(n,-60,max);}
let sequenceRequest=0,sequencePending=false;
async function startSequence(){
  if(state.busy||!state.committed)return;
  const request=++sequenceRequest;
  if(engine.playing||sequencePending){sequencePending=false;engine.stop(false);$('seq-play').textContent='▶ 再生';return;}
  let stopped=engine.stopVersion;const generation=state.generation;
  const valid=()=>request===sequenceRequest&&stopped===engine.stopVersion&&generation===state.generation&&!state.busy&&state.committed;
  sequencePending=true;$('seq-play').textContent='準備中…';
  try{
    const boundary=flushBoundary();stopped=engine.stopVersion;await boundary;if(!valid())return;
    await flushPitch();if(!valid())return;
    await initAudio();if(!valid())return;
    await flushPitch();if(!valid())return;
    engine.configure(state.tracks,state.settings,state.buffers,state.count);
    padPlaybackVersion++;engine.stopPreviews();engine.start(timing(),state.loop);
    status(`${steps()}/${state.resolution}拍子で再生中 · ${state.bpm} BPM`);
  }finally{if(request===sequenceRequest){sequencePending=false;$('seq-play').textContent='▶ 再生';}}
}
function stopSequence(){sequenceRequest++;sequencePending=false;padPlaybackVersion++;sourceSeekVersion++;engine.stopAll();$('seq-play').textContent='▶ 再生';}
const CLIP_WARNING='0 dBFS超過があります。マスターを下げて再出力してください。';
const hasNotes=track=>track.steps.slice(0,state.lengthTicks).some(Boolean);
// Stems are exactly the tracks heard in the mix, so the stems sum to the mix.
function stemPlan(tracks,count){
  const included=[],excluded=[];
  for(let i=0;i<count;i++){
    const t=tracks[i],name=`TRACK ${String(i+1).padStart(2,'0')}`;
    if(!state.buffers[i]||!hasNotes(t))continue;
    if(activeTrack(t,tracks,count))included.push(i);
    else excluded.push(`${name}は${t.mute?'ミュート':'ソロ対象外'}のため除外`);
  }
  return {included,excluded};
}
async function exportSequence(){
  busy(true);status('パターン1周分をレンダリングしています…');
  try{
    await flushBoundary();await flushPitch();
    const snapshot={tracks:structuredClone(state.tracks),buffers:[...state.buffers],count:state.count,settings:{...state.settings},timing:timing(),masterDb:engine.masterDb,rate:state.rate,loop:state.loop};
    const format=$('export-format').value,mono=$('export-channels').value==='1',name=`future-funk-${snapshot.timing.bpm}bpm-${steps()}steps`;
    const finish=channels=>mono?monoChannels(channels):channels,overs=channels=>channels.some(c=>c.some(x=>Math.abs(x)>1));
    if($('export-target').value==='stems'){
      const {included,excluded}=stemPlan(snapshot.tracks,snapshot.count);
      if(!included.length)throw Error('書き出すトラックがありません');
      const files=[];let clipped=false;
      for(const [n,i] of included.entries()){
        status(`トラック別に書き出しています… ${n+1}/${included.length}`);
        const channels=finish(await renderPattern(snapshot,{only:i}));clipped||=overs(channels);
        const file=await encodeAudio(channels,format);files.push({name:`track${String(i+1).padStart(2,'0')}.${file.ext}`,data:file.data});
      }
      download(zipStore(files),`${name}-stems.zip`,'application/zip');
      const note=excluded.length?`（${excluded.join('、')}）`:'';
      status(clipped?`トラック別に書き出しました。${CLIP_WARNING}`:`トラック別に書き出しました · ${included.length}本${note}`);
      return;
    }
    const channels=finish(await renderPattern(snapshot)),clipped=overs(channels);
    await saveAudio(channels,format,name);
    status(clipped?`書き出しました。${CLIP_WARNING}`:'書き出しました · パターン1周分（再生と共通のループ境界）');
  }finally{busy(false);}
}
// A project file holds settings only; the source song is chosen again on open.
// Autosave keeps the source file itself in the browser, unconverted.
const appVersion=typeof APP_VERSION==='string'?APP_VERSION:'dev';
let autosaveAudioId=0,autosaveWrittenAudio=0,autosaveJson='',autosaveBusy=false,autosaveFailed=false,lastFileJson=null,pendingProject=null,cleanJson=null;
function markSourceChanged(){autosaveAudioId++;}
function projectState(){
  const file=state.sourceFile;
  return {appVersion,sourceKind:file.kind,sourceName:file.name,sourceBytes:file.bytes,sourceCrc:file.crc,rate:state.rate,frames:state.original[0].length,sourceBpm:state.sourceBpm,bpmNote:$('bpm-confidence').textContent,bpm:state.bpm,followsSource:tempoFollowsSource,range:state.range,committed:state.committed,points:state.points,count:state.count,snap:state.snap,sourceLoop:state.sourceLoop,loopBeats:loopBeatsOverride,lengthTicks:state.lengthTicks,resolution:state.resolution,swing:state.swing,loop:state.loop,settings:state.settings,tracks:state.tracks,parts:state.parts,masterDb:engine.masterDb,exportChannels:Number($('export-channels').value),exportFormat:$('export-format').value};
}
function projectJson(){return state.original&&state.sourceFile?JSON.stringify(serializeProject(projectState())):null;}
// Settings when the work was last loaded, opened, restored or saved; replacing asks first if they changed.
function markClean(){cleanJson=projectJson();}
const hasUnsavedWork=()=>!!state.original&&projectJson()!==cleanJson;
let replaceAnswer=null;
function answerReplace(value){$('replace-confirm').classList.add('hidden');const answer=replaceAnswer;replaceAnswer=null;answer?.(value);}
// Resolves true when the current work may be replaced. Never uses window.confirm, which blocks the page.
async function confirmReplace(){
  if(!hasUnsavedWork())return true;
  answerReplace(false);$('replace-confirm').classList.remove('hidden');$('replace-yes').focus();status('今の作業には未保存の変更があります。置き換えるか選んでください');
  const answer=await new Promise(resolve=>replaceAnswer=resolve);
  if(answer==='save')saveProject();
  if(!answer)status('置き換えをやめました');
  return !!answer;
}
$('replace-save').addEventListener('click',()=>answerReplace('save'));$('replace-yes').addEventListener('click',()=>answerReplace('replace'));$('replace-no').addEventListener('click',()=>answerReplace(false));
function updateDirty(json=projectJson()){$('project-dirty').textContent=json&&json!==lastFileJson?'未保存の変更あり':'';}
function saveProject(){
  if(!state.original||!state.sourceFile||state.busy)return;
  const name=projectFileName(state.sourceFile.name),file=state.sourceFile;
  download(JSON.stringify(serializeProject(projectState(),new Date().toISOString()),null,2),name,'application/json');
  // A recording exists only in this page, so its original bytes are saved beside the project.
  if(file.kind==='recording')download(file.blob,file.name,file.blob.type);
  lastFileJson=projectJson();cleanJson=lastFileJson;updateDirty(lastFileJson);
  status(file.kind==='recording'?`プロジェクトを保存しました · ${name} と録音 ${file.name}（2つを同じ場所に置いてください）`:`プロジェクトを保存しました · ${name}`);
}
function syncControlsFromState(project){
  $('global-bpm').value=state.bpm;$('source-bpm').value=state.sourceBpm;$('sequence-bpm').textContent=state.bpm;$('bpm-confidence').textContent=project.bpmNote;
  if(loopBeatsOverride!=null)$('loop-beats').value=loopBeatsOverride;
  $('chop-count').value=state.count;$('snap').checked=state.snap;$('source-loop').setAttribute('aria-pressed',state.sourceLoop);$('seq-loop').setAttribute('aria-pressed',state.loop);
  $('swing').value=state.swing;renderGridControls();
  $('eq-low').value=state.settings.low;$('eq-high').value=state.settings.high;$('eq-slope').value=state.settings.slope;
  $('master').value=engine.masterDb===-Infinity?-60:engine.masterDb;$('master-number').value=formatDb(engine.masterDb);
  $('export-channels').value=String(project.exportChannels);$('export-format').value=project.exportFormat;
  document.querySelectorAll('[data-filter]').forEach(input=>{const filter=state.parts[Number(input.dataset.part)][input.dataset.filter];if(input.dataset.param==='on')input.checked=filter.on;else input.value=filter[input.dataset.param];});
  updatePatternLength();
}
async function restoreProject(project,channels,sourceFile){
  if(channels[0].length!==project.frames)throw Error('元の曲の長さがプロジェクトと一致しません');
  await initAudio();resetSource();hideAutosaveBanner();hideSourcePrompt();busy(true);status('プロジェクトを読み込んでいます…');
  try{
    state.original=channels;state.sourceFile=sourceFile;state.sourceName=sourceFile.name;$('source-name').textContent=sourceFile.name;markSourceChanged();
    state.sourceBpm=project.sourceBpm;state.bpm=project.bpm;tempoFollowsSource=project.followsSource;loopBeatsOverride=project.loopBeats;
    Object.assign(state,{range:[...project.range],committed:project.committed&&[...project.committed],points:[...project.points],count:project.count,snap:project.snap,sourceLoop:project.sourceLoop,lengthTicks:project.lengthTicks,resolution:project.resolution,swing:project.swing,loop:project.loop,settings:{...project.settings},tracks:project.tracks});
    project.parts.forEach((part,i)=>{state.parts[i].hp={...part.hp};state.parts[i].lp={...part.lp};});
    engine.setMaster(project.masterDb);syncControlsFromState(project);
    // rebuildSource also rebuilds every chop because committed is already set.
    await rebuildSource();if(!state.committed)renderTracks();markClean();
    status(`プロジェクトを読み込みました · ${sourceFile.name} · ${state.bpm} BPM`);
  }finally{busy(false);}
}
// Decodes the chosen song after it matches the project, the same way it was first loaded.
async function restoreWithSource(project,file){
  if(project.sourceKind==='demo'){await initAudio();return restoreProject(project,demoChannels(state.rate),{kind:'demo',name:project.sourceName,blob:null,bytes:null,crc:null});}
  const bytes=new Uint8Array(await file.arrayBuffer());checkSource(project,bytes);
  await initAudio();const channels=await decodeSource(bytes.buffer);
  await restoreProject(project,channels,{kind:project.sourceKind,name:file.name||project.sourceName,blob:file,bytes:project.sourceBytes,crc:project.sourceCrc});
}
function hideSourcePrompt(){pendingProject=null;$('project-source').classList.add('hidden');}
async function openProject(files){
  files=[...files];$('project-file').value='';if(!files.length)return;
  const jsonFile=files.find(f=>/\.json$/i.test(f.name)||f.type==='application/json');
  if(!jsonFile)throw Error('プロジェクトファイル（.json）を選んでください');
  let project;try{project=parseProject(JSON.parse(await jsonFile.text()));}catch(error){throw Error(`プロジェクトを読み込めませんでした：${error.message}`);}
  const audio=files.find(f=>f!==jsonFile);
  if(!await confirmReplace())return;
  if(project.sourceKind!=='demo'&&!audio){
    pendingProject=project;$('project-source-text').textContent=`元の曲「${project.sourceName}」を選んでください`;$('project-source').classList.remove('hidden');
    status(`プロジェクトを開くには、元の曲「${project.sourceName}」を選んでください`);return;
  }
  await restoreWithSource(project,audio);lastFileJson=projectJson();updateDirty(lastFileJson);
}
async function autosaveTick(){
  updateDirty();
  if(!state.original||!state.sourceFile||state.busy||autosaveBusy||autosaveFailed)return;
  autosaveBusy=true;
  try{
    if(autosaveWrittenAudio!==autosaveAudioId){const id=autosaveAudioId,{kind,name,blob,bytes,crc}=state.sourceFile;await autosave.put('audio',{id,kind,name,blob,bytes,crc});autosaveWrittenAudio=id;autosaveJson='';}
    const json=projectJson();
    if(json&&autosaveWrittenAudio===autosaveAudioId&&json!==autosaveJson){await autosave.put('session',{audioId:autosaveWrittenAudio,savedAt:new Date().toISOString(),name:state.sourceFile.name,json});autosaveJson=json;}
  }catch(error){autosaveFailed=true;console.error(error);status('自動保存を停止しました（ブラウザの保存領域を利用できません）。「プロジェクトを保存」は引き続き使えます。',true);}
  finally{autosaveBusy=false;}
}
function hideAutosaveBanner(){$('autosave-banner').classList.add('hidden');}
async function readAutosave(){
  const session=await autosave.get('session');if(!session)return null;
  const audio=await autosave.get('audio');return audio&&audio.id===session.audioId?{session,audio}:null;
}
async function offerAutosave(){
  let saved;try{saved=await readAutosave();}catch{return;}
  if(!saved||state.original)return;
  const time=new Date(saved.session.savedAt).toLocaleString('ja-JP',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
  $('autosave-text').textContent=`前回の作業を復元できます（${saved.session.name} · ${time}）`;$('autosave-banner').classList.remove('hidden');
}
async function discardAutosave(){
  hideAutosaveBanner();autosaveJson='';
  try{await autosave.clear();}catch(error){console.error(error);}
}
bind('autosave-restore','click',async()=>{
  const saved=await readAutosave();if(!saved){hideAutosaveBanner();throw Error('自動保存のデータが見つかりません');}
  const {kind,name,blob,bytes,crc}=saved.audio;
  try{
    const project=parseProject(JSON.parse(saved.session.json));
    if(kind==='demo'){await restoreWithSource(project,null);}
    else{await initAudio();await restoreProject(project,await decodeSource(await blob.arrayBuffer()),{kind,name,blob,bytes,crc});}
  }catch(error){throw Error(`自動保存から復元できませんでした：${error.message}`);}
  // The stored audio is already this source; skip rewriting it.
  autosaveWrittenAudio=autosaveAudioId;autosaveJson=saved.session.json;updateDirty();
});
bind('autosave-discard','click',async()=>{await discardAutosave();status('自動保存を破棄しました');});
bind('project-save','click',saveProject);
// Open pickers synchronously so the click keeps its user activation.
$('project-open').addEventListener('click',()=>$('project-file').click());
$('project-source-pick').addEventListener('click',()=>$('project-source-file').click());
bind('project-file','change',event=>openProject(event.target.files));
bind('project-source-file','change',async event=>{
  const file=event.target.files[0];$('project-source-file').value='';if(!file||!pendingProject)return;
  await restoreWithSource(pendingProject,file);lastFileJson=projectJson();updateDirty(lastFileJson);
});
bind('project-source-cancel','click',()=>{hideSourcePrompt();status('プロジェクトを開くのをやめました');});
document.addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&!event.altKey&&!event.shiftKey&&event.key.toLowerCase()==='s'){event.preventDefault();guarded(saveProject)();}});
// Space plays and stops from anywhere but text fields and menus. On a focused button it does
// not press the button (Enter still does), so toggling a step and then Space never retoggles it.
const typesText=element=>element.isContentEditable||['SELECT','TEXTAREA'].includes(element.tagName)||element.tagName==='INPUT'&&element.type!=='range';
const transportSpace=event=>event.code==='Space'&&!event.metaKey&&!event.ctrlKey&&!event.altKey&&!typesText(event.target);
document.addEventListener('keydown',event=>{
  // The source waveform handles Space itself, as it did before.
  if(!transportSpace(event)||event.defaultPrevented)return;
  event.preventDefault();if(event.repeat)return;
  if(state.committed)guarded(startSequence)();else if(state.channels)guarded(toggleSource)();
});
document.addEventListener('keyup',event=>{if(transportSpace(event))event.preventDefault();});

async function chooseSource(file){if(file&&await confirmReplace())await loadFile(file);}
bind('source-file','change',async event=>{const file=event.target.files[0];$('source-file').value='';await chooseSource(file);});
// Dropping files anywhere does what choosing them in the pickers does.
const isProjectFile=f=>/\.json$/i.test(f.name)||f.type==='application/json';
const isAudioFile=f=>f.type.startsWith('audio/')||/\.(wav|aif|aiff|aifc|mp3|m4a|aac|flac|ogg|opus|webm)$/i.test(f.name);
async function dropFiles(files){
  if(state.recording)throw Error('録音中は読み込めません。録音を停止してからドロップしてください');
  if(state.busy)throw Error('処理中は読み込めません。終わってからドロップしてください');
  const projects=files.filter(isProjectFile),songs=files.filter(f=>!isProjectFile(f)&&isAudioFile(f));
  if(projects.length+songs.length!==files.length||!files.length)throw Error('曲かプロジェクト（.json）をドロップしてください');
  if(projects.length>1)throw Error('プロジェクト（.json）は1つずつドロップしてください');
  if(songs.length>1)throw Error('曲は1つずつドロップしてください');
  if(projects.length)return openProject(files);
  if(pendingProject){await restoreWithSource(pendingProject,songs[0]);lastFileJson=projectJson();updateDirty(lastFileJson);return;}
  await chooseSource(songs[0]);
}
let dragDepth=0;
const carriesFiles=event=>[...(event.dataTransfer?.types||[])].includes('Files');
const hideDrop=()=>{dragDepth=0;$('drop-overlay').classList.add('hidden');};
document.addEventListener('dragenter',event=>{if(!carriesFiles(event))return;event.preventDefault();dragDepth++;$('drop-overlay').classList.remove('hidden');});
document.addEventListener('dragover',event=>{if(!carriesFiles(event))return;event.preventDefault();event.dataTransfer.dropEffect='copy';});
document.addEventListener('dragleave',event=>{if(!carriesFiles(event))return;if(--dragDepth<=0)hideDrop();});
document.addEventListener('drop',event=>{if(!carriesFiles(event))return;event.preventDefault();hideDrop();guarded(dropFiles)([...event.dataTransfer.files]);});
bind('source-delete','click',async()=>{resetSource();await discardAutosave();status('音源と関連するチョップ・パターンを削除しました');});
bind('source-play','click',toggleSource);$('source-play').dataset.preview='source';
bind('source-range-play','click',()=>engine.preview.get('source')?.sourceMode==='range'?stopSource():playSourceAt(0,'range'));$('source-range-play').dataset.preview='source';
bind('source-stop','click',stopSource);
bind('source-loop','click',()=>{state.sourceLoop=!state.sourceLoop;$('source-loop').setAttribute('aria-pressed',state.sourceLoop);const v=engine.preview.get('source');if(v?.sourceMode==='range')v.source.loop=v.loop=state.sourceLoop;});
numeric('global-bpm',30,300,async value=>{
  const before=state.bpm,followed=tempoFollowsSource;
  tempoFollowsSource=false;state.bpm=value;$('sequence-bpm').textContent=value;updatePatternLength();
  try{await rebuildSource();}catch(error){tempoFollowsSource=followed;state.bpm=before;$('global-bpm').value=before;$('sequence-bpm').textContent=before;await rebuildSource();throw error;}
});
async function updateSourceBpm(value){
  const before=state.sourceBpm,beforeTarget=state.bpm;state.sourceBpm=value;$('source-bpm').value=value;$('bpm-confidence').textContent='手動設定';
  if(tempoFollowsSource){state.bpm=value;$('global-bpm').value=value;$('sequence-bpm').textContent=value;}
  try{await rebuildSource();}catch(error){state.sourceBpm=before;state.bpm=beforeTarget;$('source-bpm').value=before;$('global-bpm').value=beforeTarget;$('sequence-bpm').textContent=beforeTarget;await rebuildSource();throw error;}
}
numeric('source-bpm',30,300,updateSourceBpm);
bind('loop-beats','change',()=>{const value=Number($('loop-beats').value);if(!Number.isFinite(value)||value<.5||value>4096)throw Error('拍数は0.5〜4096で指定してください');loopBeatsOverride=value;});
bind('calibrate-loop-bpm','click',async()=>{
  if(!state.original||state.busy)return;
  const beats=Number($('loop-beats').value),bpm=sourceBpmFromLoop(state.original[0].length/state.rate,state.range,beats);
  loopBeatsOverride=beats;await updateSourceBpm(bpm);
  $('bpm-confidence').textContent=`選択範囲の${beats}拍から算出`;
  status(`選択範囲の${beats}拍から原曲BPMを ${bpm} に合わせました。`);
});
function updatePatternLength(){ $('pattern-length').textContent=`1ステップ ${gridSeconds(state.bpm,state.resolution).toFixed(3)} s / 1周 ${patternSeconds(state.bpm,state.lengthTicks).toFixed(3)} s`; }
for(const id of ['range-start','range-end'])bind(id,'change',()=>{if(!state.channels)return;const a=Number($('range-start').value),b=Number($('range-end').value);if(!Number.isFinite(a)||!Number.isFinite(b)||a<0||b>duration()+.0005||b-a<.001){updateRangeFields();throw Error('開始 < 終了となる音源内の範囲を指定してください');}state.range=[a/duration(),Math.min(b/duration(),1)];updateRangeFields();});
function hideEndpointMenu(){ $('source-endpoint-menu').classList.add('hidden'); }
function setSourceTool(tool){
  hideEndpointMenu();sourceWave.setTool(tool);
  for(const name of ['select','pan','start','end'])$('source-tool-'+name).setAttribute('aria-pressed',tool===name);
  if(tool==='start'||tool==='end')status(`波形上で${tool==='start'?'始点':'終点'}にしたい位置をクリックしてください。画面外のマーカーを探す必要はありません。`);
}
function setSourceEndpoint(index,time){
  if(!state.channels||state.busy)return;
  const d=duration(),minimum=Math.max(.001,1/state.rate),range=state.range.map(t=>t*d);
  time=Math.round(clamp(time,0,d)*state.rate)/state.rate;
  if(index===0){range[0]=clamp(time,0,d-minimum);if(range[1]-range[0]<minimum)range[1]=d;}
  else{range[1]=clamp(time,minimum,d);if(range[1]-range[0]<minimum)range[0]=0;}
  if(engine.preview.get('source')?.sourceMode==='range')stopSource();
  state.range=range.map(t=>t/d);updateRangeFields();setSourceTool('select');$('source-wave').focus();
  status(`${index===0?'始点':'終点'}を ${formatTime(range[index])} に設定しました。`);
}
for(const tool of ['select','pan','start','end'])bind('source-tool-'+tool,'click',()=>setSourceTool(tool));
$('source-wave').addEventListener('contextmenu',event=>{
  if(!state.channels||state.busy)return;
  event.preventDefault();
  endpointMenuTime=sourceWave.timeAt(event.clientX-$('source-wave').getBoundingClientRect().left);
  const menu=$('source-endpoint-menu');menu.classList.remove('hidden');
  $('source-endpoint-menu-time').textContent=formatTime(endpointMenuTime);
  menu.style.left=Math.max(4,Math.min(event.clientX,window.innerWidth-menu.offsetWidth-8))+'px';
  menu.style.top=Math.max(4,Math.min(event.clientY,window.innerHeight-menu.offsetHeight-8))+'px';
  $('source-menu-start').focus();
});
bind('source-menu-start','click',()=>setSourceEndpoint(0,endpointMenuTime));
bind('source-menu-end','click',()=>setSourceEndpoint(1,endpointMenuTime));
document.addEventListener('pointerdown',event=>{if(!$('source-endpoint-menu').contains(event.target))hideEndpointMenu();});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!$('source-endpoint-menu').classList.contains('hidden')){event.preventDefault();hideEndpointMenu();$('source-wave').focus();}});
$('source-endpoint-menu').addEventListener('keydown',event=>{if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();(document.activeElement===$('source-menu-start')?$('source-menu-end'):$('source-menu-start')).focus();}});
bind('zoom','input',()=>{sourceWave.setZoom(Number($('zoom').value));$('zoom-value').textContent='×'+sourceWave.zoom;$('wave-scroll').max=1-1/sourceWave.zoom;$('wave-scroll').value=sourceWave.scroll;$('wave-scroll').disabled=sourceWave.zoom===1;});
bind('wave-scroll','input',()=>sourceWave.setScroll(Number($('wave-scroll').value)));sourceWave.onScroll=value=>{$('wave-scroll').value=value;hideEndpointMenu();};
bind('sample','click',sample);
bind('chop-count','change',async()=>{const count=Number($('chop-count').value);if(state.committed&&(state.committed[1]-state.committed[0])*duration()<count*.001)throw Error('範囲が短すぎます');state.count=count;if(!state.committed)return;state.points=boundaries(...state.committed,state.count);quantizeChops();busy(true);try{await rebuildChops();status('分割数を変更しました。分割位置を等分割に戻しました。空きトラックの設定とパターンは保持します。');}finally{busy(false);}});
bind('snap','change',async()=>{
  state.snap=$('snap').checked;
  if(state.snap&&state.committed){busy(true);try{quantizeChops();await rebuildChops({preservePad:true});}finally{busy(false);}}
  status(state.snap?`選択範囲の始点を拍頭として、${state.resolution}分音符のグリッドに分割位置を揃えました`:'分割位置の吸着を解除しました');
});
bind('seq-play','click',startSequence);bind('seq-stop','click',()=>{stopSequence();status('再生を停止しました');});bind('seq-rewind','click',()=>{const playing=engine.playing;engine.stop();if(playing)engine.start(timing(),state.loop);});
bind('seq-loop','click',()=>{state.loop=!state.loop;engine.setLoop(state.loop);$('seq-loop').setAttribute('aria-pressed',state.loop);});
// Pattern length is ½/1/2/4 bars in both grids; the grid changes the step size only.
const barsLabel=ticks=>ticks===8?'½小節':`${ticks/16}小節`;
function renderGridControls(){
  $('step-buttons').innerHTML=PATTERN_TICKS.map(ticks=>`<button data-ticks="${ticks}" data-steps="${displaySteps(ticks,state.resolution)}" class="${ticks===state.lengthTicks?'active':''}">${displaySteps(ticks,state.resolution)}<small>${barsLabel(ticks)}</small></button>`).join('');
  for(const resolution of [8,16])$(`grid-${resolution}`).setAttribute('aria-pressed',state.resolution===resolution);
  $('signature').textContent=`${steps()}/${state.resolution}`;$('step-unit').textContent=`${state.resolution}分`;
}
$('step-buttons').addEventListener('click',event=>{
  const button=event.target.closest('[data-ticks]');if(!button)return;
  engine.stop();state.lengthTicks=Number(button.dataset.ticks);renderGridControls();renderTracks();queueSync();
  status(`${steps()}/${state.resolution}拍子 · 1周 ${patternSeconds(state.bpm,state.lengthTicks).toFixed(3)}秒。非表示のステップは保持します。`);
});
async function setResolution(resolution){
  if(resolution===state.resolution)return;
  engine.stop();$('grid-confirm').classList.add('hidden');
  if(resolution===8)state.tracks.forEach(t=>t.steps.forEach((_,i)=>{if(i%2)t.steps[i]=false;}));
  state.resolution=resolution;renderGridControls();renderTracks();queueSync();
  if(state.snap&&state.committed){busy(true);try{quantizeChops();await rebuildChops({preservePad:true});}finally{busy(false);}}
  status(`グリッドを${resolution}分音符にしました · ${steps()}ステップ`);
}
bind('grid-16','click',()=>setResolution(16));
bind('grid-8','click',()=>{
  if(state.resolution===8)return;
  const count=offbeatTicks(state.tracks);
  if(!count)return setResolution(8);
  $('grid-confirm-text').textContent=`16分の裏にあるノート ${count} 個が消えます`;$('grid-confirm').classList.remove('hidden');
});
bind('grid-confirm-yes','click',()=>setResolution(8));
bind('grid-confirm-no','click',()=>$('grid-confirm').classList.add('hidden'));
numeric('swing',50,75,value=>{
  state.swing=Math.round(value);$('swing').value=state.swing;
  // The cycle length is unchanged, so only the playing pattern buffers need rebuilding.
  if(engine.playing){engine.timing=timing();for(let i=0;i<state.count;i++)engine.refreshPatternTrack(i);}
});
for(const [id,key,min,max] of [['eq-low','low',200,500],['eq-high','high',2000,4000]])numeric(id,min,max,value=>{state.settings[key]=value;engine.rebuildEQ();});
bind('eq-slope','change',()=>{state.settings.slope=Number($('eq-slope').value);engine.rebuildEQ();});
bind('master','input',()=>{const db=sliderDb($('master').value);$('master-number').value=formatDb(db);engine.setMaster(db);});
bind('master-number','change',()=>{const db=parseDb($('master-number').value,6);$('master').value=db===-Infinity?-60:db;$('master-number').value=formatDb(db);engine.setMaster(db);});
bind('clip-reset','click',()=>{engine.clip=[false,false];engine.peak=[-Infinity,-Infinity];});bind('export','click',exportSequence);
let recorder,recordStream,recordChunks=[];
bind('record','click',async()=>{
  if(!navigator.mediaDevices?.getUserMedia)throw Error('マイク録音にはlocalhostまたはHTTPSと、対応ブラウザが必要です');
  if(!await confirmReplace())return;
  await initAudio();engine.stopAll();
  try{
    recordStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false},video:false});
    const mime=['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus'].find(m=>MediaRecorder.isTypeSupported(m));recorder=new MediaRecorder(recordStream,mime?{mimeType:mime}:{});recordChunks=[];
    recorder.ondataavailable=event=>{if(event.data.size)recordChunks.push(event.data);};
    recorder.onstop=()=>{recordStream.getTracks().forEach(t=>t.stop());state.recording=false;$('record').classList.remove('recording');refreshAvailability();guarded(async()=>{const blob=new Blob(recordChunks,{type:recorder.mimeType}),ext=/mp4/.test(blob.type)?'m4a':/ogg/.test(blob.type)?'ogg':'webm';await loadFile(new File([blob],'microphone-'+new Date().toISOString().replaceAll(':','-')+'.'+ext,{type:blob.type}),true);})()};
    recorder.onerror=()=>{recordStream.getTracks().forEach(t=>t.stop());state.recording=false;refreshAvailability();status('マイク録音に失敗しました',true);};
    recorder.start(250);state.recording=true;$('record').classList.add('recording');refreshAvailability();status('マイク録音中…停止ボタンで確定します');
  }catch(error){recordStream?.getTracks().forEach(t=>t.stop());throw Error('マイクを開始できませんでした。ブラウザのマイク権限を確認してください。'+error.message);}
});
bind('record-stop','click',()=>{if(recorder?.state==='recording')recorder.stop();});
bind('record-save','click',()=>{if(!state.recorded)return;const name=$('record-name').textContent.split(' · ')[0].replace(/\.[^.]+$/,'')+'.wav';download(encodeWav(state.recorded,state.rate),name,'audio/wav');$('record-name').textContent=name+' · 保存を要求しました';status('録音WAVのダウンロードを開始しました');});
// Deterministic, so a demo project can be reopened without a source file.
function demoChannels(rate){
  const length=rate*8,channels=[new Float32Array(length),new Float32Array(length)];
  let seed=12345;const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296*2-1;};
  const chords=[[130.81,164.81,196,246.94],[146.83,174.61,220,261.63],[123.47,155.56,185,233.08],[130.81,164.81,196,246.94]];
  for(let i=0;i<length;i++){const t=i/rate,beat=t%.5,bar=Math.floor(t/2)%4,noise=random();const kick=Math.sin(2*Math.PI*(48*beat+5*(1-Math.exp(-35*beat))))*Math.exp(-beat*24)*.4;const hh=noise*Math.exp(-(t%.25)*140)*.055;const snare=Math.floor(t/.5)%2?noise*Math.exp(-beat*32)*.12:0;
    channels.forEach((c,ch)=>{let chord=0;for(const f of chords[bar])chord+=Math.sin(2*Math.PI*f*t+ch*.06)*.027;const bass=Math.sin(2*Math.PI*chords[bar][0]/2*t)*.10*Math.exp(-beat*3);c[i]=kick+hh+snare+bass+chord*(.75+.25*Math.sin(t*4));});}
  return channels;
}
bind('demo','click',async()=>{
  if(!await confirmReplace())return;
  await initAudio();const name='Future Funk Lab · Demo 120 BPM.wav';
  await setSource(demoChannels(state.rate),name,{knownBpm:120,file:{kind:'demo',name,blob:null,bytes:null,crc:null}});
});
const masterResize=new ResizeObserver(()=>document.documentElement.style.setProperty('--master-height',`${$('master-strip').getBoundingClientRect().height}px`));masterResize.observe($('master-strip'));
buildParts();renderGridControls();renderTracks();drawSource();drawParts();refreshAvailability();offerAutosave();setInterval(autosaveTick,2000);
let lastFrame=0;
function animate(time){
  updateChopPlayback();
  if(time-lastFrame>65){lastFrame=time;const db=engine.meter();['l','r'].forEach((key,i)=>{$(`meter-${key}`).style.width=clamp((db[i]+60)/66*100,0,100)+'%';$(`peak-${key}`).textContent=formatDb(engine.peak[i])+' dBFS';});$('clip-reset').classList.toggle('clipped',engine.clip.some(Boolean));
    for(let i=0;i<2;i++){const voice=engine.preview.get(`part-${i}`);if(voice&&!voice.stopped){const pos=clamp(engine.context.currentTime-voice.origin,0,duration());partWaves[i].cursor=pos;partWaves[i].draw();$(`part-time-${i}`).textContent=`${formatTime(pos)} / ${formatTime(duration())}`;$(`part-seek-${i}`).value=pos/duration();}}
    const voice=engine.preview.get('source');if(voice&&!voice.stopped){sourcePlayhead=sourceVoicePosition(voice);updateSourceCursor();}
  }requestAnimationFrame(animate);
}requestAnimationFrame(animate);
window.addEventListener('pagehide',()=>{recordStream?.getTracks().forEach(t=>t.stop());engine.stopAll();worker.terminate();});
// Read-only diagnostics for integration checks; no audio data leaves this page.
window.futureFunkLab={getState:()=>({chopPlayback:getChopPlayback(),tempoFollowsSource,sourcePlayhead:engine.preview.has('source')?sourceVoicePosition(engine.preview.get('source')):sourcePlayhead,sourcePlaybackMode:engine.preview.get('source')?.sourceMode??null,sourceTool:sourceWave.tool,sourceZoom:sourceWave.zoom,sourceScroll:sourceWave.scroll,bpm:state.bpm,sourceBpm:state.sourceBpm,duration:duration(),count:state.count,steps:steps(),lengthTicks:state.lengthTicks,resolution:state.resolution,swing:state.swing,points:[...state.points],range:[...state.range],committed:state.committed?[...state.committed]:null,bufferDurations:state.buffers.map(b=>b.duration),syncSpans:state.buffers.map(b=>b.syncSpan),previewDurations:state.buffers.map(b=>b.chopPreview?.duration),pendingTracks:[...pendingPitch.keys()],busy:state.busy,playing:engine.playing,tracks:structuredClone(state.tracks),view:trackView,selectedTrack:state.selectedTrack}),engine};
