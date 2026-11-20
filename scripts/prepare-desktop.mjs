import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=path.resolve('.output/desktop-runtime');
await fs.mkdir(root,{recursive:true});
for (const name of ['ffmpeg','ffprobe']) {
  const binary=process.env[`${name.toUpperCase()}_PATH`] || execFileSync('where.exe',[`${name}.exe`],{encoding:'utf8'}).trim().split(/\r?\n/)[0];
  await fs.copyFile(binary,path.join(root,`${name}.exe`));
  const distribution=path.dirname(path.dirname(binary));
  for(const file of ['LICENSE','LICENSE.txt','README.txt']) {
    try {await fs.copyFile(path.join(distribution,file),path.join(root,`FFmpeg-${file}`));} catch(error){if(error.code!=='ENOENT')throw error;}
  }
}
const gitTarget=path.join(root,'git');
try {await fs.access(path.join(gitTarget,'cmd/git.exe'));}
catch {
  const response=await fetch('https://api.github.com/repos/git-for-windows/git/releases/latest');
  if(!response.ok)throw new Error(`Git runtime metadata: ${response.status}`);
  const release=await response.json();
  const asset=release.assets.find(item=>/^MinGit-[\d.]+-64-bit\.zip$/.test(item.name));
  if(!asset?.digest?.startsWith('sha256:'))throw new Error('缺少 Git 运行库的官方 SHA256');
  const download=await fetch(asset.browser_download_url);if(!download.ok)throw new Error('下载 Git 运行库失败');
  const bytes=Buffer.from(await download.arrayBuffer());
  if(createHash('sha256').update(bytes).digest('hex')!==asset.digest.slice(7))throw new Error('Git 运行库校验失败');
  const archive=path.join(root,'mingit.zip'); await fs.writeFile(archive,bytes);
  execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Expand-Archive -LiteralPath '${archive.replaceAll("'","''")}' -DestinationPath '${gitTarget.replaceAll("'","''")}' -Force`],{windowsHide:true});
  await fs.rm(archive);await fs.writeFile(path.join(root,'git-runtime-source.json'),JSON.stringify({version:release.tag_name,url:asset.browser_download_url,sha256:asset.digest}));
}
await fs.writeFile(path.join(root,'THIRD-PARTY-NOTICES.txt'),'FFmpeg: https://www.gyan.dev/ffmpeg/builds/ (GPL build; license included). Corresponding source: https://github.com/FFmpeg/FFmpeg\nGit for Windows MinGit: https://github.com/git-for-windows/git (GPLv2; licenses included in git/).\nElectron: https://www.electronjs.org (MIT; licenses included).\n');
console.log('Desktop runtime prepared:',root);
