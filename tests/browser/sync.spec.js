import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {encodeWav} from '../../src/core.js';
// These tests use every track's inline editor, which the detail view shows.
test.beforeEach(async({page})=>{await page.addInitScript(()=>{try{localStorage.setItem('ffl:view','detail');}catch{}});});
const state=page=>page.evaluate(()=>window.futureFunkLab.getState());
async function source(page){await page.goto('/');await page.locator('#demo').click();await expect(page.locator('#sample')).toBeEnabled();}
test('マスターは全スクロール位置・狭い画面でも表示され、その場で操作できる',async({page})=>{
  await source(page);
  for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
    await page.setViewportSize(viewport);
    for(const target of ['#sampling','#chop','#sequence','footer']){
      await page.locator(target).scrollIntoViewIfNeeded();await expect(page.locator('#master-strip')).toBeInViewport();
      const bounds=await page.locator('#master-strip').boundingBox();expect(bounds.y).toBeGreaterThanOrEqual(0);expect(bounds.y+bounds.height).toBeCloseTo(viewport.height,0);
      await expect(page.locator('#master-number')).toBeInViewport();await expect(page.locator('#clip-reset')).toBeInViewport();
    }
    await page.locator('#master-number').fill('-6');await page.locator('#master-number').press('Tab');expect(await page.evaluate(()=>window.futureFunkLab.engine.masterDb)).toBe(-6);
    await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));const footer=await page.locator('footer').boundingBox(),master=await page.locator('#master-strip').boundingBox();expect(footer.y+footer.height).toBeLessThanOrEqual(master.y);
  }
});

test('選択範囲の拍数からBPMを校正し、指定済みの目標BPMを保持する',async({page})=>{
  await source(page);await page.locator('#source-bpm').fill('100');await page.locator('#source-bpm').press('Tab');await expect(page.locator('#sample')).toBeEnabled();
  await page.locator('#range-start').fill('0');await page.locator('#range-start').press('Tab');await page.locator('#range-end').fill('2.013');await page.locator('#range-end').press('Tab');
  await page.locator('#loop-beats').fill('4');await page.locator('#loop-beats').press('Tab');await page.locator('#calibrate-loop-bpm').click();await expect(page.locator('#sample')).toBeEnabled();
  expect((await state(page)).sourceBpm).toBe(119.225);expect((await state(page)).bpm).toBe(119.225);expect((await state(page)).duration).toBe(8);
  await page.locator('#global-bpm').fill('130');await page.locator('#global-bpm').press('Tab');await expect(page.locator('#sample')).toBeEnabled();
  await page.locator('#calibrate-loop-bpm').click();await expect(page.locator('#sample')).toBeEnabled();expect((await state(page)).sourceBpm).toBe(119.225);expect((await state(page)).bpm).toBe(130);
  const result=await state(page);expect((result.range[1]-result.range[0])*result.duration).toBeCloseTo(4*60/130,4);
});

test('実音のアタックがBPM変換・チョップ・シーケンサー書き出し後も拍に一致する',async({page})=>{
  const rate=44100,input=new Float32Array(rate*8);
  for(let beat=0;beat<12;beat++)for(let i=0;i<600;i++){const frame=Math.round((.137+beat*60/90)*rate)+i;if(frame<input.length)input[frame]=.8*Math.exp(-i/100)*Math.cos(i*.3);}
  await page.goto('/');await page.locator('#source-file').setInputFiles({name:'90bpm-beats.wav',mimeType:'audio/wav',buffer:Buffer.from(encodeWav([input,input],rate))});await expect(page.locator('#sample')).toBeEnabled();
  await page.locator('#source-bpm').fill('90');await page.locator('#source-bpm').press('Tab');await expect(page.locator('#sample')).toBeEnabled();await page.locator('#global-bpm').fill('120');await page.locator('#global-bpm').press('Tab');await expect(page.locator('#sample')).toBeEnabled();
  await page.locator('#range-start').fill('0.10275');await page.locator('#range-start').press('Tab');await page.locator('#range-end').fill('2.10275');await page.locator('#range-end').press('Tab');await page.locator('#sample').click();await expect(page.locator('#seq-play')).toBeEnabled();await page.locator('#chop-count').selectOption('2');await expect(page.locator('#seq-play')).toBeEnabled();
  await page.locator('[data-steps="8"]').click();await page.locator('[data-track-step="0"][data-step="0"]').click();await page.locator('[data-track-step="0"][data-step="4"]').click();
  const downloading=page.waitForEvent('download');await page.locator('#export').click();const data=await readFile(await(await downloading).path());const frames=data.readUInt32LE(40)/4;expect(frames).toBe(rate*2);
  const peaks=[];
  for(const target of [0,.5,1,1.5]){
    let amplitude=0,frame=0;for(let i=Math.max(0,Math.round((target-.03)*rate));i<Math.min(frames,Math.round((target+.03)*rate));i++){const value=Math.abs(data.readInt16LE(44+i*4)/32768);if(value>amplitude){amplitude=value;frame=i;}}
    expect(amplitude).toBeGreaterThan(.03);expect(Math.abs(frame/rate-target)).toBeLessThan(.010);peaks.push(frame/rate);
  }
  for(let i=1;i<peaks.length;i++)expect(Math.abs(peaks[i]-peaks[i-1]-.5)).toBeLessThan(.010);
});
