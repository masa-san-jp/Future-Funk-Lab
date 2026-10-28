import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { encodeWav } from '../../src/core.js';
const rate=44100;
const song=(freq,seconds=1)=>Buffer.from(encodeWav([Float32Array.from({length:rate*seconds},(_,i)=>{const t=i/rate;return .2*Math.sin(2*Math.PI*freq*t)+.4*Math.exp(-(t%.5)*40)*Math.sin(2*Math.PI*60*t);})],rate));
const first={name:'first.wav',mimeType:'audio/wav',buffer:song(220)},second={name:'second.wav',mimeType:'audio/wav',buffer:song(330,2)};
async function state(page){return page.evaluate(()=>window.futureFunkLab.getState());}
// Drops files on the page the way a browser does: dragenter, dragover, then drop.
async function drop(page,files,{check}={}){
  const transfer=await page.evaluateHandle(list=>{const dt=new DataTransfer();for(const f of list)dt.items.add(new File([new Uint8Array(f.data)],f.name,{type:f.mimeType}));return dt;},files.map(f=>({name:f.name,mimeType:f.mimeType,data:[...f.buffer]})));
  await page.dispatchEvent('main','dragenter',{dataTransfer:transfer});await page.dispatchEvent('main','dragover',{dataTransfer:transfer});
  if(check)await check();
  await page.dispatchEvent('main','drop',{dataTransfer:transfer});
}
async function loaded(page,name){await expect(page.locator('#source-name')).toHaveText(name);await expect(page.locator('#sample')).toBeEnabled();}
async function edit(page,step=0){await page.locator('#sample').click();await expect(page.locator('#seq-play')).toBeEnabled();await page.locator(`[data-track-step="0"][data-step="${step}"]`).click();}
async function saveProject(page){const [d]=await Promise.all([page.waitForEvent('download'),page.locator('#project-save').click()]);return {name:d.suggestedFilename(),mimeType:'application/json',buffer:await readFile(await d.path())};}

test('曲をドロップすると読み込み、ドラッグ中は案内を重ねて出す',async({page})=>{
  await page.goto('/');
  await drop(page,[first],{check:()=>expect(page.locator('#drop-overlay')).toBeVisible()});
  await expect(page.locator('#drop-overlay')).toBeHidden();await loaded(page,'first.wav');
  // Changing nothing since loading replaces without asking.
  await drop(page,[second]);await loaded(page,'second.wav');await expect(page.locator('#replace-confirm')).toBeHidden();
});
test('プロジェクトは.jsonだけでも、曲と一緒でもドロップで開ける',async({page})=>{
  await page.goto('/');await drop(page,[first]);await loaded(page,'first.wav');await edit(page);
  const project=await saveProject(page),expected=await state(page);
  await page.goto('/');await drop(page,[project]);
  await expect(page.locator('#project-source-text')).toHaveText('元の曲「first.wav」を選んでください');
  await drop(page,[first]);await expect(page.locator('#status')).toContainText('プロジェクトを読み込みました');
  expect((await state(page)).tracks).toEqual(expected.tracks);
  await page.goto('/');await drop(page,[project,first]);await expect(page.locator('#status')).toContainText('プロジェクトを読み込みました');
  expect((await state(page)).tracks).toEqual(expected.tracks);await expect(page.locator('#project-dirty')).toHaveText('');
});
test('受け付けないドロップは理由を出し、今の作業を残す',async({page})=>{
  await page.goto('/');await drop(page,[first]);await loaded(page,'first.wav');
  const project={name:'a.json',mimeType:'application/json',buffer:Buffer.from('{}')},text={name:'notes.txt',mimeType:'text/plain',buffer:Buffer.from('x')};
  for(const [files,message] of [[[first,second],'曲は1つずつドロップしてください'],[[text],'曲かプロジェクト（.json）をドロップしてください'],[[project,project],'プロジェクト（.json）は1つずつドロップしてください']]){
    await drop(page,files);await expect(page.locator('#status')).toHaveClass(/error/);await expect(page.locator('#status')).toContainText(message);
    await expect(page.locator('#source-name')).toHaveText('first.wav');
  }
  // Dragging text, not files, does nothing.
  const words=await page.evaluateHandle(()=>{const dt=new DataTransfer();dt.setData('text/plain','hello');return dt;});
  await page.dispatchEvent('main','dragenter',{dataTransfer:words});await expect(page.locator('#drop-overlay')).toBeHidden();
});
test('未保存の変更があるときは、置き換える前に画面内で確認する',async({page})=>{
  page.on('dialog',d=>{throw Error(`window dialog: ${d.message()}`);});
  await page.goto('/');await drop(page,[first]);await loaded(page,'first.wav');await edit(page);
  const before=await state(page);
  // Cancel keeps the work.
  await drop(page,[second]);await expect(page.locator('#replace-confirm')).toBeVisible();await expect(page.locator('#replace-confirm')).toContainText('今の作業には未保存の変更があります。置き換えますか？');
  await page.locator('#replace-no').click();await expect(page.locator('#replace-confirm')).toBeHidden();await expect(page.locator('#status')).toContainText('置き換えをやめました');
  expect((await state(page)).tracks).toEqual(before.tracks);await expect(page.locator('#source-name')).toHaveText('first.wav');
  // Save then replace downloads the project first.
  await drop(page,[second]);
  const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#replace-save').click()]);
  expect(download.suggestedFilename()).toBe('first.json');await loaded(page,'second.wav');
  // Every way of replacing the work asks: choosing a song, the demo, opening a project, recording.
  const project=await saveProject(page);let step=1;
  for(const action of [
    ()=>page.locator('#source-file').setInputFiles(first),
    ()=>page.getByRole('button',{name:'デモ音源を読み込む'}).click(),
    ()=>page.locator('#project-file').setInputFiles(project),
    ()=>page.locator('#record').click(),
  ]){
    await edit(page,step++);await action();await expect(page.locator('#replace-confirm')).toBeVisible();
    await page.locator('#replace-no').click();await expect(page.locator('#source-name')).toHaveText('second.wav');
  }
  await page.locator('#source-file').setInputFiles(first);await page.locator('#replace-yes').click();await loaded(page,'first.wav');
});
