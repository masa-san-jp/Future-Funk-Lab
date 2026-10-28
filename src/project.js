import { clamp, crc32, makeTrack, TICKS, PATTERN_TICKS, RESOLUTIONS } from './core.js';
// A project is settings only. The source song stays a separate file that is
// chosen again on open and matched by size and CRC32; the demo is regenerated.
export const PROJECT_FORMAT='future-funk-lab-project', PROJECT_SCHEMA=3, SOURCE_KINDS=['file','recording','demo'];
const RATE=44100, MAX_SECONDS=600;
const fail=message=>{throw Error(message);};
const dbOut=value=>value===-Infinity?null:value;
const number=(value,label)=>{const n=Number(value);if(value==null||value===''||!Number.isFinite(n))fail(`${label}が数値ではありません`);return n;};
const bounded=(value,min,max,label)=>clamp(number(value,label),min,max);
// null and values at or below the -60 dB slider floor mean −∞, as in the UI.
const dbIn=(value,max,label)=>{if(value==null)return -Infinity;const n=number(value,label);return n<=-60?-Infinity:Math.min(n,max);};
const oneOf=(value,options,fallback)=>options.includes(value)?value:fallback;
const ratio=(value,label)=>bounded(value,0,1,label);
const bools=(values,length)=>Array.from({length},(_,i)=>Array.isArray(values)&&values[i]===true);

// Everything the session needs to rebuild itself; buffers are derived on load.
export function serializeProject(s,savedAt=null){
  const json={
    format:PROJECT_FORMAT,schemaVersion:PROJECT_SCHEMA,appVersion:s.appVersion,savedAt,
    source:{kind:s.sourceKind,name:s.sourceName,bytes:s.sourceBytes,crc32:s.sourceCrc,sampleRate:s.rate,frames:s.frames,bpm:s.sourceBpm,bpmNote:s.bpmNote},
    tempo:{bpm:s.bpm,followsSource:s.followsSource},
    sampling:{range:[...s.range],committed:s.committed?[...s.committed]:null,points:s.committed?[...s.points]:[],count:s.count,snap:s.snap,sourceLoop:s.sourceLoop,loopBeats:s.loopBeats},
    sequence:{lengthTicks:s.lengthTicks,resolution:s.resolution,swing:s.swing,loop:s.loop},
    eq:{low:s.settings.low,high:s.settings.high,slope:s.settings.slope},
    tracks:s.tracks.map(t=>({pitch:t.pitch,cents:t.cents,eq:t.eq.map(dbOut),volume:dbOut(t.volume),mute:t.mute,solo:t.solo,mode:t.mode,previewLoop:t.previewLoop,sync:t.sync,syncSteps:t.syncSteps,steps:t.steps.slice(0,TICKS)})),
    parts:s.parts.map(p=>({hp:{...p.hp},lp:{...p.lp}})),
    master:{db:dbOut(s.masterDb)},
    export:{channels:s.exportChannels,format:s.exportFormat}
  };
  if(savedAt==null)delete json.savedAt;
  return json;
}
// Normalizes every value to the ranges the UI accepts. Throws before any state changes.
export function parseProject(json){
  if(!json||typeof json!=='object'||json.format!==PROJECT_FORMAT)fail('Future Funk Labのプロジェクトではありません');
  if(json.schemaVersion>PROJECT_SCHEMA)fail('新しい版のアプリで保存されたプロジェクトです。アプリを更新してください');
  if(json.schemaVersion!==PROJECT_SCHEMA)fail('対応していない版のプロジェクトです');
  const {source={},tempo={},sampling={},sequence={},eq={},master={}}=json;
  const sourceKind=SOURCE_KINDS.includes(source.kind)?source.kind:fail('元の曲の種類が不正です');
  const sourceBytes=sourceKind==='demo'?null:Number.isInteger(source.bytes)&&source.bytes>0?source.bytes:fail('元の曲のサイズが不正です');
  const sourceCrc=sourceKind==='demo'?null:Number.isInteger(source.crc32)&&source.crc32>=0&&source.crc32<=0xffffffff?source.crc32:fail('元の曲の照合情報が不正です');
  if(source.sampleRate!==RATE)fail('44.1 kHz以外のプロジェクトには対応していません');
  const frames=number(source.frames,'音源の長さ');
  if(!Number.isInteger(frames)||frames<1||frames>RATE*MAX_SECONDS)fail('音源の長さが不正です');
  const count=Math.round(bounded(sampling.count,2,8,'分割数'));
  const range=Array.isArray(sampling.range)&&sampling.range.length===2?sampling.range.map(v=>ratio(v,'範囲')):fail('範囲が不正です');
  if(!(range[0]<range[1]))fail('範囲が不正です');
  let committed=null,points=[];
  if(sampling.committed!=null){
    committed=Array.isArray(sampling.committed)&&sampling.committed.length===2?sampling.committed.map(v=>ratio(v,'確定範囲')):fail('確定範囲が不正です');
    points=Array.isArray(sampling.points)&&sampling.points.length===count+1?sampling.points.map(v=>ratio(v,'分割位置')):fail('分割位置の数が分割数と合いません');
    // boundaries() may round the last point by an ulp; compare ends with a tolerance.
    if(!(committed[0]<committed[1])||Math.abs(points[0]-committed[0])>1e-9||Math.abs(points[count]-committed[1])>1e-9||points.some((p,i)=>i&&p<=points[i-1]))fail('分割位置が不正です');
  }
  if(!Array.isArray(json.tracks)||json.tracks.length!==8)fail('トラックは8個必要です');
  if(!Array.isArray(json.parts)||json.parts.length!==2)fail('音声分離の設定が不正です');
  const tracks=json.tracks.map((t,i)=>{
    if(!t||typeof t!=='object')fail(`トラック${i+1}の設定が不正です`);
    const eqValues=Array.isArray(t.eq)&&t.eq.length===3?t.eq:fail(`トラック${i+1}のEQが不正です`);
    return {...makeTrack(i),pitch:Math.round(bounded(t.pitch,-12,12,'ピッチ')),cents:Math.round(bounded(t.cents,-50,50,'セント')),eq:eqValues.map(v=>dbIn(v,0,'EQ')),volume:dbIn(t.volume,6,'出力'),mute:t.mute===true,solo:t.solo===true,mode:oneOf(t.mode,['overlap','cut'],'overlap'),previewLoop:t.previewLoop===true,sync:oneOf(t.sync,['auto','fixed','original'],'auto'),syncSteps:bounded(t.syncSteps,.25,128,'同期ステップ数'),steps:bools(t.steps,TICKS)};
  });
  const resolution=oneOf(sequence.resolution,RESOLUTIONS,8);
  // An eighth-note grid cannot show odd ticks; drop them as the UI would.
  if(resolution===8)tracks.forEach(t=>t.steps.forEach((_,i)=>{if(i%2)t.steps[i]=false;}));
  const filter=(f,min,max,fallback)=>({on:f?.on===true,freq:f?.freq==null?fallback:bounded(f.freq,min,max,'フィルター周波数'),slope:oneOf(f?.slope,[6,12,24],12)});
  const parts=json.parts.map((p,i)=>({hp:filter(p?.hp,50,2000,200),lp:filter(p?.lp,200,8000,i?250:2000)}));
  return {
    appVersion:json.appVersion,savedAt:json.savedAt??null,
    sourceKind,sourceBytes,sourceCrc,sourceName:typeof source.name==='string'&&source.name?source.name:'project.wav',frames,
    sourceBpm:bounded(source.bpm,30,300,'原曲BPM'),bpmNote:typeof source.bpmNote==='string'?source.bpmNote:'',
    bpm:bounded(tempo.bpm,30,300,'グローバルBPM'),followsSource:tempo.followsSource!==false,
    range,committed,points,count,snap:sampling.snap===true,sourceLoop:sampling.sourceLoop===true,
    loopBeats:sampling.loopBeats==null?null:bounded(sampling.loopBeats,.5,4096,'拍数'),
    lengthTicks:oneOf(sequence.lengthTicks,PATTERN_TICKS,32),resolution,swing:Math.round(bounded(sequence.swing??50,50,75,'スウィング')),loop:sequence.loop!==false,
    settings:{low:bounded(eq.low??300,200,500,'EQ'),high:bounded(eq.high??3000,2000,4000,'EQ'),slope:oneOf(eq.slope,[6,12,24],12)},
    tracks,parts,masterDb:master.db===undefined?0:dbIn(master.db,6,'マスター'),
    exportChannels:oneOf(json.export?.channels,[1,2],2),exportFormat:oneOf(json.export?.format,['wav','mp3'],'wav')
  };
}
// Throws unless the chosen file is the song the project was saved with; the name may differ.
export function checkSource(project,bytes){
  if(bytes.length!==project.sourceBytes||crc32(bytes)!==project.sourceCrc)fail(`選んだファイルは、保存したときの曲と違います。「${project.sourceName}」を選んでください`);
}
export function projectFileName(sourceName){
  const base=(sourceName||'project').replace(/\.[^.]+$/,'').replace(/[\\/:*?"<>|]/g,'_').trim()||'project';
  return `${base}.json`;
}
