import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
async function download(page){const promise=page.waitForEvent('download');await page.locator('#export').click();const file=await promise;return {name:file.suggestedFilename(),data:await readFile(await file.path())};}
// STORE entries can be read by walking the local headers.
function unzip(data){
  const files={};let offset=0;
  while(data.readUInt32LE(offset)===0x04034b50){
    const size=data.readUInt32LE(offset+18),nameLength=data.readUInt16LE(offset+26),extra=data.readUInt16LE(offset+28);
    expect(data.readUInt16LE(offset+8)).toBe(0);
    const name=data.subarray(offset+30,offset+30+nameLength).toString(),start=offset+30+nameLength+extra;
    files[name]=data.subarray(start,start+size);offset=start+size;
  }
  return files;
}
const samples=wav=>{const out=new Int16Array((wav.length-44)/2);for(let i=0;i<out.length;i++)out[i]=wav.readInt16LE(44+i*2);return out;};
async function prepare(page){
  await page.goto('/');await page.locator('#demo').click();await expect(page.locator('#sample')).toBeEnabled();
  await page.locator('#sample').click();await expect(page.locator('#seq-play')).toBeEnabled();
  for(const [track,step] of [[0,0],[0,8],[1,4],[1,12],[2,2],[2,10],[3,6],[3,14]])await page.locator(`[data-track-step="${track}"][data-step="${step}"]`).click();
  await page.locator('#master-number').fill('-6');await page.locator('#master-number').press('Tab');
  await page.locator('[data-track-db="2"]').fill('-3');await page.locator('[data-track-db="2"]').press('Tab');
  await page.locator('#eq-value-1-0').fill('-12');await page.locator('#eq-value-1-0').press('Tab');
  await expect.poll(async()=>(await page.evaluate(()=>window.futureFunkLab.getState())).pendingTracks.length).toBe(0);
}
test('トラック別の全ステムを足すとミックスと一致する',async({page})=>{
  const remote=[];page.on('request',r=>{if(/^https?:/.test(r.url())&&!r.url().includes('127.0.0.1'))remote.push(r.url());});
  await prepare(page);
  const mix=await download(page);
  await page.locator('#export-target').selectOption('stems');const zip=await download(page);
  expect(zip.name).toBe('future-funk-120bpm-16steps-stems.zip');
  const files=unzip(zip.data);expect(Object.keys(files)).toEqual(['track01.wav','track02.wav','track03.wav','track04.wav']);
  await expect(page.locator('#status')).toContainText('トラック別に書き出しました · 4本');
  const target=samples(mix.data),stems=Object.values(files).map(samples);let max=0,peak=0;
  for(const stem of stems)expect(stem.length).toBe(target.length);
  for(let i=0;i<target.length;i++){let sum=0;for(const stem of stems)sum+=stem[i];max=Math.max(max,Math.abs(sum-target[i]));peak=Math.max(peak,Math.abs(target[i]));}
  expect(peak).toBeGreaterThan(1000);expect(peak).toBeLessThan(32767);expect(max).toBeLessThanOrEqual(4);
  expect(remote).toEqual([]);
});
test('ミュートしたトラックはZIPに入らず、MP3・モノでも書き出せる',async({page})=>{
  await prepare(page);await page.locator('[data-track-mute="3"]').click();
  await page.locator('#export-target').selectOption('stems');await page.locator('#export-channels').selectOption('1');await page.locator('#export-format').selectOption('mp3');
  const files=unzip((await download(page)).data);
  expect(Object.keys(files)).toEqual(['track01.mp3','track02.mp3','track03.mp3']);
  for(const mp3 of Object.values(files)){expect(mp3.length).toBeGreaterThan(1000);expect(mp3[0]).toBe(255);}
  await expect(page.locator('#status')).toContainText('3本（TRACK 04はミュートのため除外）');
  await page.locator('[data-track-mute="3"]').click();await page.locator('[data-track-solo="0"]').click();
  expect(Object.keys(unzip((await download(page)).data))).toEqual(['track01.mp3']);
  await expect(page.locator('#status')).toContainText('TRACK 02はソロ対象外のため除外');
  for(let i=0;i<4;i++)for(const step of [0,2,4,6,8,10,12,14]){const cell=page.locator(`[data-track-step="${i}"][data-step="${step}"]`);if(await cell.getAttribute('aria-pressed')==='true')await cell.click();}
  await page.locator('#export').click();await expect(page.locator('#status')).toHaveText('書き出すトラックがありません');await expect(page.locator('#status')).toHaveClass(/error/);
});
