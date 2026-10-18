import {cp,mkdir,mkdtemp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
const {version}=JSON.parse(await readFile('package.json','utf8'));
const archive=`Future-Funk-Lab-${version}.tar.gz`,source=path.resolve('release',archive),stage=await mkdtemp(path.join(tmpdir(),'future-funk-site-'));
try{
  execFileSync('tar',['-xzf',source,'-C',stage]);
  const manifest=JSON.parse(await readFile(path.join(stage,`Future-Funk-Lab-${version}`,'manifest.json'),'utf8'));
  for(const entry of manifest.files){
    if(/\.(wav|mp3|webm|ogg|m4a)$/i.test(entry.path)||entry.path.includes('verification/'))throw Error('Verification data in release');
    const data=await readFile(path.join(stage,`Future-Funk-Lab-${version}`,entry.path));
    if(createHash('sha256').update(data).digest('hex')!==entry.sha256)throw Error(`Release checksum mismatch: ${entry.path}`);
  }
  if(!(await readFile(path.join(stage,`Future-Funk-Lab-${version}`,'index.html'))).equals(await readFile('dist/index.html')))throw Error('Release and app versions differ');
  await mkdir('site/downloads',{recursive:true});
  // Never publish the working dist directory, which may contain local audio.
  const allowed=new Set(['index.html','THIRD_PARTY_NOTICES.md','licenses','downloads','.nojekyll']);
  const existing=await readdir('site');if(existing.some(file=>!allowed.has(file)))throw Error('Unexpected file in site output');
  await cp('dist/index.html','site/index.html');
  await cp('dist/licenses','site/licenses',{recursive:true});
  await cp('THIRD_PARTY_NOTICES.md','site/THIRD_PARTY_NOTICES.md');
  await cp(source,path.join('site/downloads',archive));await cp(source+'.sha256',path.join('site/downloads',archive+'.sha256'));
  await writeFile('site/.nojekyll','');
  const expected=new Set(['index.html','THIRD_PARTY_NOTICES.md','.nojekyll','licenses/soundtouchjs.txt','licenses/lamejs.txt',`downloads/${archive}`,`downloads/${archive}.sha256`]);
  async function verify(folder,prefix=''){
    for(const entry of await readdir(folder,{withFileTypes:true})){
      const relative=path.posix.join(prefix,entry.name);
      if(entry.isDirectory())await verify(path.join(folder,entry.name),relative);
      else if(!expected.has(relative))throw Error(`Unexpected public file: ${relative}`);
    }
  }
  await verify('site');
  console.log(`Prepared site: app, licenses and verified ${version} source distribution; no local audio`);
}finally{await rm(stage,{recursive:true,force:true});}
