import { test, expect } from '@playwright/test';
async function state(page){return page.evaluate(()=>window.futureFunkLab.getState());}
async function demo(page){await page.goto('/');await page.getByRole('button',{name:'デモ音源を読み込む'}).click();await expect(page.locator('#sample')).toBeEnabled();}
async function chopped(page){await demo(page);await page.locator('#sample').click();await expect(page.locator('#seq-play')).toBeEnabled();}
const previewing=(page,key)=>page.evaluate(key=>window.futureFunkLab.engine.preview.has(key),key);
// Bright pixels mean the waveform was drawn at a real size.
const drawnPixels=page=>page.locator('#chop-wave').evaluate(canvas=>{if(!canvas.width||!canvas.height)return 0;const data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let n=0;for(let i=0;i<data.length;i+=4)if(data[i+1]>120)n++;return n;});

test('初期はチョップ→シーケンサーを表示し、切り替えると音声分離と入れ替わる。選んだタブは再読み込み後も残る',async({page})=>{
  await page.goto('/');
  await expect(page.locator('#chop')).toBeVisible();await expect(page.locator('#sequence')).toBeVisible();await expect(page.locator('#separation')).toBeHidden();
  await expect(page.locator('#tab-chop')).toHaveAttribute('aria-selected','true');await expect(page.locator('#chop .section-number')).toHaveText('02');await expect(page.locator('#sequence .section-number')).toHaveText('03');
  await page.locator('#tab-separation').click();
  await expect(page.locator('#separation')).toBeVisible();await expect(page.locator('#chop')).toBeHidden();await expect(page.locator('#sequence')).toBeHidden();
  await expect(page.locator('#tab-separation')).toHaveAttribute('aria-selected','true');await expect(page.locator('#tab-chop')).toHaveAttribute('aria-selected','false');
  await expect(page.locator('#sampling')).toBeVisible();await expect(page.locator('#master-strip')).toBeVisible();
  await page.reload();await expect(page.locator('#separation')).toBeVisible();expect((await state(page)).tab).toBe('separation');
});
test('切り替えても、シーケンサーと分離パートの再生は止まらない',async({page})=>{
  await chopped(page);await page.locator('#seq-play').click();await expect.poll(async()=>(await state(page)).playing).toBe(true);
  await page.locator('#tab-separation').click();await page.waitForTimeout(300);expect((await state(page)).playing).toBe(true);
  // Space still plays and stops from the other tab.
  await page.locator('body').click({position:{x:5,y:5}});await page.keyboard.press('Space');await expect.poll(async()=>(await state(page)).playing).toBe(false);
  await page.locator('[data-part-play="0"]').click();await expect.poll(()=>previewing(page,'part-0')).toBe(true);
  await page.locator('#tab-chop').click();await page.waitForTimeout(300);expect(await previewing(page,'part-0')).toBe(true);
});
test('音声分離を開いたまま曲を読み込んでも、チョップ側に切り替えると波形が描かれている',async({page})=>{
  await page.goto('/');await page.locator('#tab-separation').click();
  await page.getByRole('button',{name:'デモ音源を読み込む'}).click();await expect(page.locator('#sample')).toBeEnabled();
  await page.locator('#sample').click();await expect(page.locator('#seq-play')).toBeEnabled();
  await page.locator('#tab-chop').click();await expect.poll(()=>drawnPixels(page)).toBeGreaterThan(1000);
});
test('←→キーでタブを移れ、タブの切り替えは元に戻すの履歴に入らない',async({page})=>{
  await chopped(page);const before=(await state(page)).history;
  await page.locator('#tab-chop').focus();await page.keyboard.press('ArrowRight');
  await expect(page.locator('#tab-separation')).toBeFocused();await expect(page.locator('#separation')).toBeVisible();
  await page.keyboard.press('ArrowLeft');await expect(page.locator('#tab-chop')).toBeFocused();await expect(page.locator('#chop')).toBeVisible();
  await page.locator('#tab-separation').click();await page.locator('#tab-chop').click();await page.waitForTimeout(100);
  expect((await state(page)).history).toEqual(before);
});
