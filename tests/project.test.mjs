import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTrack, crc32 } from '../src/core.js';
import { serializeProject, parseProject, checkSource, projectFileName } from '../src/project.js';
const rate=44100,song=new TextEncoder().encode('pretend this is an mp3 file');
function session(overrides={}){
  const tracks=Array.from({length:8},(_,i)=>makeTrack(i));tracks[0].steps[0]=true;tracks[1].eq=[0,-Infinity,-3];tracks[2].volume=-Infinity;tracks[3].pitch=7;
  return {appVersion:'test',sourceKind:'file',sourceName:'loop.mp3',sourceBytes:song.length,sourceCrc:crc32(song),rate,frames:4,sourceBpm:98.5,bpmNote:'手動設定',bpm:120,followsSource:false,range:[.1,.6],committed:[.1,.6],points:[.1,.225,.35,.475,.6],count:4,snap:true,sourceLoop:false,loopBeats:null,lengthTicks:32,resolution:16,swing:62,loop:true,settings:{low:300,high:3000,slope:12},tracks,parts:[{hp:{on:true,freq:200,slope:12},lp:{on:false,freq:2000,slope:12}},{hp:{on:false,freq:200,slope:12},lp:{on:true,freq:250,slope:24}}],masterDb:-Infinity,exportChannels:1,exportFormat:'mp3',...overrides};
}
const roundTrip=json=>parseProject(JSON.parse(JSON.stringify(json)));
test('プロジェクトは設定だけを保存し、読み込みで同じ設定に戻る。−∞はnullで保存する',()=>{
  const json=serializeProject(session(),'2026-10-28T00:00:00.000Z');
  assert.deepEqual(json.source,{kind:'file',name:'loop.mp3',bytes:song.length,crc32:crc32(song),sampleRate:rate,frames:4,bpm:98.5,bpmNote:'手動設定'});
  assert.equal(json.tracks[1].eq[1],null);assert.equal(json.tracks[2].volume,null);assert.equal(json.master.db,null);
  assert.ok(JSON.stringify(json).length<20000);
  const project=roundTrip(json);
  assert.equal(project.tracks[1].eq[1],-Infinity);assert.equal(project.tracks[2].volume,-Infinity);assert.equal(project.masterDb,-Infinity);
  assert.equal(project.tracks[3].pitch,7);assert.equal(project.tracks[0].steps[0],true);assert.deepEqual(project.points,[.1,.225,.35,.475,.6]);
  assert.equal(project.lengthTicks,32);assert.equal(project.resolution,16);assert.equal(project.swing,62);
  assert.equal(project.sourceBpm,98.5);assert.equal(project.followsSource,false);assert.equal(project.exportFormat,'mp3');assert.equal(project.savedAt,'2026-10-28T00:00:00.000Z');
  assert.equal(project.sourceKind,'file');assert.equal(project.sourceName,'loop.mp3');
});
test('元の曲はサイズとCRC32で照合し、名前が違っても中身が同じなら通す',()=>{
  const project=roundTrip(serializeProject(session()));
  assert.doesNotThrow(()=>checkSource(project,song));
  assert.throws(()=>checkSource(project,new TextEncoder().encode('pretend this is an mp3 filE')),/保存したときの曲と違います。「loop.mp3」/);
  assert.throws(()=>checkSource(project,song.subarray(1)),/保存したときの曲と違います/);
});
test('デモ音源のプロジェクトは照合情報を持たない',()=>{
  const project=roundTrip(serializeProject(session({sourceKind:'demo',sourceName:'Future Funk Lab · Demo 120 BPM.wav',sourceBytes:null,sourceCrc:null})));
  assert.equal(project.sourceKind,'demo');assert.equal(project.sourceBytes,null);assert.equal(project.sourceCrc,null);
});
test('範囲外の値はUIと同じ範囲に収め、不正な構造は拒否する',()=>{
  const json=serializeProject(session());json.tracks[0].pitch=40;json.tracks[0].cents=-99;json.tracks[0].volume=20;json.tracks[0].mode='x';json.eq.low=10;json.tempo.bpm=999;json.sequence.swing=90;
  const project=parseProject(json);
  assert.equal(project.tracks[0].pitch,12);assert.equal(project.tracks[0].cents,-50);assert.equal(project.tracks[0].volume,6);assert.equal(project.tracks[0].mode,'overlap');assert.equal(project.settings.low,200);assert.equal(project.bpm,300);assert.equal(project.swing,75);
  assert.throws(()=>parseProject({...json,format:'other'}),/プロジェクトではありません/);
  assert.throws(()=>parseProject({...json,schemaVersion:99}),/新しい版/);
  assert.throws(()=>parseProject({...json,schemaVersion:2}),/対応していない版/);
  assert.throws(()=>parseProject({...json,source:{...json.source,kind:'url'}}),/種類/);
  assert.throws(()=>parseProject({...json,source:{...json.source,crc32:undefined}}),/照合情報/);
  assert.throws(()=>parseProject({...json,tracks:json.tracks.slice(1)}),/8個/);
  assert.throws(()=>parseProject({...json,sampling:{...json.sampling,points:[.1,.3,.2,.5,.6]}}),/分割位置/);
  assert.throws(()=>parseProject({...json,tempo:{bpm:'abc'}}),/数値/);
});
test('8分グリッドのプロジェクトに16分の裏があれば消す',()=>{
  const json=serializeProject(session({resolution:8}));json.tracks[0].steps[1]=true;
  const project=parseProject(json);assert.equal(project.tracks[0].steps[1],false);assert.equal(project.tracks[0].steps[0],true);
});
test('保存ファイル名は取り込んだ曲の名前の拡張子を.jsonにしたもの',()=>{
  assert.equal(projectFileName('my loop.mp3'),'my loop.json');assert.equal(projectFileName('a/b:c.wav'),'a_b_c.json');assert.equal(projectFileName(''),'project.json');assert.equal(projectFileName('microphone-2026.webm'),'microphone-2026.json');
});
