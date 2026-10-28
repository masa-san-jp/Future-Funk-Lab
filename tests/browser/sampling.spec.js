import { test, expect } from '@playwright/test';
// These tests use every track's inline editor, which the detail view shows.
test.beforeEach(async({page})=>{await page.addInitScript(()=>{try{localStorage.setItem('ffl:view','detail');}catch{}});});
async function start(page){await page.goto('/');await page.locator('#demo').click();await expect(page.locator('#sample')).toBeEnabled();await page.locator('#source-wave').scrollIntoViewIfNeeded();}
async function state(page){return page.evaluate(()=>window.futureFunkLab.getState());}
async function zoom(page,value){await page.locator('#zoom').fill(String(value));await page.locator('#zoom').dispatchEvent('input');}
async function scroll(page,value){await page.locator('#wave-scroll').fill(String(value));await page.locator('#wave-scroll').dispatchEvent('input');}
async function drag(page,from,to){await page.mouse.move(from.x,from.y);await page.mouse.down();await page.mouse.move(to.x,to.y,{steps:8});await page.mouse.up();}

test('範囲外の原曲クリックから再生し、再生中のシークでも範囲を動かさない',async({page})=>{
  await start(page);
  await page.locator('#range-start').fill('1');await page.locator('#range-start').press('Tab');await page.locator('#range-end').fill('3');await page.locator('#range-end').press('Tab');
  await page.locator('#sample').click();await expect(page.locator('#seq-play')).toBeEnabled();
  const before=await state(page);const wave=page.locator('#source-wave');await wave.scrollIntoViewIfNeeded();let box=await wave.boundingBox();
  await page.mouse.click(box.x+box.width*.75,box.y+60);
  await expect.poll(async()=>(await state(page)).sourcePlaybackMode).toBe('full');
  const first=await page.evaluate(()=>{const v=window.futureFunkLab.engine.preview.get('source');return {offset:v.offset,length:v.buffer.duration};});
  expect(first.offset).toBeCloseTo(6,1);expect(first.length).toBe(8);
  await expect.poll(async()=>(await state(page)).sourcePlayhead).toBeGreaterThan(6.02);
  await page.mouse.click(box.x+box.width*.5,box.y+85);
  await expect.poll(async()=>page.evaluate(()=>window.futureFunkLab.engine.preview.get('source')?.offset)).toBeCloseTo(4,1);
  expect((await state(page)).range).toEqual(before.range);expect((await state(page)).committed).toEqual(before.committed);expect((await state(page)).points).toEqual(before.points);
  await page.locator('#source-stop').click();const paused=(await state(page)).sourcePlayhead;await expect(page.locator('#source-play')).toHaveAttribute('aria-pressed','false');
  await page.locator('#source-play').click();await expect.poll(async()=>page.evaluate(()=>window.futureFunkLab.engine.preview.get('source')?.offset)).toBeCloseTo(paused,1);
  await page.locator('#source-stop').click();
});

test('範囲の三角だけをドラッグし、範囲試聴と原曲の任意再生を使い分ける',async({page})=>{
  await start(page);const box=await page.locator('#source-wave').boundingBox();
  await drag(page,{x:box.x+2,y:box.y+8},{x:box.x+box.width*.25,y:box.y+8});
  expect((await state(page)).range[0]).toBeCloseTo(.25,2);expect((await state(page)).sourcePlaybackMode).toBeNull();
  await page.locator('#range-end').fill('4');await page.locator('#range-end').press('Tab');
  await page.locator('#source-loop').click();await page.locator('#source-range-play').click();
  await expect.poll(async()=>(await state(page)).sourcePlaybackMode).toBe('range');
  const preview=await page.evaluate(()=>{const v=window.futureFunkLab.engine.preview.get('source');return {start:v.sourceStart,length:v.buffer.duration,loop:v.loop};});
  expect(preview.start).toBeCloseTo(2,1);expect(preview.length).toBeCloseTo(2,1);expect(preview.loop).toBe(true);
  await page.mouse.click(box.x+box.width*.75,box.y+70);
  await expect.poll(async()=>(await state(page)).sourcePlaybackMode).toBe('full');
  expect(await page.evaluate(()=>window.futureFunkLab.engine.preview.get('source').loop)).toBe(false);
  await expect(page.locator('#source-range-play')).toHaveAttribute('aria-pressed','false');
});

test('拡大した波形は左右ドラッグ・横ホイール・スクロールバーで移動できる',async({page})=>{
  await start(page);await zoom(page,4);await scroll(page,.25);await page.locator('#source-tool-pan').click();await page.locator('#source-wave').scrollIntoViewIfNeeded();const box=await page.locator('#source-wave').boundingBox();const before=await state(page);
  await drag(page,{x:box.x+box.width*.7,y:box.y+65},{x:box.x+box.width*.3,y:box.y+65});
  expect((await state(page)).sourceScroll).toBeCloseTo(.35,2);expect((await state(page)).range).toEqual(before.range);expect((await state(page)).sourcePlaybackMode).toBeNull();
  await drag(page,{x:box.x+box.width*.3,y:box.y+65},{x:box.x+box.width*.7,y:box.y+65});expect((await state(page)).sourceScroll).toBeCloseTo(.25,2);
  await page.mouse.move(box.x+box.width*.5,box.y+70);await page.mouse.wheel(240,0);await expect.poll(async()=>(await state(page)).sourceScroll).toBeGreaterThan(.25);
  const panned=await state(page);expect(Number(await page.locator('#wave-scroll').inputValue())).toBeCloseTo(panned.sourceScroll,3);
  await scroll(page,.75);await page.mouse.click(box.x+box.width*.5,box.y+70);await expect.poll(async()=>page.evaluate(()=>window.futureFunkLab.engine.preview.get('source')?.offset)).toBeCloseTo(7,1);
  const origin=await page.evaluate(()=>window.futureFunkLab.engine.preview.get('source').origin);
  await drag(page,{x:box.x+box.width*.3,y:box.y+65},{x:box.x+box.width*.7,y:box.y+65});
  expect(await page.evaluate(()=>window.futureFunkLab.engine.preview.get('source').origin)).toBe(origin);
  expect((await state(page)).range).toEqual(before.range);
  await page.locator('#source-stop').click();await zoom(page,1);expect((await state(page)).sourceScroll).toBe(0);await expect(page.locator('#wave-scroll')).toBeDisabled();
});

test('クリックした再生位置を中心に拡大でき、停止中も再生位置を保持する',async({page})=>{
  await start(page);const box=await page.locator('#source-wave').boundingBox();await page.mouse.click(box.x+box.width*.75,box.y+70);await expect.poll(async()=>(await state(page)).sourcePlaybackMode).toBe('full');await page.locator('#source-stop').click();const paused=(await state(page)).sourcePlayhead;
  await zoom(page,8);const s=await state(page);expect(s.sourceScroll*8+.5).toBeCloseTo(paused,1);await expect(page.locator('#source-position')).toContainText('0:06.');
  await page.locator('#source-wave').focus();await page.keyboard.press('Home');await expect.poll(async()=>page.evaluate(()=>window.futureFunkLab.engine.preview.get('source')?.offset)).toBe(0);await page.keyboard.press('Space');await expect.poll(async()=>(await state(page)).sourcePlaybackMode).toBeNull();
});

test('実ファイルは原曲BPM・原速で読み込み、波形クリックで直ちに音が鳴る',async({page})=>{
  const {encodeWav}=await import('../../src/core.js');
  const rate=44100,length=rate*8;
  function file(bpm){
    const data=Float32Array.from({length},(_,i)=>{
      const t=i/rate,beat=t%(60/bpm);
      return .08*Math.sin(2*Math.PI*440*t)+.4*Math.exp(-beat*70)*Math.sin(2*Math.PI*130*t);
    });
    return {name:`original-${bpm}bpm.wav`,mimeType:'audio/wav',buffer:Buffer.from(encodeWav([data,data],rate))};
  }
  await page.goto('/');await page.locator('#global-bpm').fill('75');await page.locator('#global-bpm').press('Tab');
  const original=file(90);await page.locator('#source-file').setInputFiles(original);await expect(page.locator('#sample')).toBeEnabled();
  const loaded=await state(page);expect(loaded.sourceBpm).toBeGreaterThanOrEqual(89);expect(loaded.sourceBpm).toBeLessThanOrEqual(91);expect(loaded.bpm).toBe(loaded.sourceBpm);expect(loaded.duration).toBe(8);expect(loaded.tempoFollowsSource).toBe(true);
  await expect(page.locator('#global-bpm')).toHaveValue(String(loaded.sourceBpm));await expect(page.locator('#sequence-bpm')).toHaveText(String(loaded.sourceBpm));
  await page.locator('#source-wave').scrollIntoViewIfNeeded();let box=await page.locator('#source-wave').boundingBox();
  await page.mouse.click(box.x+box.width*.4,box.y+65);
  await expect.poll(async()=>page.evaluate(()=>window.futureFunkLab.engine.preview.get('source')?.offset)).toBeCloseTo(3.2,1);
  await expect.poll(async()=>page.evaluate(()=>{const e=window.futureFunkLab.engine,a=new Float32Array(1024);e.analysers[0].getFloatTimeDomainData(a);return Math.max(...a.map(Math.abs));})).toBeGreaterThan(.01);
  const samples=await page.evaluate(()=>{const v=window.futureFunkLab.engine.preview.get('source'),c=v.buffer.getChannelData(0);return [101,5000,11207,180100].map(i=>c[i]);});
  // PCM16 decoders differ by one LSB in positive-value normalization.
  for(const [j,i] of [101,5000,11207,180100].entries())expect(Math.abs(samples[j]-original.buffer.readInt16LE(44+i*4)/32768)).toBeLessThanOrEqual(1/32767);
  await page.locator('#source-stop').click();
  await page.locator('#source-bpm').fill('100');await page.locator('#source-bpm').press('Tab');await expect(page.locator('#sample')).toBeEnabled();expect((await state(page)).bpm).toBe(100);expect((await state(page)).duration).toBe(8);
  await page.locator('#global-bpm').fill('120');await page.locator('#global-bpm').press('Tab');await expect(page.locator('#sample')).toBeEnabled();expect((await state(page)).duration).toBeCloseTo(8*100/120,4);
  await page.locator('#source-bpm').fill('110');await page.locator('#source-bpm').press('Tab');await expect(page.locator('#sample')).toBeEnabled();expect((await state(page)).bpm).toBe(120);expect((await state(page)).duration).toBeCloseTo(8*110/120,4);
  await page.locator('#source-file').setInputFiles(file(150));await page.locator('#replace-yes').click();await expect(page.locator('#sample')).toBeEnabled();const replaced=await state(page);expect(replaced.bpm).toBe(replaced.sourceBpm);expect(replaced.sourceBpm).toBeGreaterThanOrEqual(149);expect(replaced.sourceBpm).toBeLessThanOrEqual(151);expect(replaced.duration).toBe(8);
});

test('小さな手ぶれを含むクリックと通常のclickイベントで原曲を再生できる',async({page})=>{
  await start(page);const box=await page.locator('#source-wave').boundingBox();
  await page.mouse.move(box.x+box.width*.5,box.y+65);await page.mouse.down();await page.mouse.move(box.x+box.width*.5+6,box.y+65,{steps:2});await page.mouse.up();
  await expect.poll(async()=>(await state(page)).sourcePlaybackMode).toBe('full');expect((await state(page)).range).toEqual([0,1]);
  await page.locator('#source-stop').click();
  await page.locator('#source-wave').dispatchEvent('click',{clientX:box.x+box.width*.25,clientY:box.y+80,detail:1});
  await expect.poll(async()=>page.evaluate(()=>window.futureFunkLab.engine.preview.get('source')?.offset)).toBeCloseTo(2,1);
});

test('波形本体のドラッグで範囲を選び、その範囲を試聴・サンプリングできる',async({page})=>{
  await start(page);await expect(page.locator('#source-tool-select')).toHaveAttribute('aria-pressed','true');
  const box=await page.locator('#source-wave').boundingBox();
  await drag(page,{x:box.x+box.width*.25,y:box.y+60},{x:box.x+box.width*.60,y:box.y+60});
  let selected=await state(page);expect(selected.range[0]).toBeCloseTo(.25,2);expect(selected.range[1]).toBeCloseTo(.60,2);expect(selected.sourcePlaybackMode).toBeNull();expect(selected.sourceScroll).toBe(0);
  await expect(page.locator('#range-start')).toHaveValue((selected.range[0]*8).toFixed(3));await expect(page.locator('#range-end')).toHaveValue((selected.range[1]*8).toFixed(3));
  await page.locator('#source-range-play').click();
  const preview=await page.evaluate(()=>{const v=window.futureFunkLab.engine.preview.get('source');return {start:v.sourceStart,duration:v.buffer.duration};});
  expect(preview.start).toBeCloseTo(selected.range[0]*8,4);expect(preview.duration).toBeCloseTo((selected.range[1]-selected.range[0])*8,4);await page.locator('#source-stop').click();
  await page.locator('#sample').click();await expect(page.locator('#seq-play')).toBeEnabled();selected=await state(page);expect(selected.committed[0]).toBeCloseTo(.25,2);expect(selected.committed[1]).toBeCloseTo(.60,2);selected.bufferDurations.forEach(length=>expect(length).toBeCloseTo((selected.range[1]-selected.range[0])*8/4,4));
  await page.locator('#source-wave').scrollIntoViewIfNeeded();const nextBox=await page.locator('#source-wave').boundingBox();
  await page.mouse.click(nextBox.x+nextBox.width*.8,nextBox.y+70);await expect.poll(async()=>(await state(page)).sourcePlaybackMode).toBe('full');expect((await state(page)).range).toEqual(selected.range);await page.locator('#source-stop').click();
  await drag(page,{x:nextBox.x+nextBox.width*.75,y:nextBox.y+80},{x:nextBox.x+nextBox.width*.40,y:nextBox.y+80});
  const reverse=await state(page);expect(reverse.range[0]).toBeCloseTo(.40,2);expect(reverse.range[1]).toBeCloseTo(.75,2);expect(reverse.committed).toEqual(selected.committed);expect(reverse.sourcePlaybackMode).toBeNull();
});

test('拡大中も直接範囲選択でき、境界線で微調整しShiftドラッグで左右移動できる',async({page})=>{
  await start(page);await zoom(page,4);await scroll(page,.25);const box=await page.locator('#source-wave').boundingBox();
  await drag(page,{x:box.x+box.width*.20,y:box.y+80},{x:box.x+box.width*.80,y:box.y+80});
  let selected=await state(page);expect(selected.range[0]).toBeCloseTo(.30,2);expect(selected.range[1]).toBeCloseTo(.45,2);expect(selected.sourceScroll).toBe(.25);
  await drag(page,{x:box.x+box.width*.20,y:box.y+65},{x:box.x+box.width*.30,y:box.y+65});
  selected=await state(page);expect(selected.range[0]).toBeCloseTo(.325,2);expect(selected.range[1]).toBeCloseTo(.45,2);
  await page.keyboard.down('Shift');try{await drag(page,{x:box.x+box.width*.70,y:box.y+65},{x:box.x+box.width*.30,y:box.y+65});}finally{await page.keyboard.up('Shift');}
  const panned=await state(page);expect(panned.sourceScroll).toBeCloseTo(.35,2);expect(panned.range).toEqual(selected.range);expect(panned.sourcePlaybackMode).toBeNull();expect(panned.sourceTool).toBe('select');
});

test('両マーカーが画面外でも拡大波形の任意位置を始点・終点として直接指定できる',async({page})=>{
  await start(page);await zoom(page,16);await scroll(page,.5);
  await page.locator('#source-tool-start').click();await expect(page.locator('#source-tool-start')).toHaveAttribute('aria-pressed','true');
  await page.locator('#source-wave').scrollIntoViewIfNeeded();let box=await page.locator('#source-wave').boundingBox();
  await page.mouse.click(box.x+box.width*.4,box.y+70);
  const withStart=await state(page);expect(withStart.range[0]*8).toBeCloseTo(4.2,2);expect(withStart.range[1]).toBe(1);expect(withStart.sourceScroll).toBe(.5);expect(withStart.sourceZoom).toBe(16);expect(withStart.sourcePlaybackMode).toBeNull();expect(withStart.sourceTool).toBe('select');
  await scroll(page,.8);await page.locator('#source-tool-end').click();box=await page.locator('#source-wave').boundingBox();
  await page.mouse.click(box.x+box.width*.6,box.y+80);
  const both=await state(page);expect(both.range[0]).toBe(withStart.range[0]);expect(both.range[1]*8).toBeCloseTo(6.7,2);expect(both.sourceScroll).toBe(.8);expect(both.sourceZoom).toBe(16);expect(both.sourcePlaybackMode).toBeNull();
  await page.locator('#sample').click();await expect(page.locator('#seq-play')).toBeEnabled();const sampled=await state(page);expect(sampled.committed).toEqual(both.range);sampled.bufferDurations.forEach(seconds=>expect(seconds).toBeCloseTo((both.range[1]-both.range[0])*8/4,4));
});

test('拡大波形の右クリックで指定した位置だけを始点または終点にする',async({page})=>{
  await start(page);await zoom(page,8);await scroll(page,.25);let box=await page.locator('#source-wave').boundingBox();
  await page.mouse.click(box.x+box.width*.3,box.y+65,{button:'right'});await expect(page.locator('#source-endpoint-menu')).toBeVisible();
  await page.getByRole('menuitem',{name:'この位置を始点にする'}).click();const started=await state(page);expect(started.range[0]*8).toBeCloseTo(2.3,2);expect(started.range[1]).toBe(1);expect(started.sourcePlaybackMode).toBeNull();await expect(page.locator('#source-endpoint-menu')).toBeHidden();
  await scroll(page,.625);box=await page.locator('#source-wave').boundingBox();await page.mouse.click(box.x+box.width*.7,box.y+85,{button:'right'});
  await page.getByRole('menuitem',{name:'この位置を終点にする'}).click();const ended=await state(page);expect(ended.range[0]).toBe(started.range[0]);expect(ended.range[1]*8).toBeCloseTo(5.7,2);expect(ended.sourcePlaybackMode).toBeNull();
  box=await page.locator('#source-wave').boundingBox();await page.mouse.click(box.x+box.width*.9,box.y+80,{button:'right'});await page.keyboard.press('Escape');expect((await state(page)).range).toEqual(ended.range);await expect(page.locator('#source-endpoint-menu')).toBeHidden();
  await page.mouse.click(box.x+box.width*.4,box.y+65);await expect.poll(async()=>(await state(page)).sourcePlaybackMode).toBe('full');expect((await state(page)).range).toEqual(ended.range);
});

test('新しい始点・終点が以前の範囲の外でも指定でき、長さを正に保つ',async({page})=>{
  await start(page);await page.locator('#range-end').fill('2');await page.locator('#range-end').press('Tab');await zoom(page,8);await scroll(page,.75);
  await page.locator('#source-tool-start').click();let box=await page.locator('#source-wave').boundingBox();await page.mouse.click(box.x+box.width*.5,box.y+80);
  let selected=await state(page);expect(selected.range[0]*8).toBeCloseTo(6.5,2);expect(selected.range[1]*8).toBe(8);
  await scroll(page,.125);await page.locator('#source-tool-end').click();box=await page.locator('#source-wave').boundingBox();await page.mouse.click(box.x+box.width*.2,box.y+80);
  selected=await state(page);expect(selected.range[0]).toBe(0);expect(selected.range[1]*8).toBeCloseTo(1.2,2);expect(selected.sourceZoom).toBe(8);expect(selected.sourcePlaybackMode).toBeNull();
});

test('チョップのループ試聴は常に1つで、同じボタンは停止、シーケンサー開始で試聴を解除する',async({page})=>{
  await start(page);await page.locator('#sample').click();await expect(page.locator('#seq-play')).toBeEnabled();
  const keys=()=>page.evaluate(()=>[...window.futureFunkLab.engine.preview.keys()].filter(k=>k.startsWith('pad-')));
  await page.locator('[data-pad="0"]').click();await expect.poll(keys).toEqual(['pad-0']);
  await page.locator('[data-pad="1"]').click();await expect.poll(keys).toEqual(['pad-1']);await expect(page.locator('[data-pad="0"]')).toHaveAttribute('aria-pressed','false');await expect(page.locator('.chop-pad.active')).toHaveCount(1);
  await page.locator('[data-pad="1"]').click();await expect.poll(keys).toEqual([]);await expect(page.locator('.chop-pad.active')).toHaveCount(0);
  await page.evaluate(()=>{document.querySelector('[data-pad="0"]').click();document.querySelector('[data-pad="2"]').click();document.querySelector('[data-pad="1"]').click();});await expect.poll(keys).toEqual(['pad-1']);await expect(page.locator('.chop-pad.active')).toHaveCount(1);
  await page.locator('[data-track-step="0"][data-step="0"]').click();await page.locator('#seq-play').click();await expect.poll(keys).toEqual([]);await expect(page.locator('.chop-pad.active')).toHaveCount(0);expect((await state(page)).playing).toBe(true);
  const timing=await page.evaluate(()=>{const e=window.futureFunkLab.engine;return [...e.voices].filter(v=>!v.key&&!v.stopped).map(v=>({when:v.when,start:e.started}));});expect(timing.length).toBeGreaterThan(0);expect(timing[0].when).toBeCloseTo(timing[0].start,6);
});

test('途中から切り出した素材の分割位置は、選択した拍頭からの8分音符に揃う',async({page})=>{
  await start(page);await page.locator('#range-start').fill('0.137');await page.locator('#range-start').press('Tab');await page.locator('#range-end').fill('4.137');await page.locator('#range-end').press('Tab');
  await page.locator('#sample').click();await expect(page.locator('#seq-play')).toBeEnabled();
  await page.locator('#chop-wave').focus();await page.keyboard.press('ArrowRight');await expect(page.locator('#status')).toContainText('チョップ位置');
  await page.locator('#snap').check();await expect(page.locator('#seq-play')).toBeEnabled();
  const aligned=await state(page);expect(aligned.points[0]*8).toBeCloseTo(.137,4);expect(aligned.points.at(-1)*8).toBeCloseTo(4.137,4);
  for(const point of aligned.points.slice(1,-1)){const eighths=(point*8-.137)/.25;expect(eighths).toBeCloseTo(Math.round(eighths),6);}
  await page.locator('#chop-count').selectOption('8');await expect(page.locator('.chop-pad')).toHaveCount(8);await expect(page.locator('#seq-play')).toBeEnabled();
  const divided=await state(page);divided.points.forEach((point,i)=>expect(point*8).toBeCloseTo(.137+i*.5,4));
});

test('チョップの再生線・区間内時刻・進行バーが音声に追従してループで折り返す',async({page})=>{
  await start(page);await page.locator('#range-start').fill('2');await page.locator('#range-start').press('Tab');await page.locator('#range-end').fill('3.6');await page.locator('#range-end').press('Tab');await page.locator('#sample').click();await expect(page.locator('#seq-play')).toBeEnabled();
  await page.locator('[data-pad="2"]').click();await expect(page.locator('#chop-position')).toContainText('区間3');
  const samples=await page.evaluate(()=>new Promise(resolve=>{
    const frames=[],start=performance.now(),canvas=document.getElementById('chop-wave');
    function frame(){
      const state=window.futureFunkLab.getState(),p=state.chopPlayback;
      if(p){
        const row=canvas.getContext('2d').getImageData(0,Math.round(38*canvas.height/canvas.clientHeight),canvas.width,1).data,columns=[];
        for(let x=Math.floor(canvas.width*.45);x<canvas.width;x++)if(row[x*4]>220&&row[x*4+1]>220&&row[x*4+2]>220)columns.push(x);
        frames.push({p,progress:document.getElementById('chop-progress').value,line:columns.length?columns.reduce((a,b)=>a+b)/columns.length:null});
      }
      if(performance.now()-start>1050)resolve(frames);else requestAnimationFrame(frame);
    }requestAnimationFrame(frame);
  }));
  expect(samples.length).toBeGreaterThan(15);expect(samples.every(s=>s.p.position>=.8&&s.p.position<1.2001)).toBe(true);expect(Math.min(...samples.map(s=>s.progress))).toBeLessThan(.15);expect(Math.max(...samples.map(s=>s.progress))).toBeGreaterThan(.8);
  expect(samples.filter((s,i)=>i>0&&s.progress<samples[i-1].progress-.5).length).toBeGreaterThanOrEqual(2);
  const lines=samples.map(s=>s.line).filter(x=>x!=null);expect(lines.length).toBeGreaterThan(10);expect(Math.max(...lines)-Math.min(...lines)).toBeGreaterThan(50);
  await page.locator('[data-pad="1"]').click();await expect(page.locator('#chop-position')).toContainText('区間2');expect((await state(page)).chopPlayback.start).toBeCloseTo(.4,4);
  await page.locator('[data-pad="1"]').click();await expect(page.locator('#chop-position')).toHaveText('停止中');expect((await state(page)).chopPlayback).toBeNull();expect(await page.locator('#chop-progress').evaluate(e=>e.value)).toBe(0);
});

test('チョップの境界を試聴中に微調整しても、ループと再生位置表示が継続する',async({page})=>{
  await start(page);await page.locator('#range-end').fill('1.6');await page.locator('#range-end').press('Tab');await page.locator('#sample').click();await expect(page.locator('#seq-play')).toBeEnabled();await page.locator('[data-pad="0"]').click();await expect(page.locator('#chop-position')).toContainText('区間1');
  await page.locator('#chop-wave').focus();await page.keyboard.press('Shift+ArrowRight');await expect(page.locator('#status')).toContainText('チョップ位置を更新しました');
  const playback=(await state(page)).chopPlayback;expect(playback).not.toBeNull();expect(playback.index).toBe(0);expect(playback.duration).toBeCloseTo(.410,3);await expect(page.locator('[data-pad="0"]')).toHaveAttribute('aria-pressed','true');await expect(page.locator('#chop-position')).toContainText('区間1');
  const text=await page.locator('#chop-position').textContent();await expect.poll(()=>page.locator('#chop-position').textContent()).not.toBe(text);
  await page.locator('#seq-stop').click();await expect(page.locator('#chop-position')).toHaveText('停止中');expect((await state(page)).chopPlayback).toBeNull();
});
