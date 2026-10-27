import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {encodeWav} from '../../src/core.js';
// These tests use every track's inline editor, which the detail view shows.
test.beforeEach(async({page})=>{await page.addInitScript(()=>{try{localStorage.setItem('ffl:view','detail');}catch{}});});
const state=page=>page.evaluate(()=>window.futureFunkLab.getState());
async function loaded(page){await page.goto('/');await page.locator('#demo').click();await expect(page.locator('#sample')).toBeEnabled();await page.locator('#range-end').fill('7.232');await page.locator('#range-end').press('Tab');await page.locator('#sample').click();await expect(page.locator('#seq-play')).toBeEnabled();}
async function pattern(page){for(const s of [0,4,8])await page.locator(`[data-track-step="0"][data-step="${s}"]`).click();await page.locator('[data-track-step="3"][data-step="12"]').click();}
async function settled(page,index,seconds){await expect.poll(async()=>(await state(page)).bufferDurations[index]).toBeCloseTo(seconds,4);}

test('任意長素材を複数ステップへ同期し、3・5・7ステップ指定と原寸へ切り替えられる',async({page})=>{
  await loaded(page);const before=await state(page);expect(before.bufferDurations[0]).toBeCloseTo(1.808,4);
  await pattern(page);await settled(page,0,1);await settled(page,3,1);
  for(const n of [3,5,7]){
    await page.locator('[data-track-sync="0"]').selectOption('fixed');await page.locator('[data-track-sync-steps="0"]').fill(String(n));await page.locator('[data-track-sync-steps="0"]').press('Tab');await settled(page,0,n*.25);
    await page.locator('[data-pad="0"]').click();await expect(page.locator('[data-pad="0"]')).toHaveAttribute('aria-pressed','true');
    const playback=(await state(page)).chopPlayback;expect(playback.duration).toBeCloseTo(n*.25,4);expect(playback.end-playback.start).toBeCloseTo(1.808,4);
    await page.locator('[data-pad="0"]').click();
  }
  await page.locator('[data-track-sync="0"]').selectOption('original');await settled(page,0,1.808);
  const after=await state(page);expect(after.points).toEqual(before.points);expect(after.duration).toBe(before.duration);expect(after.bpm).toBe(before.bpm);
});

test('再生中の配置変更とピッチ変更でも周回時計と同期長を維持する',async({page})=>{
  await loaded(page);await pattern(page);await page.locator('#seq-play').click();await expect.poll(async()=>(await state(page)).playing).toBe(true);
  const start=await page.evaluate(()=>window.futureFunkLab.engine.started);
  await page.locator('[data-track-step="0"][data-step="2"]').click();await settled(page,0,.5);
  expect(await page.evaluate(()=>window.futureFunkLab.engine.started)).toBe(start);expect((await state(page)).playing).toBe(true);
  await page.locator('[data-track-pitch="0"]').fill('12');await page.locator('[data-track-pitch="0"]').press('Tab');await expect(page.locator('#status')).toContainText('長さを維持');expect((await state(page)).bufferDurations[0]).toBe(.5);
  const voices=await page.evaluate(()=>[...window.futureFunkLab.engine.voices].filter(v=>v.pattern&&!v.stopped).map(v=>({origin:v.origin,period:v.buffer.duration,loop:v.source.loop})));
  expect(voices.every(v=>v.origin===start&&v.period===4&&v.loop)).toBe(true);
  await page.locator('#seq-stop').click();await page.locator('[data-track-step="0"][data-step="2"]').click();
  await page.locator('#global-bpm').fill('137');await page.locator('#global-bpm').press('Tab');await expect(page.locator('#seq-play')).toBeEnabled();
  expect(Math.abs((await state(page)).bufferDurations[0]-4*30/137)).toBeLessThan(1/44100);
});

test('1.808秒素材内の4アタックを同期し、BPM変更後も全16拍が書き出しのグリッドに一致する',async({page})=>{
  const rate=44100,length=Math.round(7.232*rate),signal=new Float32Array(length);
  for(let n=0;n<16;n++){const start=Math.round(n*1.808/4*rate);for(let k=0;k<600;k++)if(start+k<length)signal[start+k]=.6*Math.exp(-k/130)*Math.cos(k*.31);}
  await page.goto('/');await page.locator('#source-file').setInputFiles({name:'arbitrary-length-attacks.wav',mimeType:'audio/wav',buffer:Buffer.from(encodeWav([signal,signal],rate))});await expect(page.locator('#sample')).toBeEnabled();
  await page.locator('#source-bpm').fill('95');await page.locator('#source-bpm').press('Tab');await expect(page.locator('#sample')).toBeEnabled();await page.locator('#sample').click();await expect(page.locator('#seq-play')).toBeEnabled();await pattern(page);
  for(const bpm of [95,120]){
    if(bpm!==95){await page.locator('#global-bpm').fill(String(bpm));await page.locator('#global-bpm').press('Tab');await expect(page.locator('#export')).toBeEnabled();}
    const downloading=page.waitForEvent('download');await page.locator('#export').click();const wav=await readFile(await(await downloading).path()),frames=wav.readUInt32LE(40)/4;
    expect(frames).toBe(Math.round(16*30/bpm*rate));
    for(let n=0;n<16;n++){
      const target=n*30/bpm;let amplitude=0,position=0;
      for(let i=Math.max(0,Math.round((target-.012)*rate));i<Math.min(frames,Math.round((target+.012)*rate));i++){const value=Math.abs(wav.readInt16LE(44+i*4)/32768);if(value>amplitude){amplitude=value;position=i/rate;}}
      expect(amplitude,`${bpm} BPM, attack ${n+1}`).toBeGreaterThan(.025);expect(Math.abs(position-target),`${bpm} BPM, attack ${n+1}`).toBeLessThan(.010);
    }
  }
});
