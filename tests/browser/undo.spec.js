import { test, expect } from '@playwright/test';
// These tests use every track's inline editor, which the detail view shows.
test.beforeEach(async({page})=>{await page.addInitScript(()=>{try{localStorage.setItem('ffl:view','detail');}catch{}});});
async function state(page){return page.evaluate(()=>window.futureFunkLab.getState());}
async function bufferPrint(page){return page.evaluate(()=>window.futureFunkLab.engine.buffers.map(b=>{if(!b)return null;let hash=0;for(let c=0;c<b.numberOfChannels;c++){const bits=new Uint32Array(b.getChannelData(c).slice().buffer);for(const x of bits)hash=(Math.imul(hash,31)+x)>>>0;}return [b.length,hash];}));}
// Step clicks and pitch changes queue track rebuilds that start a moment later.
async function settle(page){await expect(page.locator('#seq-play')).toBeEnabled();await page.waitForTimeout(200);await expect.poll(async()=>(await state(page)).pendingTracks.length).toBe(0);await page.waitForTimeout(200);}
// Chopping is itself the first undoable step after loading.
async function chopped(page){await page.goto('/');await page.getByRole('button',{name:'デモ音源を読み込む'}).click();await expect(page.locator('#sample')).toBeEnabled();await page.locator('#sample').click();await settle(page);}
async function setField(page,selector,value){await page.locator(selector).fill(String(value));await page.locator(selector).press('Tab');}
const KEYS=['bpm','sourceBpm','duration','count','points','committed','range','lengthTicks','resolution','swing','tracks','bufferDurations'];
// Settings and the bit-exact track buffers at one moment.
async function snapshot(page){await settle(page);const s=await state(page),picked={};for(const key of KEYS)picked[key]=s[key];return {settings:picked,print:await bufferPrint(page)};}
async function expectAt(page,expected){await settle(page);expect(await snapshot(page)).toEqual(expected);}
const undo=page=>page.keyboard.press('Meta+z'),redo=page=>page.keyboard.press('Meta+Shift+z');

test('ステップ・ピッチ・BPMを1つずつ元に戻し、やり直すと、音までその時点に戻る',async({page})=>{
  await chopped(page);await expect(page.locator('#undo')).toBeEnabled();
  const marks=[await snapshot(page)];
  for(const step of [0,4,6]){await page.locator(`[data-track-step="0"][data-step="${step}"]`).click();marks.push(await snapshot(page));}
  await setField(page,'[data-track-pitch="1"]',5);marks.push(await snapshot(page));
  await setField(page,'#global-bpm',100);await expect(page.locator('#sample')).toBeEnabled();marks.push(await snapshot(page));
  expect((await state(page)).history).toEqual({undo:6,redo:0});
  for(let i=marks.length-2;i>=0;i--){await undo(page);await expect(page.locator('#status')).toContainText(`元に戻しました（あと ${i+1} 回戻せます）`);await expectAt(page,marks[i]);}
  await undo(page);await expect.poll(async()=>(await state(page)).committed).toBeNull();
  await expect(page.locator('#undo')).toBeDisabled();await expect(page.locator('#redo')).toBeEnabled();
  await redo(page);await expectAt(page,marks[0]);
  for(let i=1;i<marks.length;i++){await redo(page);await expectAt(page,marks[i]);}
  await expect(page.locator('#redo')).toBeDisabled();
  // The header buttons do the same, and a new operation drops what could be redone.
  await page.locator('#undo').click();await expectAt(page,marks[marks.length-2]);
  await page.locator('[data-track-step="2"][data-step="1"]').click();await expect(page.locator('#redo')).toBeDisabled();
});
test('分割位置の微調整・スライダーの連続操作は、1回で戻る',async({page})=>{
  await chopped(page);const before=await snapshot(page);
  await page.locator('#chop-wave').focus();for(let i=0;i<4;i++)await page.keyboard.press('ArrowRight');
  await expect.poll(async()=>(await state(page)).points).not.toEqual(before.settings.points);await page.waitForTimeout(300);
  await undo(page);await expectAt(page,before);
  // Moving the master slider through several values is one step.
  await page.locator('#master').evaluate(slider=>{for(const v of [-3,-6,-9,-12]){slider.value=v;slider.dispatchEvent(new Event('input',{bubbles:true}));}});
  await expect(page.locator('#master-number')).toHaveValue('-12.0');
  await page.locator('body').click({position:{x:5,y:5}});await undo(page);await expect(page.locator('#master-number')).toHaveValue('0.0');
  expect((await state(page)).history.undo).toBe(1);
});
test('グリッドを8分に戻して消えた裏拍も、元に戻せる',async({page})=>{
  await chopped(page);await page.locator('#grid-16').click();
  await page.locator('[data-track-step="0"][data-step="3"]').click();const sixteenth=await snapshot(page);
  await page.locator('#grid-8').click();await page.locator('#grid-confirm-yes').click();
  await expect.poll(async()=>(await state(page)).resolution).toBe(8);expect((await state(page)).tracks[0].steps[3]).toBe(false);
  await undo(page);await expectAt(page,sixteenth);expect((await state(page)).tracks[0].steps[3]).toBe(true);
});
test('最初のサンプリングを戻すとチョップ前に戻り、やり直すと同じチョップになる',async({page})=>{
  await page.goto('/');await page.getByRole('button',{name:'デモ音源を読み込む'}).click();await expect(page.locator('#sample')).toBeEnabled();
  await expect(page.locator('#undo')).toBeDisabled();
  await page.locator('#sample').click();const after=await snapshot(page);
  await undo(page);await expect.poll(async()=>(await state(page)).committed).toBeNull();
  await expect(page.locator('#seq-play')).toBeDisabled();await expect(page.locator('.chop-pad')).toHaveCount(0);
  await redo(page);await expectAt(page,after);await expect(page.locator('.chop-pad')).toHaveCount(4);
});
test('入力欄で打ちかけている間の⌘Zは、入力の取り消しになる',async({page})=>{
  await chopped(page);await setField(page,'[data-track-pitch="1"]',3);await settle(page);
  const field=page.locator('[data-track-pitch="1"]');await field.click();await field.press('End');await field.press('Backspace');await field.type('7');
  await expect(field).toHaveValue('7');await undo(page);
  await expect(field).not.toHaveValue('7');expect((await state(page)).tracks[1].pitch).toBe(3);expect((await state(page)).history.undo).toBe(2);
  // After the value is committed, ⌘Z undoes the app.
  await page.locator('body').click({position:{x:5,y:5}});await undo(page);await expect.poll(async()=>(await state(page)).tracks[1].pitch).toBe(0);
});
test('再生中にステップを戻しても再生は続き、表示の切り替えと書き出し設定は履歴に入らない',async({page})=>{
  await chopped(page);await page.locator('#seq-play').click();await expect.poll(async()=>(await state(page)).playing).toBe(true);
  await page.locator('[data-track-step="0"][data-step="2"]').click();await settle(page);
  await undo(page);await expect.poll(async()=>(await state(page)).tracks[0].steps[4]).toBe(false);expect((await state(page)).playing).toBe(true);
  await page.locator('#seq-stop').click();
  await page.locator('#export-format').selectOption('mp3');await page.locator('#view-compact').click();await page.locator('#view-detail').click();await page.waitForTimeout(100);
  expect((await state(page)).history.undo).toBe(1);
  // Undoing keeps the export settings as they are now.
  await page.locator('[data-track-step="0"][data-step="1"]').click();await undo(page);await expect(page.locator('#export-format')).toHaveValue('mp3');
});
test('保存した状態まで戻すと未保存の表示が消え、曲を読み込み直すと履歴が消える',async({page})=>{
  await chopped(page);
  await Promise.all([page.waitForEvent('download'),page.locator('#project-save').click()]);await expect(page.locator('#project-dirty')).toHaveText('');
  await page.locator('[data-track-step="0"][data-step="2"]').click();await expect(page.locator('#project-dirty')).toHaveText('未保存の変更あり',{timeout:5000});
  await undo(page);await expect(page.locator('#project-dirty')).toHaveText('');
  await page.locator('[data-track-step="0"][data-step="2"]').click();
  await page.getByRole('button',{name:'デモ音源を読み込む'}).click();await page.locator('#replace-yes').click();await expect(page.locator('#sample')).toBeEnabled();
  await expect(page.locator('#undo')).toBeDisabled();await expect(page.locator('#redo')).toBeDisabled();expect((await state(page)).history).toEqual({undo:0,redo:0});
});
