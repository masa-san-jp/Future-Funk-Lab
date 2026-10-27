import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
const harness=await build({entryPoints:['src/audio.js'],bundle:true,write:false,format:'iife',globalName:'audioTest',target:'es2022'});
test('長いサンプルの重ねる／切ると、前周からの音を含むループ書き出し',async({page})=>{
  await page.goto('/');await page.addScriptTag({content:harness.outputFiles[0].text});
  const result=await page.evaluate(async()=>{
    const context=new AudioContext({sampleRate:44100}),rate=context.sampleRate,buffer=context.createBuffer(2,rate,rate);
    for(let c=0;c<2;c++){const data=buffer.getChannelData(c);for(let i=0;i<data.length;i++)data[i]=.2*Math.sin(2*Math.PI*440*i/rate);}
    const ticks=steps=>steps.flatMap(on=>[on,false]);
    const track={index:0,steps:ticks([true,true,false,false]),eq:[0,0,0],volume:0,mute:false,solo:false,mode:'overlap'};
    const params={tracks:[track],buffers:[buffer],count:1,settings:{low:300,high:3000,slope:12},timing:{bpm:120,lengthTicks:8,resolution:8,swing:50},masterDb:0,rate};
    const rms=data=>{let n=0,total=0;for(let i=rate*.4;i<rate*.7;i++){total+=data[Math.floor(i)]**2;n++;}return Math.sqrt(total/n);};
    const overlap=await audioTest.renderPattern(params);track.mode='cut';const cut=await audioTest.renderPattern(params);
    track.steps=ticks([false,false,false,true]);const last=await audioTest.renderPattern(params);
    await context.close();return {overlap:rms(overlap[0]),cut:rms(cut[0]),length:last[0].length,tail:last[0].at(-1),before:last[0].slice(0,Math.round(.74*rate)).some(x=>x!==0),after:last[0].slice(Math.round(.8*rate),Math.round(.9*rate)).some(x=>Math.abs(x)>.01)};
  });
  expect(result.overlap/result.cut).toBeCloseTo(2,1);expect(result.length).toBe(44100);expect(Number.isFinite(result.tail)).toBe(true);expect(result.before).toBe(true);expect(result.after).toBe(true);
});

test('トラック試聴中のピッチ変更で発音が継続し、再生位置と長さを保持する',async({page})=>{
  await page.goto('/');await page.locator('#demo').click();await expect(page.locator('#sample')).toBeEnabled();await page.locator('#sample').click();await expect(page.locator('#seq-play')).toBeEnabled();
  await page.locator('[data-track-loop="0"]').click();await page.locator('[data-track-play="0"]').click();
  const before=await page.evaluate(()=>{const e=window.futureFunkLab.engine,v=e.preview.get('track-0');return {origin:v.origin,duration:v.buffer.duration};});
  await page.locator('[data-track-pitch="0"]').fill('12');await page.locator('[data-track-pitch="0"]').press('Tab');await expect(page.locator('#status')).toContainText('長さを維持');
  const after=await page.evaluate(()=>{const e=window.futureFunkLab.engine,v=e.preview.get('track-0');return {origin:v.origin,duration:v.buffer.duration,loop:v.loop,stopped:v.stopped,voices:e.voices.size};});
  expect(after.origin).toBe(before.origin);expect(after.duration).toBe(before.duration);expect(after.loop).toBe(true);expect(after.stopped).toBe(false);expect(after.voices).toBeGreaterThanOrEqual(1);
  await page.locator('[data-track-stop="0"]').click();
});


test('画面処理が1秒停止しても音声ループは欠落せず、周回フレーム数を維持する',async({page})=>{
  await page.goto('/');await page.addScriptTag({content:harness.outputFiles[0].text});
  const result=await page.evaluate(async()=>{
    const engine=new audioTest.AudioEngine();await engine.init();
    const ctx=engine.context,buffer=ctx.createBuffer(2,Math.round(ctx.sampleRate*.613),ctx.sampleRate);
    const track={index:0,steps:Array.from({length:16},(_,i)=>i%2===0),mode:'overlap',eq:[0,0,0],volume:0};
    engine.configure([track],{low:300,high:3000,slope:12},[buffer],1);engine.start({bpm:137,lengthTicks:16,resolution:8,swing:50},true);
    const voice=[...engine.voices].find(v=>v.pattern),started=engine.started;
    const until=performance.now()+1100;while(performance.now()<until){}
    engine.schedule();
    const answer={nativeLoop:voice.source.loop,stopped:voice.stopped,voices:[...engine.voices].filter(v=>v.pattern&&!v.stopped).length,frames:voice.buffer.length,expected:Math.round(8*30/137*ctx.sampleRate),phaseError:Math.abs(engine.position-(ctx.currentTime-started)%voice.buffer.duration)};
    engine.stopAll();await ctx.close();return answer;
  });
  expect(result.nativeLoop).toBe(true);expect(result.stopped).toBe(false);expect(result.voices).toBe(1);expect(result.frames).toBe(result.expected);expect(result.phaseError).toBeLessThan(.02);
});

test('実際にレンダーした連続4周の全サンプルが同一位相で繰り返す',async({page})=>{
  await page.goto('/');await page.addScriptTag({content:harness.outputFiles[0].text});
  const result=await page.evaluate(async()=>{
    const rate=44100,bpm=137,steps=8,length=Math.round(steps*30/bpm*rate),ctx=new OfflineAudioContext(2,length*4,rate);
    const input=ctx.createBuffer(2,Math.round(rate*2.13),rate);
    for(let c=0;c<2;c++)for(let i=0;i<input.length;i++)input.getChannelData(c)[i]=.1*Math.sin(i*.021+c)*Math.exp(-i/(rate*2));
    const track={steps:[true,false,false,true,false,false,false,true].flatMap(on=>[on,false]),mode:'overlap'};
    const cycle=audioTest.patternTrack(ctx,input,track,{bpm,lengthTicks:steps*2,resolution:8,swing:50}),source=ctx.createBufferSource();source.buffer=cycle;source.loop=true;source.connect(ctx.destination);source.start();
    const rendered=await ctx.startRendering();let maxError=0,boundaryEnergy=0;
    for(let c=0;c<2;c++){const data=rendered.getChannelData(c);for(let i=0;i<data.length;i++)maxError=Math.max(maxError,Math.abs(data[i]-cycle.getChannelData(c)[i%length]));for(let i=length-100;i<length+100;i++)boundaryEnergy+=data[i]**2;}
    return {maxError,boundaryEnergy,length};
  });
  expect(result.maxError).toBeLessThan(1e-6);expect(result.boundaryEnergy).toBeGreaterThan(.01);
});
