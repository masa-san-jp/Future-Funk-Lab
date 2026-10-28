import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { encodeWav } from '../../src/core.js';
import { makeAiff } from '../aiff.mjs';
// These tests use every track's inline editor, which the detail view shows.
test.beforeEach(async({page})=>{await page.addInitScript(()=>{try{localStorage.setItem('ffl:view','detail');}catch{}});});
const rate=44100,seconds=2;
// A chord with a click on each beat, so the song has an audible pulse.
const channels=[0,1].map(ch=>Float32Array.from({length:rate*seconds},(_,i)=>{const t=i/rate,beat=t%.5;return .2*Math.sin(2*Math.PI*(220+ch*110)*t)+.4*Math.exp(-beat*40)*Math.sin(2*Math.PI*60*t);}));
const wav=Buffer.from(encodeWav(channels,rate));
// Audio fixtures stay out of the repository; afconvert ships with macOS.
let folder;
test.beforeAll(async()=>{folder=await mkdtemp(path.join(tmpdir(),'ffl-formats-'));await writeFile(path.join(folder,'song.wav'),wav);});
test.afterAll(async()=>{await rm(folder,{recursive:true,force:true});});
async function convert(name,args){
  try{await promisify(execFile)('afconvert',[...args,path.join(folder,'song.wav'),path.join(folder,name)]);return await readFile(path.join(folder,name));}
  catch{return null;}
}
const file=(name,buffer,mimeType)=>({name,mimeType,buffer});
async function state(page){return page.evaluate(()=>window.futureFunkLab.getState());}
async function load(page,name,buffer,mimeType){await page.goto('/');await page.locator('#source-file').setInputFiles(file(name,buffer,mimeType));}
async function bufferPrint(page){return page.evaluate(()=>window.futureFunkLab.engine.buffers.map(b=>{if(!b)return null;let hash=0;for(let c=0;c<b.numberOfChannels;c++){const bits=new Uint32Array(b.getChannelData(c).slice().buffer);for(const x of bits)hash=(Math.imul(hash,31)+x)>>>0;}return [b.length,hash];}));}
async function settle(page){await expect(page.locator("#seq-play")).toBeEnabled();await page.waitForTimeout(200);await expect.poll(async()=>(await state(page)).pendingTracks.length).toBe(0);await page.waitForTimeout(200);}
async function download(page,selector){const [d]=await Promise.all([page.waitForEvent('download'),page.locator(selector).click()]);return {name:d.suggestedFilename(),data:await readFile(await d.path())};}

test('AIFFは自前でWAVに組み替えて読み込み、WAVと同じ長さになる',async({page})=>{
  const pcm=new Uint8Array(rate*seconds*4),v=new DataView(pcm.buffer);
  for(let i=0;i<rate*seconds;i++)for(let c=0;c<2;c++)v.setInt16((i*2+c)*2,Math.round(channels[c][i]*32767));
  await load(page,'song.aiff',Buffer.from(makeAiff({bits:16,rate,data:pcm})),'audio/aiff');
  await expect(page.locator('#sample')).toBeEnabled();await expect(page.locator('#source-name')).toHaveText('song.aiff');
  const aiff=await state(page);expect(aiff.duration).toBeCloseTo(seconds,3);
  await load(page,'song.wav',wav,'audio/wav');await expect(page.locator('#sample')).toBeEnabled();
  expect((await state(page)).duration).toBe(aiff.duration);
});
for(const [name,args,mimeType] of [['song.m4a',['-f','m4af','-d','aac'],'audio/mp4'],['song.flac',['-f','flac','-d','flac'],'audio/flac']]){
  test(`${name.split('.')[1].toUpperCase()}を読み込んでサンプリングできる`,async({page})=>{
    const data=await convert(name,args);test.skip(!data,'afconvert が使えない環境');
    await load(page,name,data,mimeType);await expect(page.locator('#sample')).toBeEnabled();
    expect((await state(page)).duration).toBeGreaterThan(seconds*.95);
    await page.locator('#sample').click();await expect(page.locator('#seq-play')).toBeEnabled();
  });
}
test('M4Aのプロジェクトを保存して開き直すと、トラックの音がビット単位で一致する',async({page})=>{
  const m4a=await convert('song.m4a',['-f','m4af','-d','aac']);test.skip(!m4a,'afconvert が使えない環境');
  await load(page,'song.m4a',m4a,'audio/mp4');await expect(page.locator('#sample')).toBeEnabled();
  await page.locator('#sample').click();await expect(page.locator('#seq-play')).toBeEnabled();
  for(const step of [0,3,6])await page.locator(`[data-track-step="0"][data-step="${step}"]`).click();
  await page.locator('[data-track-pitch="1"]').fill('4');await page.locator('[data-track-pitch="1"]').press('Tab');await settle(page);
  const expected=await state(page),print=await bufferPrint(page),saved=await download(page,'#project-save');
  expect(saved.name).toBe('song.json');
  await page.goto('/');await page.locator('#project-file').setInputFiles([file(saved.name,saved.data,'application/json'),file('song.m4a',m4a,'audio/mp4')]);
  await expect(page.locator('#status')).toContainText('プロジェクトを読み込みました');await settle(page);
  const restored=await state(page);for(const key of ['duration','points','steps','tracks','bufferDurations'])expect(restored[key],key).toEqual(expected[key]);
  expect(await bufferPrint(page)).toEqual(print);
});
test('Chromeが読めない形式（ALAC）は、書き出し直す形式を案内する',async({page})=>{
  const alac=await convert('alac.m4a',['-f','m4af','-d','alac']);test.skip(!alac,'afconvert が使えない環境');
  await load(page,'alac.m4a',alac,'audio/mp4');
  await expect(page.locator('#status')).toHaveClass(/error/);
  await expect(page.locator('#status')).toContainText('この形式は読み込めませんでした。WAV・AIFF・MP3・AAC(M4A)・FLAC・Opusのどれかで書き出し直してください');
  expect((await state(page)).duration).toBe(0);
});
test('圧縮されたAIFF-Cは、対応していない圧縮形式として止める',async({page})=>{
  await load(page,'packed.aifc',Buffer.from(makeAiff({bits:16,codec:'ima4',data:new Uint8Array(400)})),'audio/aiff');
  await expect(page.locator('#status')).toHaveClass(/error/);await expect(page.locator('#status')).toContainText('このAIFFの圧縮形式（ima4）には対応していません');
});
