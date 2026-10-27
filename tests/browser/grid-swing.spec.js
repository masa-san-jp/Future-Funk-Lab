import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const rate=44100;
async function state(page){return page.evaluate(()=>window.futureFunkLab.getState());}
// 1 s source: a 10 ms burst at 0 s, then silence, so each trigger has a clean onset.
function burstWav(){
  const frames=rate,data=Buffer.alloc(44+frames*4);
  data.write('RIFF',0);data.writeUInt32LE(36+frames*4,4);data.write('WAVEfmt ',8);data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);data.writeUInt16LE(2,22);
  data.writeUInt32LE(rate,24);data.writeUInt32LE(rate*4,28);data.writeUInt16LE(4,32);data.writeUInt16LE(16,34);data.write('data',36);data.writeUInt32LE(frames*4,40);
  for(let i=0;i<rate*.01;i++){data.writeInt16LE(16000,44+i*4);data.writeInt16LE(16000,46+i*4);}
  return data;
}
async function prepare(page){
  await page.goto('/');await page.locator('#source-file').setInputFiles({name:'burst.wav',mimeType:'audio/wav',buffer:burstWav()});await expect(page.locator('#sample')).toBeEnabled();
  await page.locator('#source-bpm').fill('120');await page.locator('#source-bpm').press('Tab');await expect(page.locator('#sample')).toBeEnabled();expect((await state(page)).bpm).toBe(120);
  await page.locator('#sample').click();await expect(page.locator('#seq-play')).toBeEnabled();
  await page.locator('[data-track-sync="0"]').selectOption('original');
}
async function firstOnset(page){
  const promise=page.waitForEvent('download');await page.locator('#export').click();const data=await readFile(await (await promise).path());
  for(let i=44;i<data.length;i+=4)if(data.readInt16LE(i)!==0)return (i-44)/4;
  return -1;
}
test('16分グリッドでは1小節が16ステップになり、ステップ2が0.125秒で鳴る',async({page})=>{
  await prepare(page);
  await page.locator('#grid-16').click();await expect(page.locator('#grid-16')).toHaveAttribute('aria-pressed','true');
  await expect(page.locator('[data-ticks]')).toHaveText(['8½小節','161小節','322小節','644小節']);
  await page.locator('[data-ticks="16"]').click();await expect(page.locator('#signature')).toHaveText('16/16');await expect(page.locator('#pattern-length')).toContainText('1ステップ 0.125 s / 1周 2.000 s');
  await page.locator('[data-track-step="0"][data-step="1"]').click();
  const onset=await firstOnset(page);expect(onset).toBeGreaterThanOrEqual(5513);expect(onset).toBeLessThanOrEqual(5514);
  const current=await state(page);expect(current.steps).toBe(16);expect(current.lengthTicks).toBe(16);expect(current.tracks[0].steps[1]).toBe(true);
});
test('スウィング66%では16分の裏が0.165秒に遅れ、50%に戻すと元に戻る',async({page})=>{
  await prepare(page);
  await page.locator('#grid-16').click();await page.locator('[data-ticks="16"]').click();await page.locator('[data-track-step="0"][data-step="1"]').click();
  await page.locator('#swing').fill('66');await page.locator('#swing').press('Tab');expect((await state(page)).swing).toBe(66);
  let onset=await firstOnset(page);expect(Math.abs(onset-.165*rate)).toBeLessThanOrEqual(1.5);
  await page.locator('#swing').fill('99');await page.locator('#swing').press('Tab');await expect(page.locator('#swing')).toHaveValue('75');
  await page.locator('#swing').fill('50');await page.locator('#swing').press('Tab');
  onset=await firstOnset(page);expect(onset).toBeGreaterThanOrEqual(5513);expect(onset).toBeLessThanOrEqual(5514);
});
test('16分から8分へ戻すとき、裏のノートがあれば確認し、やめるとデータを変えない',async({page})=>{
  await prepare(page);
  await page.locator('[data-track-step="0"][data-step="2"]').click();
  await page.locator('#grid-16').click();await expect(page.locator('[data-track-step="0"][data-step="4"]')).toHaveAttribute('aria-pressed','true');
  await page.locator('[data-track-step="1"][data-step="3"]').click();
  await page.locator('#grid-8').click();await expect(page.locator('#grid-confirm')).toBeVisible();await expect(page.locator('#grid-confirm-text')).toHaveText('16分の裏にあるノート 1 個が消えます');
  await page.locator('#grid-confirm-no').click();await expect(page.locator('#grid-confirm')).toBeHidden();
  let current=await state(page);expect(current.resolution).toBe(16);expect(current.tracks[1].steps[3]).toBe(true);
  await page.locator('#grid-8').click();await page.locator('#grid-confirm-yes').click();
  current=await state(page);expect(current.resolution).toBe(8);expect(current.tracks[1].steps[3]).toBe(false);expect(current.tracks[0].steps[4]).toBe(true);
  await expect(page.locator('[data-track-step="0"][data-step="2"]')).toHaveAttribute('aria-pressed','true');await expect(page.locator('#signature')).toHaveText('16/8');
});
