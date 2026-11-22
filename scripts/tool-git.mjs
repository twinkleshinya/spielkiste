import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const exec=promisify(execFile);
export const sourceDirectories=['src','tests','templates','desktop','examples'];
const rootFiles=['package.json','package-lock.json','tsconfig.json','.env.example','.gitignore','.gitattributes','README.md','Spielkiste.bat','start-sfx.bat','start-ui.bat','electron-builder.cjs','tool-git.json'];
const scriptNames=['start-sfx.mjs','start-web.mjs','create-sfx-demo.mjs','create-desktop-shortcut.ps1','stamp-sfx-frames.ps1','pick-folder.ps1','package-spielkiste.ps1','prepare-desktop.mjs','tool-git.mjs','release-desktop.mjs','verify-desktop.mjs','build-user-guide.mjs'];
const guideFiles=['docs/Spielkiste-团队使用说明.md','docs/Spielkiste-使用指南.html'];
const guideAssets='docs/spielkiste-guide-assets';
const skillNames=['video-sfx-workflow','video-sfx-timing','video-sfx-selection','video-sfx-mix-review'];
export async function sourceFiles(root){
 const files=[];
 async function walk(relative){let entries;try{entries=await fs.readdir(path.join(root,relative),{withFileTypes:true});}catch{return;}
  for(const item of entries){const name=path.posix.join(relative,item.name);if(item.isSymbolicLink())throw new Error(`Source symlink rejected: ${name}`);if(item.isDirectory())await walk(name);else if(item.isFile())files.push(name);}
 }
 for(const directory of sourceDirectories)await walk(directory);
 for(const skill of skillNames)await walk(`.agents/skills/${skill}`);
 await walk(guideAssets);
 for(const name of [...rootFiles,...scriptNames.map(name=>`scripts/${name}`),...guideFiles]){try{if((await fs.stat(path.join(root,name))).isFile())files.push(name);}catch{}}
 return files.filter(name=>name!=='src/ui/public/spielkiste-design-preview.html').sort();
}
export class ToolCodeGit {
 constructor(root,options={}){this.root=path.resolve(root);this.mirror=path.resolve(options.mirror||path.join(root,'.output/tool-code-git'));this.allowLocal=!!options.allowLocal;this.repository=options.repository;}
 async git(args){return exec(process.env.SPIELKISTE_GIT||'git',args,{cwd:this.mirror,timeout:120000,windowsHide:true,maxBuffer:8*1024*1024,env:{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never'}});}
 async configuration(){const config=this.repository?{repository:this.repository}:JSON.parse(await fs.readFile(path.join(this.root,'tool-git.json'),'utf8'));const url=config.repository;
  if(!(this.allowLocal&&path.isAbsolute(url))&&!/^https:\/\/[a-zA-Z0-9.-]+\/[\w./-]+$/.test(url)&&!/^git@[a-zA-Z0-9.-]+:[\w./-]+$/.test(url))throw new Error('Tool Git URL must use credential-free HTTPS or SSH');return config;
 }
 async setup(){const config=await this.configuration();await fs.mkdir(this.mirror,{recursive:true});
  try{await fs.access(path.join(this.mirror,'.git'));}catch{await this.git(['init','-b','main']);await this.git(['remote','add','origin',config.repository]);}
  if((await this.git(['remote','get-url','origin'])).stdout.trim()!==config.repository)throw new Error('Tool Git destination changed; use a new mirror directory');
  await this.git(['config','user.name','Spielkiste']);await this.git(['config','user.email','spielkiste@localhost.local']);await this.git(['config','core.hooksPath',path.join(this.root,'.output/disabled-git-hooks')]);
 }
 async synchronizeRemote(){const refs=(await this.git(['ls-remote','--heads','origin','refs/heads/main'])).stdout;
  if(refs.trim()){await this.git(['fetch','origin','main']);try{await this.git(['rev-parse','HEAD']);await this.git(['merge','--ff-only','FETCH_HEAD']);}catch(error){try{await this.git(['rev-parse','HEAD']);}catch{await this.git(['checkout','-B','main','FETCH_HEAD']);return;}throw error;}}
 }
 async locked(action){
  const lock=path.join(this.root,'.output/tool-code-sync.lock');await fs.mkdir(path.dirname(lock),{recursive:true});
  let handle;try{handle=await fs.open(lock,'wx');}catch(error){
   if(error.code!=='EEXIST')throw error;
   let alive=true;try{const pid=Number(await fs.readFile(lock,'utf8'));if(!pid){if(Date.now()-(await fs.stat(lock)).mtimeMs>10000)throw new Error();}else process.kill(pid,0);}catch{alive=false;}
   if(alive)throw new Error('Another tool code sync is running; retry shortly');
   await fs.rm(lock,{force:true});handle=await fs.open(lock,'wx');
  }
  await handle.writeFile(String(process.pid));try{return await action();}finally{await handle.close();await fs.rm(lock,{force:true});}
 }
 async checkpoint(options={}){return this.locked(()=>this.checkpointLocked(options));}
 async checkpointLocked({push=true,message='Spielkiste: automatic code checkpoint'}={}){
  await this.setup();let remoteError;
  if(push)try{await this.synchronizeRemote();}catch(error){remoteError=error;}
  const files=await sourceFiles(this.root);
  for(const relative of files){
   const bytes=await fs.readFile(path.join(this.root,relative));
   if(bytes.length>10*1024*1024)throw new Error(`Unexpected source file exceeds 10MB: ${relative}`);
   if(/\.(?:ts|js|mjs|cjs|json|md|ps1|bat|html|css|yaml|toml)$/.test(relative)&&/(?:\b(?:gh[pousr]_[A-Za-z0-9]{24,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9_-]{24,})\b|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----)/.test(bytes.toString('utf8')))throw new Error(`Potential credential in source: ${relative}`);
  }
  let tracked=[];try{tracked=(await this.git(['ls-files','-z'])).stdout.split('\0').filter(Boolean);}catch{}
  for(const relative of tracked){if(!files.includes(relative)){const target=path.resolve(this.mirror,relative);if(!target.startsWith(`${this.mirror}${path.sep}`))throw new Error('Unsafe source path');await fs.rm(target,{force:true});}}
  for(const relative of files){const target=path.join(this.mirror,relative);await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(path.join(this.root,relative),target);}
  // This checkout contains only source snapshots, never the developer's index or projects.
  await this.git(['add','-f','--',...files]);await this.git(['add','-u']);
  const changed=!!(await this.git(['diff','--cached','--name-only'])).stdout.trim();
  if(changed)await this.git(['commit','-m',message.slice(0,180)]);
  const commit=(await this.git(['rev-parse','HEAD'])).stdout.trim();
  let status=changed?'committed':'unchanged',error;
  if(push)try{if(remoteError)throw remoteError;await this.git(['push','-u','origin','HEAD:refs/heads/main']);status='synced';}catch(e){status='pending-sync';error=String(e.message).replace(/https?:\/\/\S+/g,'[remote]').slice(0,500);}
  const state={status,commit,at:new Date().toISOString(),files:files.length,error};await fs.writeFile(path.join(this.root,'.output/tool-git-status.json'),JSON.stringify(state,null,2));return state;
 }
 async history(){await this.setup();return (await this.git(['log','-40','--format=%H %aI %s'])).stdout;}
 async restore(commit){return this.locked(()=>this.restoreLocked(commit));}
 async restoreLocked(commit){if(!/^[a-f0-9]{7,40}$/.test(commit))throw new Error('Invalid commit');
  await this.checkpointLocked({push:false,message:'Spielkiste: preserve code before restore'});
  const paths=(await this.git(['ls-tree','-r','-z','--name-only',commit])).stdout.split('\0').filter(Boolean);
  const permitted=relative=>rootFiles.includes(relative)||scriptNames.some(name=>relative===`scripts/${name}`)||sourceDirectories.some(dir=>relative.startsWith(`${dir}/`))||skillNames.some(dir=>relative.startsWith(`.agents/skills/${dir}/`))||guideFiles.includes(relative)||relative.startsWith(`${guideAssets}/`);
  for(const relative of paths)if(!permitted(relative)||relative.split('/').includes('..')||path.isAbsolute(relative))throw new Error(`Unsafe restore path: ${relative}`);
  const current=await sourceFiles(this.root);
  for(const relative of paths){const {stdout}=await exec(process.env.SPIELKISTE_GIT||'git',['show',`${commit}:${relative}`],{cwd:this.mirror,encoding:'buffer',maxBuffer:16*1024*1024,windowsHide:true});const target=path.join(this.root,relative);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,stdout);}
  for(const relative of current)if(!paths.includes(relative))await fs.rm(path.join(this.root,relative));
  return this.checkpointLocked({message:`Spielkiste: restore code from ${commit}`});
 }
 async fingerprint(){const hash=createHash('sha256');for(const file of await sourceFiles(this.root))hash.update(file).update(await fs.readFile(path.join(this.root,file)));return hash.digest('hex');}
}
export function startToolWatcher(root){
 import('node:child_process').then(({spawn})=>{const child=spawn(process.execPath,[path.join(root,'scripts/tool-git.mjs'),'watch',String(process.pid)],{cwd:root,windowsHide:true,stdio:'ignore'});child.on('error',()=>{});process.on('exit',()=>child.kill());});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),tool=new ToolCodeGit(root),command=process.argv[2]||'sync';
 if(command==='history')console.log(await tool.history());
 else if(command==='restore')console.log(await tool.restore(process.argv[3]||''));
 else if(command==='watch'){
  let last='',candidate='',stable=0;const parent=Number(process.argv[3]);
  while(true){if(parent)try{process.kill(parent,0);}catch{break;}
   try{const hash=await tool.fingerprint();if(hash===candidate)stable++;else{candidate=hash;stable=0;}
    if(hash!==last&&stable>=1){await exec(process.execPath,['node_modules/typescript/bin/tsc','--noEmit','-p','tsconfig.json'],{cwd:root,windowsHide:true,timeout:120000});const result=await tool.checkpoint();console.log(JSON.stringify(result));if(result.status==='synced')last=hash;}
   }catch(error){await fs.mkdir(path.join(root,'.output'),{recursive:true});await fs.writeFile(path.join(root,'.output/tool-git-status.json'),JSON.stringify({status:'pending-sync',error:String(error.message).replace(/https?:\/\/\S+/g,'[remote]').slice(0,500),at:new Date().toISOString()}));}
   await new Promise(resolve=>setTimeout(resolve,10000));
  }
 }else console.log(await tool.checkpoint());
}
