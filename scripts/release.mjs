import {cp,mkdir,mkdtemp,readFile,readdir,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import path from 'node:path';
const run=promisify(execFile),pkg=JSON.parse(await readFile('package.json','utf8'));
const name=`Future-Funk-Lab-${pkg.version}`,stage=await mkdtemp(path.join(tmpdir(),'future-funk-release-')),root=path.join(stage,name);
const output=path.resolve('release',`${name}.tar.gz`);
await mkdir(root,{recursive:true});await mkdir('release',{recursive:true});
try{
  // Copy an allowlist, never the working dist tree or test recordings.
  await cp('dist/index.html',path.join(root,'index.html'));
  await cp('dist/licenses',path.join(root,'licenses'),{recursive:true});
  await cp('THIRD_PARTY_NOTICES.md',path.join(root,'THIRD_PARTY_NOTICES.md'));
  for(const item of ['src','scripts','.github','package.json','package-lock.json','playwright.config.js','index.html'])await cp(item,path.join(root,'source',item),{recursive:true});
  await cp('tests',path.join(root,'source/tests'),{recursive:true,filter:file=>!file.endsWith('real-source.spec.js')});
  await cp('THIRD_PARTY_NOTICES.md',path.join(root,'source/THIRD_PARTY_NOTICES.md'));
  for(const dependency of ['soundtouchjs','@breezystack/lamejs']){
    const target=path.join(root,'third_party',dependency);
    await mkdir(target,{recursive:true});
    for(const item of ['dist','LICENSE','README.md','package.json'])await cp(path.join('node_modules',dependency,item),path.join(target,item),{recursive:true});
  }
  const readme=`# Future Funk Lab ${pkg.version}\n\nローカルで使う単一HTMLのアプリです。Webでの公開は行っていません。\n\n確認済み環境: macOS版Google Chrome。ほかのOS・ブラウザは対応を保証しません。\n\n## 起動\n\nこのフォルダの index.html をChromeで開きます。音源は端末内で処理し、外部に送信しません。マイクにはブラウザの権限が必要です。曲はWAV・AIFF・MP3・AAC(M4A)・FLAC・Opusを読み込め、ページへのドラッグ&ドロップでも入れられます。\n\n## キー操作\n\nSpace：再生/停止 ／ ⌘Z（Ctrl+Z）：元に戻す ／ ⇧⌘Z（Ctrl+Y）：やり直す ／ ⌘S（Ctrl+S）：保存\n\n## 同期\n\nグリッドは8分か16分を選べ、16分ではスウィングをかけられます。トラックの「配置に同期」は素材を複数ステップ分の長さに合わせ、「ステップ数を指定」で長さを明示できます。「原寸」は切り出した長さです。\n\n## 保存\n\n「プロジェクトを保存」で設定だけを 曲名.json に保存します。元の曲は入らないので、開くときに選び直します。曲ファイルは消さずに残してください。作業中の内容はブラウザ内にも自動保存されます。音声はミックスかトラックごと（ZIP）で書き出せます。\n\n## ソースと再ビルド\n\nNode.js 22以上で source フォルダへ移動し、npm ci、npm run build を実行します。npm test と npm run test:browser で検証できます。変更可能なアプリのソースと固定依存情報を同梱しています。\n\nthird_party にビルドに使用したライブラリの配布コード・ライセンスを同梱しています。置換・再ビルド方法は THIRD_PARTY_NOTICES.md を参照してください。\n\n検証用の楽曲・録音・書き出し音声はこの配布物に含めません。manifest.json は同梱ファイルのSHA-256です。\n`;
  await writeFile(path.join(root,'README.md'),readme);
  await writeFile(path.join(root,'source/README.md'),readme);
  const files=[];
  async function walk(folder,relative=''){
    for(const item of await readdir(folder,{withFileTypes:true})){
      const rel=path.posix.join(relative,item.name),file=path.join(folder,item.name);
      if(item.isDirectory())await walk(file,rel);
      else{
        if(/\.(wav|mp3|ogg|m4a|webm)$/i.test(rel)||/(^|\/)(verification|test-results|\.git|\.env)(\/|$)/.test(rel))throw Error(`配布対象外のファイル: ${rel}`);
        const data=await readFile(file);files.push({path:rel,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')});
      }
    }
  }
  await walk(root);files.sort((a,b)=>a.path.localeCompare(b.path));
  await writeFile(path.join(root,'manifest.json'),JSON.stringify({name:pkg.name,version:pkg.version,files},null,2)+'\n');
  await run('tar',['-czf',output,'-C',stage,name]);
  const {stdout}=await run('tar',['-tzf',output]);
  const entries=stdout.trim().split('\n');
  if(entries.some(file=>/\.(wav|mp3|ogg|m4a|webm)$/i.test(file)||file.includes('/verification/')))throw Error('配布アーカイブに検証音声が混入しました');
  const archive=await readFile(output),hash=createHash('sha256').update(archive).digest('hex');
  await writeFile(output+'.sha256',`${hash}  ${path.basename(output)}\n`);
  console.log(`Created ${path.relative('.',output)} (${Math.round(archive.length/1024)} KiB, ${files.length} files, no test audio)`);
}finally{await rm(stage,{recursive:true,force:true});}
