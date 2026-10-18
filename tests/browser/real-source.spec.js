import {test,expect} from '@playwright/test';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {build} from 'esbuild';

const sourcePath=process.env.FFL_VERIFY_SOURCE;
const harness=await build({entryPoints:['src/audio.js'],bundle:true,write:false,format:'iife',globalName:'audioTest',target:'es2022'});
test('実素材の1.808秒チョップを配置に同期し、試聴・連続再生・WAVの波形を照合する',async({page})=>{
  test.skip(!sourcePath,'FFL_VERIFY_SOURCEで検証対象のローカル音源を指定');
  await page.goto('/');await page.locator('#source-file').setInputFiles(sourcePath);await expect(page.locator('#sample')).toBeEnabled();
  await page.locator('#range-start').fill('83.885');await page.locator('#range-start').press('Tab');
  await page.locator('#range-end').fill('90.689');await page.locator('#range-end').press('Tab');
  await page.locator('#sample').click();await expect(page.locator('#seq-play')).toBeEnabled();
  await page.locator('#chop-wave').focus();
  for(let i=0;i<10;i++)await page.keyboard.press('Shift+ArrowRight');
  for(let i=0;i<7;i++)await page.keyboard.press('ArrowRight');
  await expect(page.locator('#status')).toContainText('チョップ位置');
  const before=await page.evaluate(()=>window.futureFunkLab.getState());expect(before.bufferDurations[0]).toBeCloseTo(1.808,3);
  for(const s of [0,4,8])await page.locator(`[data-track-step="0"][data-step="${s}"]`).click();
  await page.locator('[data-track-step="3"][data-step="12"]').click();
  await page.locator('[data-pad="0"]').click();await expect(page.locator('[data-pad="0"]')).toHaveAttribute('aria-pressed','true');
  const preview=await page.evaluate(()=>{const {engine:e,getState}=window.futureFunkLab,v=e.preview.get('pad-0');return {state:getState(),frames:v.buffer.length,period:v.buffer.duration};});
  expect(preview.state.points).toEqual(before.points);expect(preview.state.syncSpans[0]).toBe(4);expect(preview.state.syncSpans[3]).toBe(4);
  expect(preview.period).toBeCloseTo(4*30/95,4);expect(preview.frames).toBe(Math.round(Math.round(16*30/95*44100)/4));
  await page.locator('#seq-play').click();await expect.poll(()=>page.evaluate(()=>window.futureFunkLab.getState().playing)).toBe(true);
  await page.addScriptTag({content:harness.outputFiles[0].text});
  const rendered=await page.evaluate(async()=>{
    const e=window.futureFunkLab.engine,state=window.futureFunkLab.getState(),voices=[...e.voices].filter(v=>v.pattern&&!v.stopped),rate=e.context.sampleRate,length=voices[0].buffer.length;
    const context=new OfflineAudioContext(2,length*6,rate),master=context.createGain();master.gain.value=10**(e.masterDb/20);master.connect(context.destination);
    for(const v of voices){const graph=audioTest.makeTrackGraph(context,state.tracks[v.track],e.settings,master),source=context.createBufferSource();source.buffer=v.buffer;source.loop=true;source.connect(graph.input);source.start();}
    const output=await context.startRendering();let cycleError=0,referenceError=0;
    const voice=voices.find(v=>v.track===0),clip=e.buffers[0].chopPreview,reference=new Float32Array(length);
    for(const step of [0,4,8]){const first=Math.round(step*length/16);for(let i=0;i<clip.length;i++)reference[(first+i)%length]+=clip.getChannelData(0)[i];}
    for(let i=0;i<length;i++)referenceError=Math.max(referenceError,Math.abs(reference[i]-voice.buffer.getChannelData(0)[i]));
    for(let c=0;c<2;c++){const data=output.getChannelData(c);for(let i=length*3;i<data.length;i++)cycleError=Math.max(cycleError,Math.abs(data[i]-data[length*2+i%length]));}
    return {rate,length,cycleError,referenceError,period:voice.buffer.duration,clipPeriod:clip.duration,pcm:[0,1].map(c=>Array.from(output.getChannelData(c).subarray(length*5,length*6)))};
  });
  expect(rendered.cycleError).toBeLessThan(1e-6);expect(rendered.referenceError).toBeLessThan(1e-6);
  const downloading=page.waitForEvent('download');await page.locator('#export').click();const download=await downloading,wav=await readFile(await download.path());
  const frames=wav.readUInt32LE(40)/4;expect(frames).toBe(rendered.length);
  let wavError=0,energy=0;for(let i=0;i<frames;i++)for(let c=0;c<2;c++){const x=wav.readInt16LE(44+i*4+c*2)/32768;wavError=Math.max(wavError,Math.abs(x-rendered.pcm[c][i]));energy+=x*x;}
  expect(wavError).toBeLessThan(2/32768);expect(energy/frames).toBeGreaterThan(.001);
  const evidence={sourceName:await page.locator('#source-name').textContent(),bpm:preview.state.bpm,rate:rendered.rate,steps:16,originalClipSeconds:before.bufferDurations[0],syncedPreviewSeconds:preview.period,triggerIntervalSeconds:4*rendered.period/16,syncErrorSeconds:Math.abs(preview.period-4*rendered.period/16),referenceError:rendered.referenceError,sixCycleError:rendered.cycleError,liveVersusWavError:wavError,pointsPreserved:true};
  expect(evidence.syncErrorSeconds).toBeLessThanOrEqual(1/rendered.rate);
  await mkdir('test-results/real-source',{recursive:true});await writeFile('test-results/real-source/verification.json',JSON.stringify(evidence,null,2)+'\n');await writeFile('test-results/real-source/synced-pattern.wav',wav);
  await page.locator('#seq-stop').click();await page.locator('#sequence').scrollIntoViewIfNeeded();await page.screenshot({path:'test-results/real-source/synced-sequencer.png'});
  console.log(JSON.stringify(evidence));
});
