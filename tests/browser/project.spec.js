import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
// These tests use every track's inline editor, which the detail view shows.
test.beforeEach(async({page})=>{await page.addInitScript(()=>{try{localStorage.setItem('ffl:view','detail');}catch{}});});
async function demo(page){await page.goto('/');await page.getByRole('button',{name:'デモ音源を読み込む'}).click();await expect(page.locator('#sample')).toBeEnabled();}
async function state(page){return page.evaluate(()=>window.futureFunkLab.getState());}
// Clicks and collects every download the click produces (saving a recording makes two).
async function downloads(page,selector,count=1){
  const files=[],done=new Promise(resolve=>{const on=async d=>{files.push({name:d.suggestedFilename(),data:await readFile(await d.path())});if(files.length===count){page.off('download',on);resolve();}};page.on('download',on);});
  await page.locator(selector).click();await done;return files;
}
const download=async(page,selector)=>(await downloads(page,selector))[0];
const file=(name,data,mimeType)=>({name,mimeType,buffer:data});
// Bit-exact fingerprint of the rebuilt track buffers.
async function bufferPrint(page){return page.evaluate(()=>window.futureFunkLab.engine.buffers.map(b=>{if(!b)return null;let hash=0;for(let c=0;c<b.numberOfChannels;c++){const bits=new Uint32Array(b.getChannelData(c).slice().buffer);for(const x of bits)hash=(Math.imul(hash,31)+x)>>>0;}return [b.length,hash];}));}
// OfflineAudioContext rendering can differ by one LSB between runs, even in one session.
function maxPcmDifference(a,b){let max=0;for(let i=44;i<a.length;i+=2)max=Math.max(max,Math.abs(a.readInt16LE(i)-b.readInt16LE(i)));return max;}
async function setField(page,selector,value){await page.locator(selector).fill(String(value));await page.locator(selector).press('Tab');}
async function settle(page){await expect(page.locator('#seq-play')).toBeEnabled();await expect.poll(async()=>(await state(page)).pendingTracks.length).toBe(0);await page.waitForTimeout(200);}
async function buildSession(page){
  await setField(page,'#range-start','0.500');await setField(page,'#range-end','4.500');
  await page.locator('#sample').click();await expect(page.locator('#seq-play')).toBeEnabled();
  for(const [track,step] of [[0,0],[0,6],[1,4],[2,8],[3,12]])await page.locator(`[data-track-step="${track}"][data-step="${step}"]`).click();
  await setField(page,'[data-track-pitch="1"]',5);await expect(page.locator('#status')).toContainText('長さを維持');
  await page.locator('[data-track-mode="0"]').selectOption('cut');await page.locator('[data-track-sync="2"]').selectOption('original');
  await setField(page,'[data-track-db="3"]','-6');await setField(page,'#eq-value-2-2','-12');await page.locator('#eq-slope').selectOption('24');
  await page.locator('[data-track-mute="3"]').click();await setField(page,'#master-number','-3');await setField(page,'#swing',58);
  // Step clicks queue track rebuilds whose status messages arrive later.
  await settle(page);
}
// An MP3 made by the app itself, to use as a song file.
async function makeMp3(page){
  await demo(page);await page.locator('#sample').click();await expect(page.locator('#seq-play')).toBeEnabled();
  for(const step of [0,4,8,12])await page.locator(`[data-track-step="0"][data-step="${step}"]`).click();await page.locator('[data-track-step="2"][data-step="2"]').click();
  await page.locator('#export-format').selectOption('mp3');return (await download(page,'#export')).data;
}
const sameSession=async(page,expected,print)=>{
  const restored=await state(page);
  for(const key of ['bpm','sourceBpm','count','steps','lengthTicks','resolution','swing','points','committed','range','bufferDurations','tracks','duration'])expect(restored[key],key).toEqual(expected[key]);
  expect(await bufferPrint(page)).toEqual(print);
};
test('デモ音源のプロジェクトは設定だけのJSONで保存され、曲を選ばずに開き直せる',async({page})=>{
  const remote=[];page.on('request',r=>{if(/^https?:/.test(r.url())&&!r.url().includes('127.0.0.1'))remote.push(r.url());});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await demo(page);await buildSession(page);
  await expect(page.locator('#project-dirty')).toHaveText('未保存の変更あり',{timeout:5000});
  const before=await download(page,'#export'),saved=await download(page,'#project-save'),expected=await state(page),print=await bufferPrint(page);
  expect(saved.name).toBe('Future Funk Lab · Demo 120 BPM.json');expect(saved.data.length).toBeLessThan(20000);
  const json=JSON.parse(saved.data.toString());expect(json.source.kind).toBe('demo');expect(json.schemaVersion).toBe(3);
  await expect(page.locator('#project-dirty')).toHaveText('');
  await page.goto('/');await page.locator('#project-file').setInputFiles(file(saved.name,saved.data,'application/json'));
  await expect(page.locator('#status')).toContainText('プロジェクトを読み込みました');await expect(page.locator('#project-source')).toBeHidden();
  await settle(page);await sameSession(page,expected,print);
  await expect(page.locator('[data-track-pitch="1"]')).toHaveValue('5');await expect(page.locator('#eq-slope')).toHaveValue('24');await expect(page.locator('#master-number')).toHaveValue('-3.0');
  await expect(page.locator('#project-dirty')).toHaveText('');
  const after=await download(page,'#export');
  expect(after.data.length).toBe(before.data.length);expect(maxPcmDifference(after.data,before.data)).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);expect(remote).toEqual([]);
});
test('曲ファイルのプロジェクトは、開くときに元の曲を選び直し、違う曲なら止める',async({page})=>{
  const mp3=await makeMp3(page);
  await page.goto('/');await page.locator('#source-file').setInputFiles(file('loop.mp3',mp3,'audio/mpeg'));await expect(page.locator('#sample')).toBeEnabled();
  await buildSession(page);
  const saved=await download(page,'#project-save'),expected=await state(page),print=await bufferPrint(page);
  expect(saved.name).toBe('loop.json');const json=JSON.parse(saved.data.toString());
  expect(json.source).toMatchObject({kind:'file',name:'loop.mp3',bytes:mp3.length});
  // JSON alone: the app asks for the song, rejects a different file, then accepts the right one.
  await page.goto('/');await page.locator('#project-file').setInputFiles(file('loop.json',saved.data,'application/json'));
  await expect(page.locator('#project-source')).toBeVisible();await expect(page.locator('#project-source-text')).toHaveText('元の曲「loop.mp3」を選んでください');
  const other=Buffer.from(mp3);other[other.length-10]^=1;
  await page.locator('#project-source-file').setInputFiles(file('loop.mp3',other,'audio/mpeg'));
  await expect(page.locator('#status')).toHaveClass(/error/);await expect(page.locator('#status')).toContainText('保存したときの曲と違います');
  await expect(page.locator('#project-source')).toBeVisible();expect((await state(page)).duration).toBe(0);
  await page.locator('#project-source-file').setInputFiles(file('renamed.mp3',mp3,'audio/mpeg'));
  await expect(page.locator('#status')).toContainText('プロジェクトを読み込みました');await expect(page.locator('#project-source')).toBeHidden();
  await settle(page);await sameSession(page,expected,print);await expect(page.locator('#source-name')).toHaveText('renamed.mp3');
  // JSON and the song chosen together open in one step.
  await page.goto('/');await page.locator('#project-file').setInputFiles([file('loop.json',saved.data,'application/json'),file('loop.mp3',mp3,'audio/mpeg')]);
  await expect(page.locator('#status')).toContainText('プロジェクトを読み込みました');await settle(page);await sameSession(page,expected,print);
  // Cancelling leaves the app as it was.
  await page.goto('/');await page.locator('#project-file').setInputFiles(file('loop.json',saved.data,'application/json'));
  await page.locator('#project-source-cancel').click();await expect(page.locator('#project-source')).toBeHidden();await expect(page.locator('#status')).toContainText('やめました');
});
test('録音のプロジェクトは、録音そのものも一緒に保存して開き直せる',async({page})=>{
  await page.goto('/');await page.locator('#record').click();await expect(page.locator('#record-stop')).toBeEnabled();await page.waitForTimeout(1000);await page.locator('#record-stop').click();
  await expect(page.locator('#sample')).toBeEnabled();await page.locator('#sample').click();await expect(page.locator('#seq-play')).toBeEnabled();
  await page.locator('[data-track-step="1"][data-step="2"]').click();await setField(page,'[data-track-pitch="1"]',-3);await expect(page.locator('#status')).toContainText('長さを維持');await settle(page);
  const expected=await state(page),print=await bufferPrint(page),saved=await downloads(page,'#project-save',2);
  const json=saved.find(f=>f.name.endsWith('.json')),audio=saved.find(f=>!f.name.endsWith('.json'));
  expect(audio.name).toMatch(/^microphone-.+\.(webm|m4a|ogg)$/);expect(json.name).toBe(audio.name.replace(/\.[^.]+$/,'.json'));
  expect(JSON.parse(json.data.toString()).source).toMatchObject({kind:'recording',name:audio.name,bytes:audio.data.length});
  await expect(page.locator('#status')).toContainText('2つを同じ場所に置いてください');
  await page.goto('/');await page.locator('#project-file').setInputFiles([file(json.name,json.data,'application/json'),file(audio.name,audio.data,'audio/webm')]);
  await expect(page.locator('#status')).toContainText('プロジェクトを読み込みました');await settle(page);await sameSession(page,expected,print);
});
test('壊れたプロジェクトや別のファイルを開いても、今の作業は残る',async({page})=>{
  await demo(page);await buildSession(page);const before=await state(page);
  for(const [input,message] of [[file('broken.json',Buffer.from('this is not json'),'application/json'),'プロジェクトを読み込めませんでした'],[file('song.mp3',Buffer.from('x'),'audio/mpeg'),'プロジェクトファイル（.json）を選んでください']]){
    await page.locator('#project-file').setInputFiles(input);
    await expect(page.locator('#status')).toHaveClass(/error/);await expect(page.locator('#status')).toContainText(message);
    const after=await state(page);expect(after.committed).toEqual(before.committed);expect(after.tracks).toEqual(before.tracks);
  }
});
test('自動保存は曲をそのまま残し、選び直さずに復元でき、破棄もできる',async({page})=>{
  const mp3=await makeMp3(page);
  await page.goto('/');await page.locator('#source-file').setInputFiles(file('loop.mp3',mp3,'audio/mpeg'));await expect(page.locator('#sample')).toBeEnabled();
  await buildSession(page);const expected=await state(page),print=await bufferPrint(page);
  await page.waitForTimeout(4500);
  const stored=await page.evaluate(()=>new Promise(resolve=>{const r=indexedDB.open('future-funk-lab');r.onsuccess=()=>{const q=r.result.transaction('autosave').objectStore('autosave').get('audio');q.onsuccess=()=>resolve({kind:q.result.kind,name:q.result.name,size:q.result.blob.size});};}));
  expect(stored).toEqual({kind:'file',name:'loop.mp3',size:mp3.length});
  await page.reload();
  await expect(page.locator('#autosave-banner')).toBeVisible();await expect(page.locator('#autosave-text')).toContainText('loop.mp3');
  await page.locator('#autosave-restore').click();
  await expect(page.locator('#status')).toContainText('プロジェクトを読み込みました');await expect(page.locator('#autosave-banner')).toBeHidden();
  await settle(page);await sameSession(page,expected,print);
  await page.reload();await expect(page.locator('#autosave-banner')).toBeVisible();
  await page.locator('#autosave-discard').click();await expect(page.locator('#status')).toContainText('自動保存を破棄しました');await expect(page.locator('#autosave-banner')).toBeHidden();
  await page.reload();await page.waitForTimeout(500);await expect(page.locator('#autosave-banner')).toBeHidden();
});
