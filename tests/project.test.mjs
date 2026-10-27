import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav, decodeWav, makeTrack } from '../src/core.js';
import { serializeProject, parseProject, migrateProject, packContainer, unpackContainer, readProjectFile, encodeSource, projectFileName } from '../src/project.js';
const rate=44100;
function session(overrides={}){
  const tracks=Array.from({length:8},(_,i)=>makeTrack(i));tracks[0].steps[0]=true;tracks[1].eq=[0,-Infinity,-3];tracks[2].volume=-Infinity;tracks[3].pitch=7;
  return {appVersion:'test',sourceName:'loop.mp3',rate,frames:4,sourceBpm:98.5,bpmNote:'手動設定',bpm:120,followsSource:false,range:[.1,.6],committed:[.1,.6],points:[.1,.225,.35,.475,.6],count:4,snap:true,sourceLoop:false,loopBeats:null,lengthTicks:32,resolution:16,swing:62,loop:true,settings:{low:300,high:3000,slope:12},tracks,parts:[{hp:{on:true,freq:200,slope:12},lp:{on:false,freq:2000,slope:12}},{hp:{on:false,freq:200,slope:12},lp:{on:true,freq:250,slope:24}}],masterDb:-Infinity,exportChannels:1,exportFormat:'mp3',...overrides};
}
const source=[new Float32Array([.1,-.25,1.5,-2]),new Float32Array([1e-7,0,-1,.333])];
test('32-bit float WAVは値を丸めずに往復し、PCM16も読める',()=>{
  const decoded=decodeWav(encodeWav(source,rate,{float:true}));
  assert.equal(decoded.rate,rate);assert.deepEqual(decoded.channels.map(c=>[...c]),source.map(c=>[...c]));
  const pcm=decodeWav(encodeWav([new Float32Array([1,-1,0])],rate));assert.deepEqual([...pcm.channels[0]],[1,-1,0]);
  assert.throws(()=>decodeWav(new Uint8Array(20)),/WAVではありません/);
});
test('プロジェクトは保存→読み込みで同じ設定に戻り、−∞はnullで保存する',()=>{
  const json=serializeProject(session(),'2026-10-28T00:00:00.000Z');
  assert.equal(json.tracks[1].eq[1],null);assert.equal(json.tracks[2].volume,null);assert.equal(json.master.db,null);
  const {project,channels}=readProjectFile(packContainer(JSON.parse(JSON.stringify(json)),encodeSource(source,rate)));
  assert.deepEqual(channels.map(c=>[...c]),source.map(c=>[...c]));
  assert.equal(project.tracks[1].eq[1],-Infinity);assert.equal(project.tracks[2].volume,-Infinity);assert.equal(project.masterDb,-Infinity);
  assert.equal(project.tracks[3].pitch,7);assert.equal(project.lengthTicks,32);assert.equal(project.resolution,16);assert.equal(project.swing,62);assert.equal(project.tracks[0].steps[0],true);assert.deepEqual(project.points,[.1,.225,.35,.475,.6]);
  assert.equal(project.sourceBpm,98.5);assert.equal(project.followsSource,false);assert.equal(project.exportFormat,'mp3');assert.equal(project.savedAt,'2026-10-28T00:00:00.000Z');
});
test('範囲外の値はUIと同じ範囲に収め、不正な構造は拒否する',()=>{
  const json=serializeProject(session());json.tracks[0].pitch=40;json.tracks[0].cents=-99;json.tracks[0].volume=20;json.tracks[0].mode='x';json.eq.low=10;json.tempo.bpm=999;
  const project=parseProject(json);
  assert.equal(project.tracks[0].pitch,12);assert.equal(project.tracks[0].cents,-50);assert.equal(project.tracks[0].volume,6);assert.equal(project.tracks[0].mode,'overlap');assert.equal(project.settings.low,200);assert.equal(project.bpm,300);
  assert.throws(()=>parseProject({...json,format:'other'}),/プロジェクトではありません/);
  assert.throws(()=>parseProject({...json,schemaVersion:99}),/新しい版/);
  assert.throws(()=>parseProject({...json,tracks:json.tracks.slice(1)}),/8個/);
  assert.throws(()=>parseProject({...json,sampling:{...json.sampling,points:[.1,.3,.2,.5,.6]}}),/分割位置/);
  assert.throws(()=>parseProject({...json,tempo:{bpm:'abc'}}),/数値/);
});
test('ファイルの壊れ・音源の長さの不一致を検出する',()=>{
  const file=packContainer(serializeProject(session()),encodeSource(source,rate));
  assert.throws(()=>readProjectFile(new TextEncoder().encode('not a project file')),/プロジェクトファイルではありません/);
  assert.throws(()=>readProjectFile(file.subarray(0,30)),/途中で切れています/);
  const {json}=unpackContainer(file);json.source.frames=5;
  assert.throws(()=>readProjectFile(packContainer(json,encodeSource(source,rate))),/長さ/);
});
test('保存ファイル名は音源名とBPMから作る',()=>{
  assert.equal(projectFileName('my loop.mp3',120),'my loop-120bpm.fflab');assert.equal(projectFileName('a/b:c.wav',98.5),'a_b_c-98.5bpm.fflab');assert.equal(projectFileName('',90),'project-90bpm.fflab');
});

test('v1のプロジェクトは8分のステップを16分単位に変換して読み込む',()=>{
  const v1=serializeProject(session());v1.schemaVersion=1;v1.sequence={steps:8,loop:false};
  v1.tracks.forEach(t=>{t.steps=Array(32).fill(false);});v1.tracks[0].steps[3]=true;v1.tracks[0].steps[7]=true;
  const migrated=migrateProject(v1);assert.equal(migrated.schemaVersion,2);assert.deepEqual(migrated.sequence,{lengthTicks:16,resolution:8,swing:50,loop:false});
  const project=parseProject(v1);assert.equal(project.lengthTicks,16);assert.equal(project.resolution,8);assert.equal(project.swing,50);assert.equal(project.loop,false);
  assert.deepEqual(project.tracks[0].steps.flatMap((on,i)=>on?[i]:[]),[6,14]);
});
test('8分グリッドのプロジェクトに16分の裏があれば消し、スウィングは50〜75に収める',()=>{
  const json=serializeProject(session({resolution:8,swing:90}));json.tracks[0].steps[1]=true;
  const project=parseProject(json);assert.equal(project.tracks[0].steps[1],false);assert.equal(project.tracks[0].steps[0],true);assert.equal(project.swing,75);
});
