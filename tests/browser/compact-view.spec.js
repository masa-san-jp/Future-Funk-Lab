import { test, expect } from '@playwright/test';
async function state(page){return page.evaluate(()=>window.futureFunkLab.getState());}
async function prepare(page){
  await page.setViewportSize({width:1440,height:900});
  await page.goto('/');await page.locator('#demo').click();await expect(page.locator('#sample')).toBeEnabled();
  await page.locator('#sample').click();await expect(page.locator('#seq-play')).toBeEnabled();
}
test('1440×900で8トラックのステップ行がスクロールなしで同時に見える',async({page})=>{
  await prepare(page);
  expect((await state(page)).view).toBe('compact');await expect(page.locator('#view-compact')).toHaveAttribute('aria-pressed','true');
  const layout=await page.evaluate(()=>{
    const rows=[...document.querySelectorAll('#tracks .track-row')],header=document.querySelector('header').getBoundingClientRect().bottom;
    window.scrollBy(0,rows[0].getBoundingClientRect().top-header-8);
    const first=rows[0].getBoundingClientRect(),last=rows[7].getBoundingClientRect(),master=document.querySelector('#master-strip').getBoundingClientRect().top;
    return {count:rows.length,span:last.bottom-first.top,firstTop:first.top,lastBottom:last.bottom,headerBottom:document.querySelector('header').getBoundingClientRect().bottom,master};
  });
  expect(layout.count).toBe(8);expect(layout.span).toBeLessThanOrEqual(400);
  expect(layout.firstTop).toBeGreaterThanOrEqual(layout.headerBottom);expect(layout.lastBottom).toBeLessThanOrEqual(layout.master);
  await expect(page.locator('[data-track-step="7"][data-step="15"]')).toBeInViewport();
  const fonts=await page.evaluate(()=>Math.min(...[...document.querySelectorAll('.track-row.compact .step, .track-row.compact .track-select, .track-buttons button')].map(e=>parseFloat(getComputedStyle(e).fontSize))));
  expect(fonts).toBeGreaterThanOrEqual(11);
});
test('TRACK 03を選んでPITCHを変えると、TRACK 03だけが変わる',async({page})=>{
  await prepare(page);
  await expect(page.locator('#track-editor')).toContainText('編集中：TRACK 01');
  await page.locator('[data-track-select="2"]').click();
  await expect(page.locator('#track-editor')).toContainText('編集中：TRACK 03');await expect(page.locator('[data-track="2"]')).toHaveClass(/selected/);
  await expect(page.locator('[data-track-pitch]')).toHaveCount(1);
  await page.locator('[data-track-pitch="2"]').fill('5');await page.locator('[data-track-pitch="2"]').press('Tab');
  await expect(page.locator('#status')).toContainText('トラック3のピッチを更新しました');
  expect((await state(page)).tracks.map(t=>t.pitch)).toEqual([0,0,5,0,0,0,0,0]);
  await page.locator('[data-track-step="2"][data-step="0"]').click();await page.locator('[data-track-mute="2"]').click();
  const current=await state(page);expect(current.tracks[2].steps[0]).toBe(true);expect(current.tracks[2].mute).toBe(true);
  await page.locator('#chop-count').selectOption('2');await expect(page.locator('#track-editor')).toContainText('編集中：TRACK 01');
});
test('詳細表示に切り替えると全トラックの編集部品が並び、再読み込み後も残る',async({page})=>{
  await prepare(page);await page.locator('[data-track-select="1"]').click();await page.locator('[data-track-pitch="1"]').fill('-4');await page.locator('[data-track-pitch="1"]').press('Tab');
  await page.locator('#view-detail').click();
  await expect(page.locator('#track-editor')).toBeHidden();await expect(page.locator('[data-track-pitch]')).toHaveCount(8);await expect(page.locator('[data-track-stop]')).toHaveCount(8);
  await expect(page.locator('[data-track-pitch="1"]')).toHaveValue('-4');
  await page.reload();await expect(page.locator('#view-detail')).toHaveAttribute('aria-pressed','true');await expect(page.locator('[data-track-pitch]')).toHaveCount(8);
  expect((await state(page)).view).toBe('detail');
  await page.locator('#view-compact').click();await page.reload();expect((await state(page)).view).toBe('compact');
});
