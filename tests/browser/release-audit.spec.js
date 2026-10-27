import {test,expect} from '@playwright/test';
import {build} from 'esbuild';
const harness=await build({entryPoints:['src/audio.js'],bundle:true,write:false,format:'iife',globalName:'releaseAudio',target:'es2022'});

test('再生準備中に停止した場合、準備完了後も停止を維持する',async({page})=>{
  await page.goto('/');await page.locator('#demo').click();await expect(page.locator('#sample')).toBeEnabled();await page.locator('#sample').click();await expect(page.locator('#seq-play')).toBeEnabled();
  // AudioContext.resume and pending worker transforms can complete after Stop.
  await page.evaluate(()=>{const e=window.futureFunkLab.engine,init=e.init.bind(e);e.init=async()=>{await new Promise(resolve=>setTimeout(resolve,250));return init();};});
  await page.locator('#seq-play').click();await page.locator('#seq-stop').click();
  await page.waitForTimeout(500);
  const result=await page.evaluate(()=>({playing:window.futureFunkLab.getState().playing,status:document.querySelector('#status').textContent}));
  console.log('stop-during-start',JSON.stringify(result));expect(result.playing).toBe(false);
});

test('ループOFFでは後半に置いた素材が先頭で先行して鳴らない',async({page})=>{
  await page.goto('/');await page.addScriptTag({content:harness.outputFiles[0].text});
  const result=await page.evaluate(async()=>{
    const rate=44100,offline=new OfflineAudioContext(2,rate,rate),engine=new releaseAudio.AudioEngine();engine.context=offline;engine.master=offline.destination;
    const buffer=offline.createBuffer(2,Math.round(rate*.6),rate);for(let c=0;c<2;c++)for(let i=0;i<buffer.length;i++)buffer.getChannelData(c)[i]=.2*Math.sin(2*Math.PI*440*i/rate);
    const track={index:0,steps:[false,false,false,false,false,false,true,false],mode:'overlap',eq:[0,0,0],volume:0,mute:false,solo:false};
    engine.configure([track],{low:300,high:3000,slope:12},[buffer],1);engine.start({bpm:120,lengthTicks:8,resolution:8,swing:50},false);clearInterval(engine.timer);
    const output=await offline.startRendering(),data=output.getChannelData(0);let earlyEnergy=0;for(let i=0;i<Math.round(rate*.3);i++)earlyEnergy+=data[i]**2;
    return {earlyRms:Math.sqrt(earlyEnergy/Math.round(rate*.3)),expectedFirstTriggerSeconds:.8};
  });
  console.log('non-loop-order',JSON.stringify(result));expect(result.earlyRms).toBeLessThan(1e-7);
});

test('再生準備中の素材削除でも、後から再生を開始しない',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/');await page.locator('#demo').click();await expect(page.locator('#sample')).toBeEnabled();await page.locator('#sample').click();await expect(page.locator('#seq-play')).toBeEnabled();
  await page.evaluate(()=>{const e=window.futureFunkLab.engine,init=e.init.bind(e);e.init=async()=>{await new Promise(resolve=>setTimeout(resolve,250));return init();};});
  await page.locator('#seq-play').click();await page.locator('#source-delete').click();await page.waitForTimeout(500);
  expect(await page.evaluate(()=>window.futureFunkLab.getState().playing)).toBe(false);expect(errors).toEqual([]);
});

test('境界の変更直後に書き出しても、新しい切り出し位置を使う',async({page})=>{
  await page.goto('/');await page.locator('#demo').click();await expect(page.locator('#sample')).toBeEnabled();await page.locator('#sample').click();await expect(page.locator('#export')).toBeEnabled();
  const download=page.waitForEvent('download');
  await page.evaluate(()=>{document.querySelector('#chop-wave').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));document.querySelector('#export').click();});
  await download;const s=await page.evaluate(()=>window.futureFunkLab.getState());expect(s.bufferDurations[0]).toBeCloseTo(2.001,4);
});

test('ループOFFへの切り替えは現在の周回位置を保ち、余韻を先頭へ折り返さない',async({page})=>{
  await page.goto('/');await page.addScriptTag({content:harness.outputFiles[0].text});
  const result=await page.evaluate(async()=>{
    const e=new releaseAudio.AudioEngine();await e.init();
    const ctx=e.context,b=ctx.createBuffer(2,Math.round(.6*ctx.sampleRate),ctx.sampleRate),t={index:0,steps:[false,false,false,false,false,false,true,false],mode:'overlap',eq:[0,0,0],volume:0};b.getChannelData(0).fill(.2);b.getChannelData(1).fill(.2);
    e.configure([t],{low:300,high:3000,slope:12},[b],1);e.start({bpm:120,lengthTicks:8,resolution:8,swing:50},true);
    e.started=ctx.currentTime-3.2;e.setLoop(false);
    const v=[...e.voices].find(v=>v.pattern&&!v.stopped),answer={elapsed:ctx.currentTime-e.started,loop:v.source.loop,earlyRms:v.buffer.getChannelData(0).subarray(0,Math.round(.7*ctx.sampleRate)).some(x=>x!==0),length:v.buffer.duration};e.stopAll();await ctx.close();return answer;
  });
  expect(result.elapsed).toBeCloseTo(.2,1);expect(result.loop).toBe(false);expect(result.earlyRms).toBe(false);expect(result.length).toBeCloseTo(1.35,4);
});
