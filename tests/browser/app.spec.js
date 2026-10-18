import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
async function demo(page){await page.goto('/');await page.getByRole('button',{name:'デモ音源を読み込む'}).click();await expect(page.locator('#sample')).toBeEnabled();}
async function sample(page){await page.locator('#sample').click();await expect(page.locator('#seq-play')).toBeEnabled();}
async function state(page){return page.evaluate(()=>window.futureFunkLab.getState());}
async function wav(download){const data=await readFile(await download.path());return {data,channels:data.readUInt16LE(22),rate:data.readUInt32LE(24),frames:data.readUInt32LE(40)/data.readUInt16LE(32)};}
test('音源→チョップ→8トラック→再生→BPM変更→WAV/MP3',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));const remote=[];page.on('request',r=>{if(/^https?:/.test(r.url())&&!r.url().includes('127.0.0.1'))remote.push(r.url());});
  await demo(page);expect((await state(page)).duration).toBeCloseTo(8,3);
  await page.locator('#range-start').fill('0.500');await page.locator('#range-start').press('Tab');await page.locator('#range-end').fill('5.500');await page.locator('#range-end').press('Tab');await sample(page);
  expect((await state(page)).bufferDurations).toEqual([1.25,1.25,1.25,1.25]);
  await page.locator('[data-track-sync="0"]').selectOption('original');await page.locator('[data-track-sync="1"]').selectOption('original');
  await page.locator('[data-track-step="0"][data-step="0"]').click();await page.locator('[data-track-step="0"][data-step="1"]').click();await page.locator('[data-track-step="1"][data-step="4"]').click();await page.locator('[data-track-mode="0"]').selectOption('cut');
  await page.locator('#seq-play').click();await expect.poll(async()=>(await state(page)).playing).toBe(true);await expect(page.locator('.playhead').first()).toBeVisible();
  await page.locator('[data-track-pitch="0"]').fill('7');await page.locator('[data-track-pitch="0"]').press('Tab');await expect(page.locator('#status')).toContainText('長さを維持');expect((await state(page)).bufferDurations[0]).toBe(1.25);
  await page.locator('#seq-stop').click();expect((await state(page)).playing).toBe(false);
  await page.locator('#global-bpm').fill('90');await page.locator('#global-bpm').press('Tab');await expect(page.locator('#sample')).toBeEnabled();
  const next=await state(page);expect(next.duration).toBeCloseTo(8*120/90,3);expect(next.bufferDurations[0]).toBeCloseTo(1.25*120/90,3);expect(next.tracks[0].steps[0]).toBe(true);expect(next.tracks[0].pitch).toBe(7);
  await page.locator('[data-steps="8"]').click();await expect(page.locator('#signature')).toHaveText('8/8');
  let downloadPromise=page.waitForEvent('download');await page.locator('#export').click();const output=await wav(await downloadPromise);expect(output.channels).toBe(2);expect(output.frames/output.rate).toBeCloseTo(8*30/90,4);expect(output.data.subarray(44).some(n=>n!==0)).toBe(true);
  await page.locator('#export-channels').selectOption('1');await page.locator('#export-format').selectOption('mp3');downloadPromise=page.waitForEvent('download');await page.locator('#export').click();const mp3=await readFile(await (await downloadPromise).path());expect(mp3.length).toBeGreaterThan(1000);expect(mp3[0]).toBe(255);
  expect(errors).toEqual([]);expect(remote).toEqual([]);
});
test('波形・境界の操作、範囲の再選択、分割数とステップ数の保持',async({page})=>{
  await demo(page);await sample(page);await page.locator('#chop-count').selectOption('8');await expect(page.locator('.chop-pad')).toHaveCount(8);await expect(page.locator('#seq-play')).toBeEnabled();
  await page.locator('[data-track-step="7"][data-step="15"]').click();
  await page.locator('#chop-count').selectOption('4');await expect(page.locator('.chop-pad')).toHaveCount(4);await expect(page.locator('[data-track-step="7"][data-step="0"]')).toBeDisabled();
  await page.locator('#chop-count').selectOption('8');await expect(page.locator('.chop-pad')).toHaveCount(8);await expect(page.locator('[data-track-step="7"][data-step="15"]')).toHaveAttribute('aria-pressed','true');
  await page.locator('[data-steps="8"]').click();await page.locator('[data-steps="16"]').click();await expect(page.locator('[data-track-step="7"][data-step="15"]')).toHaveAttribute('aria-pressed','true');
  const before=(await state(page)).points[1];await page.locator('#chop-wave').focus();await page.keyboard.press('ArrowRight');await expect(page.locator('#status')).toContainText('チョップ位置');expect((await state(page)).points[1]).toBeGreaterThan(before);
  await page.locator('#zoom').fill('4');await page.locator('#zoom').dispatchEvent('input');await expect(page.locator('#wave-scroll')).toBeEnabled();
  await page.locator('#source-delete').click();await expect(page.locator('#sample')).toBeDisabled();await expect(page.locator('#seq-play')).toBeDisabled();expect((await state(page)).committed).toBeNull();
});
test('音声分離フィルターとシーク、パート書き出し',async({page})=>{
  await demo(page);await page.locator('[data-part-play="0"]').click();await expect(page.locator('[data-part-play="0"]')).toHaveClass(/active/);
  await page.locator('[data-part="0"][data-filter="hp"][data-param="freq"][type="number"]').fill('500');await page.locator('[data-part="0"][data-filter="hp"][data-param="freq"][type="number"]').press('Tab');await expect(page.locator('[data-part="0"][data-filter="hp"][type="range"]')).toHaveValue('500');
  await page.locator('[data-part="0"][data-filter="hp"][data-param="slope"]').selectOption('6');await page.locator('#part-seek-0').fill('0.5');await page.locator('#part-seek-0').dispatchEvent('input');await expect(page.locator('#part-time-0')).toContainText('0:04.');
  await page.locator('[data-part-stop="0"]').click();const promise=page.waitForEvent('download');await page.locator('[data-part-export="0"]').click();const output=await wav(await promise);expect(output.frames/output.rate).toBe(8);expect(output.data.subarray(44).some(x=>x!==0)).toBe(true);
});
test('マイク録音を停止して波形に取り込み、WAVで保存',async({page})=>{
  await page.goto('/');await page.locator('#record').click();await expect(page.locator('#record-stop')).toBeEnabled();await page.waitForTimeout(1000);await page.locator('#record-stop').click();await expect(page.locator('#sample')).toBeEnabled();await expect(page.locator('#record-save')).toBeEnabled();const promise=page.waitForEvent('download');await page.locator('#record-save').click();const output=await wav(await promise);expect(output.frames).toBeGreaterThan(1000);expect(output.channels).toBe(2);
});
test('単一HTMLはfile URLでも依存の取得なしに起動する',async({page})=>{
  const path=new URL('../../dist/index.html',import.meta.url).pathname;await page.goto('file://'+path);await page.locator('#demo').click();await expect(page.locator('#sample')).toBeEnabled();await sample(page);expect((await state(page)).bufferDurations.length).toBe(4);
});

test('EQの全帯域0dBは各勾配でフラット、-∞とM/Sが書き出しに反映される',async({page})=>{
  const {encodeWav}=await import('../../src/core.js');
  const rate=44100,signal=Float32Array.from({length:rate*2},(_,i)=>.3*Math.sin(2*Math.PI*300*i/rate));
  await page.goto('/');await page.locator('#source-file').setInputFiles({name:'tone.wav',mimeType:'audio/wav',buffer:Buffer.from(encodeWav([signal,signal],rate))});await expect(page.locator('#sample')).toBeEnabled();
  await page.locator('#source-bpm').fill('120');await page.locator('#source-bpm').press('Tab');await expect(page.locator('#sample')).toBeEnabled();
  await sample(page);await page.locator('#chop-count').selectOption('2');await expect(page.locator('#seq-play')).toBeEnabled();await page.locator('[data-steps="4"]').click();await page.locator('[data-track-step="0"][data-step="0"]').click();
  const rms=output=>{let sum=0,n=0;for(let frame=Math.round(.2*rate);frame<Math.round(.8*rate);frame++){const x=output.data.readInt16LE(44+frame*4)/32768;sum+=x*x;n++;}return Math.sqrt(sum/n);};
  for(const slope of [6,12,24]){await page.locator('#eq-slope').selectOption(String(slope));const promise=page.waitForEvent('download');await page.locator('#export').click();const output=await wav(await promise);expect(rms(output),`slope ${slope}`).toBeCloseTo(.3/Math.sqrt(2),2);}
  await page.locator('[data-track-mute="0"]').click();let promise=page.waitForEvent('download');await page.locator('#export').click();expect(rms(await wav(await promise))).toBe(0);
  await page.locator('[data-track-mute="0"]').click();await page.locator('[data-track-solo="1"]').click();promise=page.waitForEvent('download');await page.locator('#export').click();expect(rms(await wav(await promise))).toBe(0);
  await page.locator('[data-track-solo="1"]').click();await page.locator('#master-number').fill('-∞');await page.locator('#master-number').press('Tab');promise=page.waitForEvent('download');await page.locator('#export').click();expect(rms(await wav(await promise))).toBe(0);
});

test('画面の表示と狭い画面での操作領域を確認',async({page})=>{
  await demo(page);await sample(page);await page.locator('[data-track-step="0"][data-step="0"]').click();await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:'test-results/future-funk-lab-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});await expect(page.locator('#global-bpm')).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);await page.screenshot({path:'test-results/future-funk-lab-mobile.png',fullPage:true});
});

test('音声分離の周波数範囲はHPF 50〜2000Hz・LPF 200〜8000Hzで、入力とスライダーが連動する',async({page})=>{
  await demo(page);
  for(const part of [0,1])for(const [filter,min,max] of [['hp',50,2000],['lp',200,8000]]){
    const number=page.locator(`[data-part="${part}"][data-filter="${filter}"][data-param="freq"][type="number"]`);
    const slider=page.locator(`[data-part="${part}"][data-filter="${filter}"][data-param="freq"][type="range"]`);
    for(const input of [number,slider]){await expect(input).toHaveAttribute('min',String(min));await expect(input).toHaveAttribute('max',String(max));}
    await number.fill(String(min));await number.press('Tab');await expect(slider).toHaveValue(String(min));
    await slider.fill(String(max));await slider.dispatchEvent('input');await expect(number).toHaveValue(String(max));
    await number.fill(String(max+100));await number.press('Tab');await expect(number).toHaveValue(String(max));await expect(slider).toHaveValue(String(max));
  }
});
