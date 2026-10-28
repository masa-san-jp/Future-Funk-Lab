import { test, expect } from '@playwright/test';
test.beforeEach(async({page})=>{await page.addInitScript(()=>{try{localStorage.setItem('ffl:view','detail');}catch{}});});
async function state(page){return page.evaluate(()=>window.futureFunkLab.getState());}
async function demo(page){await page.goto('/');await page.getByRole('button',{name:'デモ音源を読み込む'}).click();await expect(page.locator('#sample')).toBeEnabled();}
async function chopped(page){await demo(page);await page.locator('#sample').click();await expect(page.locator('#seq-play')).toBeEnabled();}
const playing=page=>expect.poll(async()=>(await state(page)).playing);
const sourcePlaying=page=>expect.poll(async()=>(await state(page)).sourcePlaybackMode!=null);

test('スペースでシーケンサーを再生し、もう一度で止める',async({page})=>{
  await chopped(page);await page.locator('body').click({position:{x:5,y:5}});
  await page.keyboard.press('Space');await playing(page).toBe(true);
  await page.keyboard.press('Space');await playing(page).toBe(false);
  await expect(page.locator('#shortcut-hint')).toHaveText('Space：再生/停止 ／ ⌘Z：元に戻す ／ ⇧⌘Z：やり直す ／ ⌘S：保存');await expect(page.locator('#seq-play')).toHaveAttribute('title','Space');
});
test('ステップを押した直後のスペースは、ステップを切り替えずに再生する',async({page})=>{
  await chopped(page);const step=page.locator('[data-track-step="0"][data-step="2"]');
  await step.click();await expect(step).toBeFocused();const steps=(await state(page)).tracks[0].steps;
  await page.keyboard.press('Space');await playing(page).toBe(true);
  await page.keyboard.press('Space');await playing(page).toBe(false);
  expect((await state(page)).tracks[0].steps).toEqual(steps);await expect(step).toHaveAttribute('aria-pressed','true');
  // Enter still presses the focused button.
  await page.keyboard.press('Enter');await expect(step).toHaveAttribute('aria-pressed','false');
});
test('入力欄と選択肢にフォーカスがあるときは、スペースで再生しない',async({page})=>{
  await chopped(page);
  for(const selector of ['#global-bpm','#swing','#chop-count','#snap']){
    await page.locator(selector).focus();await page.keyboard.press('Space');await page.waitForTimeout(300);
    expect((await state(page)).playing,selector).toBe(false);
  }
  // A checkbox keeps its own Space behaviour.
  await expect(page.locator('#snap')).toBeChecked();
});
test('チョップ前は原曲を再生/停止し、押しっぱなしでは繰り返さない',async({page})=>{
  await demo(page);await page.locator('body').click({position:{x:5,y:5}});
  await page.keyboard.press('Space');await sourcePlaying(page).toBe(true);
  await page.keyboard.press('Space');await sourcePlaying(page).toBe(false);
  await page.keyboard.down('Space');await page.keyboard.down('Space');await page.keyboard.down('Space');await page.keyboard.up('Space');
  await sourcePlaying(page).toBe(true);await page.waitForTimeout(300);expect((await state(page)).sourcePlaybackMode).not.toBeNull();
  // The source waveform keeps handling Space by itself, toggling once.
  await page.locator('#source-wave').focus();await page.keyboard.press('Space');await sourcePlaying(page).toBe(false);
});
test('⌘やCtrlと一緒のスペースには反応しない',async({page})=>{
  await chopped(page);await page.locator('body').click({position:{x:5,y:5}});
  await page.keyboard.press('Control+Space');await page.keyboard.press('Meta+Space');await page.waitForTimeout(300);
  expect((await state(page)).playing).toBe(false);
});
