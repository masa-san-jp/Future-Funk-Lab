import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
async function demo(page){await page.goto('/');await page.getByRole('button',{name:'デモ音源を読み込む'}).click();await expect(page.locator('#sample')).toBeEnabled();}
async function state(page){return page.evaluate(()=>window.futureFunkLab.getState());}
async function download(page,selector){const promise=page.waitForEvent('download');await page.locator(selector).click();const file=await promise;return {name:file.suggestedFilename(),data:await readFile(await file.path())};}
// Bit-exact fingerprint of the rebuilt track buffers.
async function bufferPrint(page){return page.evaluate(()=>window.futureFunkLab.engine.buffers.map(b=>{if(!b)return null;let hash=0;for(let c=0;c<b.numberOfChannels;c++){const bits=new Uint32Array(b.getChannelData(c).slice().buffer);for(const x of bits)hash=(Math.imul(hash,31)+x)>>>0;}return [b.length,hash];}));}
// OfflineAudioContext rendering can differ by one LSB between runs, even in one session.
function maxPcmDifference(a,b){let max=0;for(let i=44;i<a.length;i+=2)max=Math.max(max,Math.abs(a.readInt16LE(i)-b.readInt16LE(i)));return max;}
async function setField(page,selector,value){await page.locator(selector).fill(String(value));await page.locator(selector).press('Tab');}
async function buildSession(page){
  await demo(page);
  await setField(page,'#range-start','0.500');await setField(page,'#range-end','4.500');
  await page.locator('#sample').click();await expect(page.locator('#seq-play')).toBeEnabled();
  for(const [track,step] of [[0,0],[0,6],[1,4],[2,8],[3,12]])await page.locator(`[data-track-step="${track}"][data-step="${step}"]`).click();
  await setField(page,'[data-track-pitch="1"]',5);await expect(page.locator('#status')).toContainText('長さを維持');
  await page.locator('[data-track-mode="0"]').selectOption('cut');await page.locator('[data-track-sync="2"]').selectOption('original');
  await setField(page,'[data-track-db="3"]','-6');await setField(page,'#eq-value-2-2','-12');await page.locator('#eq-slope').selectOption('24');
  await page.locator('[data-track-mute="3"]').click();await setField(page,'#master-number','-3');await setField(page,'#swing',58);
  await expect(page.locator('#seq-play')).toBeEnabled();
  // Step clicks queue track rebuilds whose status messages arrive later.
  await expect.poll(async()=>(await state(page)).pendingTracks.length).toBe(0);await page.waitForTimeout(200);
}
test('プロジェクトを保存して開き直すと、トラックの音がビット単位で一致する',async({page})=>{
  const remote=[];page.on('request',r=>{if(/^https?:/.test(r.url())&&!r.url().includes('127.0.0.1'))remote.push(r.url());});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await buildSession(page);
  await expect(page.locator('#project-dirty')).toHaveText('未保存の変更あり',{timeout:5000});
  const before=await download(page,'#export'),saved=await download(page,'#project-save'),expected=await state(page),print=await bufferPrint(page);
  expect(saved.name).toBe('Future Funk Lab · Demo 120 BPM-120bpm.fflab');expect(saved.data.subarray(0,8).toString()).toBe('FFLABPRJ');
  await expect(page.locator('#project-dirty')).toHaveText('');
  await page.goto('/');
  await page.locator('#project-file').setInputFiles({name:saved.name,mimeType:'application/octet-stream',buffer:saved.data});
  await expect(page.locator('#status')).toContainText('プロジェクトを読み込みました');await expect(page.locator('#seq-play')).toBeEnabled();
  const restored=await state(page);
  for(const key of ['bpm','sourceBpm','count','steps','lengthTicks','resolution','swing','points','committed','range','bufferDurations','tracks'])expect(restored[key],key).toEqual(expected[key]);
  await expect(page.locator('[data-track-pitch="1"]')).toHaveValue('5');await expect(page.locator('#eq-slope')).toHaveValue('24');await expect(page.locator('#master-number')).toHaveValue('-3.0');
  await expect(page.locator('#project-dirty')).toHaveText('');
  expect(await bufferPrint(page)).toEqual(print);
  const after=await download(page,'#export');
  expect(after.data.length).toBe(before.data.length);expect(maxPcmDifference(after.data,before.data)).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);expect(remote).toEqual([]);
});
test('MP3と録音の音源も、保存して開き直すと同じトラックになる',async({page})=>{
  await demo(page);await page.locator('#sample').click();await expect(page.locator('#seq-play')).toBeEnabled();
  await page.locator('[data-track-step="0"][data-step="0"]').click();await page.locator('#export-format').selectOption('mp3');
  const mp3=await download(page,'#export');
  const sources={
    mp3:async()=>{await page.locator('#source-file').setInputFiles({name:'loop.mp3',mimeType:'audio/mpeg',buffer:mp3.data});},
    recording:async()=>{await page.locator('#record').click();await expect(page.locator('#record-stop')).toBeEnabled();await page.waitForTimeout(1000);await page.locator('#record-stop').click();}
  };
  for(const [label,load] of Object.entries(sources)){
    await page.goto('/');await load();await expect(page.locator('#sample')).toBeEnabled();
    await page.locator('#sample').click();await expect(page.locator('#seq-play')).toBeEnabled();
    await page.locator('[data-track-step="1"][data-step="2"]').click();await setField(page,'[data-track-pitch="1"]',-3);await expect(page.locator('#status')).toContainText('長さを維持');
    const expected=await state(page),print=await bufferPrint(page),saved=await download(page,'#project-save');
    await page.goto('/');await page.locator('#project-file').setInputFiles({name:saved.name,mimeType:'application/octet-stream',buffer:saved.data});
    await expect(page.locator('#status')).toContainText('プロジェクトを読み込みました');await expect(page.locator('#seq-play')).toBeEnabled();
    const restored=await state(page);
    expect(restored.bufferDurations,label).toEqual(expected.bufferDurations);expect(restored.duration,label).toBe(expected.duration);expect(await bufferPrint(page),label).toEqual(print);
  }
});
test('壊れたプロジェクトを開いても、今の作業は残る',async({page})=>{
  await buildSession(page);const before=await state(page);
  await page.locator('#project-file').setInputFiles({name:'broken.fflab',mimeType:'application/octet-stream',buffer:Buffer.from('this is not a project')});
  await expect(page.locator('#status')).toHaveClass(/error/);await expect(page.locator('#status')).toContainText('プロジェクトを読み込めませんでした');
  const after=await state(page);expect(after.committed).toEqual(before.committed);expect(after.tracks).toEqual(before.tracks);
});
test('自動保存から前回の作業を復元でき、破棄もできる',async({page})=>{
  await buildSession(page);const expected=await state(page);
  await page.waitForTimeout(4500);
  await page.reload();
  await expect(page.locator('#autosave-banner')).toBeVisible();await expect(page.locator('#autosave-text')).toContainText('Demo 120 BPM');
  await page.locator('#autosave-restore').click();
  await expect(page.locator('#status')).toContainText('プロジェクトを読み込みました');await expect(page.locator('#autosave-banner')).toBeHidden();
  const restored=await state(page);
  for(const key of ['points','committed','bufferDurations','tracks'])expect(restored[key],key).toEqual(expected[key]);
  await page.reload();await expect(page.locator('#autosave-banner')).toBeVisible();
  await page.locator('#autosave-discard').click();await expect(page.locator('#status')).toContainText('自動保存を破棄しました');await expect(page.locator('#autosave-banner')).toBeHidden();
  await page.reload();await page.waitForTimeout(500);await expect(page.locator('#autosave-banner')).toBeHidden();
});
