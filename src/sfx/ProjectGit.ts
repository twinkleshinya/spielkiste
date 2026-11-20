import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { z } from "zod";
import { RunSchema, SfxError, type SfxRun } from "./models.js";
import { writeJson } from "./SfxRunStore.js";

const exec = promisify(execFile);
const Config = z.object({ repository:z.string().trim().min(1).max(2000), authorName:z.string().trim().min(1).max(100).default('Spielkiste'), authorEmail:z.string().email().default('spielkiste@localhost.local') });
const branch='spielkiste-projects';
export function validateRepository(value:string, allowLocal=false) {
  if(allowLocal && path.isAbsolute(value)) return value;
  if(/^git@[a-zA-Z0-9.-]+:[\w./-]+$/.test(value)) return value;
  let url:URL;try{url=new URL(value);}catch{throw new SfxError('请填写完整 Git 仓库地址（HTTPS 或 SSH）');}
  if(!['https:','ssh:'].includes(url.protocol)||url.password||url.username&&url.protocol==='https:'||url.search||url.hash)throw new SfxError('仓库地址不能包含密码、令牌或查询参数；请使用系统 Git 凭据');
  return value;
}
export function gitFailure(error:unknown) {
  return String(error instanceof Error?error.message:error).replace(/https?:\/\/[^\s"']+/g,'[远程仓库]').replace(/(?:gh[pousr]_[\w]+|github_pat_[\w]+|Bearer\s+\S+)/gi,'[已隐藏]').replace(/\s+/g,' ').slice(0,650);
}
export class ProjectGit {
  private queue:Promise<unknown>=Promise.resolve();
  private loginState:{status:'idle'|'running'|'success'|'failed';error?:string}={status:'idle'};
  constructor(public root=path.resolve('.output/project-git'),private allowLocal=false){}
  private serial<T>(action:()=>Promise<T>):Promise<T>{const next=this.queue.then(action,action);this.queue=next.catch(()=>{});return next;}
  private async git(args:string[],cwd:string,timeout=120000){return exec(process.env.SPIELKISTE_GIT||'git',['-c','credential.helper=manager',...args],{cwd,windowsHide:true,timeout,maxBuffer:4*1024*1024,env:{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never',GIT_SSH_COMMAND:process.env.GIT_SSH_COMMAND||(process.platform==='win32'?'C:/Windows/System32/OpenSSH/ssh.exe -o BatchMode=yes':undefined)}});}
  async config(){try{return Config.parse(JSON.parse(await fs.readFile(path.join(this.root,'settings.json'),'utf8')));}catch{return undefined;}}
  async save(input:unknown){const config=Config.parse(input);validateRepository(config.repository,this.allowLocal);await writeJson(path.join(this.root,'settings.json'),config);return {...config,branch};}
  async snapshot(){const config=await this.config();return {configured:!!config,...config,branch,localProjectsOnly:true};}
  loginStatus(){return this.loginState;}
  async login(){
    const config=await this.config();if(!config||!/^https:\/\/github\.com\//i.test(config.repository))throw new SfxError('浏览器登录适用于 github.com 的 HTTPS 仓库；请先保存仓库地址。');
    if(this.loginState.status==='running')return this.loginState;
    let command='git-credential-manager.exe';
    if(process.env.SPIELKISTE_GIT){const base=path.resolve(process.env.SPIELKISTE_GIT,'../..');for(const arch of ['ucrt64','mingw64']){const candidate=path.join(base,arch,'bin/git-credential-manager.exe');try{await fs.access(candidate);command=candidate;break;}catch{}}}
    this.loginState={status:'running'};
    const child=spawn(command,['github','login','--browser'],{windowsHide:true,stdio:'ignore',env:{...process.env,GCM_INTERACTIVE:'always',GIT_TERMINAL_PROMPT:'0'}});
    const timer=setTimeout(()=>{child.kill();this.loginState={status:'failed',error:'GitHub 登录超时，请重试。'};},5*60*1000);
    child.once('error',()=>{clearTimeout(timer);this.loginState={status:'failed',error:'未找到 Git Credential Manager；桌面版已内置，源码版请先安装 Git for Windows。'};});
    child.once('exit',code=>{clearTimeout(timer);if(this.loginState.status==='running')this.loginState=code===0?{status:'success'}:{status:'failed',error:'GitHub 授权未完成，请重试。'};});
    return this.loginState;
  }
  private async checkout(){
    const config=await this.config();if(!config)throw new SfxError('请先在 Git 设置中填写项目仓库地址');
    validateRepository(config.repository,this.allowLocal);
    const directory=path.join(this.root,'repos',createHash('sha256').update(config.repository).digest('hex').slice(0,24));
    await fs.mkdir(directory,{recursive:true});
    try{await fs.access(path.join(directory,'.git'));}catch{await this.git(['init','-b',branch],directory);await this.git(['remote','add','origin',config.repository],directory);}
    const remote=(await this.git(['remote','get-url','origin'],directory)).stdout.trim();if(remote!==config.repository)throw new SfxError('项目 Git 工作目录与配置不一致');
    await this.git(['config','user.name',config.authorName],directory);await this.git(['config','user.email',config.authorEmail],directory);
    await this.git(['config','core.hooksPath',path.join(this.root,'disabled-hooks')],directory);
    const refs=(await this.git(['ls-remote','--heads','origin',`refs/heads/${branch}`],directory)).stdout;
    if(refs.trim()) {
      await this.git(['fetch','origin',branch],directory);
      try{await this.git(['rev-parse','HEAD'],directory);await this.git(['merge','--ff-only','FETCH_HEAD'],directory);}
      catch(error){
        try{await this.git(['rev-parse','HEAD'],directory);}catch{await this.git(['checkout','-B',branch,'FETCH_HEAD'],directory);return directory;}
        throw new SfxError(`远端有其他修改，请先解决分支差异；本机项目不受影响。${gitFailure(error)}`,409);
      }
    }
    return directory;
  }
  private async safePath(root:string,relative:string){
    const pieces=relative.split(/[\\/]/);if(pieces.some(piece=>piece==='..'||!piece)||path.isAbsolute(relative))throw new SfxError('项目 Git 路径无效');
    let current=root;for(const piece of pieces){current=path.join(current,piece);try{if((await fs.lstat(current)).isSymbolicLink())throw new SfxError('项目 Git 路径不能包含符号链接');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
    return current;
  }
  async test(){return this.serial(async()=>{const cwd=await this.checkout();return {ok:true,branch,git:(await this.git(['--version'],cwd)).stdout.trim()};});}
  async publish(project:{projectId:string;name:string;currentRunId:string},runs:SfxRun[],includeMedia:boolean){return this.serial(async()=>{
    const cwd=await this.checkout(),projectRoot=await this.safePath(cwd,`projects/${z.string().uuid().parse(project.projectId)}`);
    await fs.mkdir(projectRoot,{recursive:true});
    let mediaCount=0,totalBytes=0;
    const copied=new Map<string,string>();
    const copy=async(file:string,kind:string)=>{
      if(copied.has(file))return copied.get(file)!;
      const stat=await fs.stat(file);if(!stat.isFile())throw new SfxError('项目媒体不是普通文件');
      if(stat.size>95*1024*1024)throw new SfxError(`文件 ${path.basename(file)} 超过普通 Git 单文件限制，请取消“包含视频与已用音频”，或先压缩视频再上传。`);
      const digest=createHash('sha256');const handle=await fs.open(file,'r');try{for await(const chunk of handle.createReadStream())digest.update(chunk);}finally{await handle.close();}
      const name=`${digest.digest('hex')}${path.extname(file).toLowerCase()}`;
      const relative=`media/${kind}/${name}`,destination=await this.safePath(projectRoot,relative);
      await fs.mkdir(path.dirname(destination),{recursive:true});try{await fs.access(destination);}catch{await fs.copyFile(file,destination);}
      copied.set(file,relative);mediaCount++;totalBytes+=stat.size;return relative;
    };
    const versions=[];
    for(const source of runs){
      const run=structuredClone(source),ids=new Set(run.placements.map(item=>item.assetId));
      run.assets=run.assets.filter(item=>ids.has(item.id));
      const replacements=new Map<string,string>();
      replacements.set(run.videoPath,includeMedia?await copy(run.videoPath,'video'):`missing/${path.basename(run.videoPath)}`);
      for(const asset of run.assets){const relative=includeMedia?await copy(asset.path,'audio'):`missing/${asset.fileName}`;replacements.set(asset.path,relative);asset.path=relative;asset.relativePath=relative;}
      run.videoPath=replacements.get(source.videoPath)!;run.libraryPath='media/audio';delete run.musicLibraryPath;delete run.libraryPreferences;delete run.excludedLibraryPaths;
      if(run.render){
        if(includeMedia){replacements.set(run.render.video,await copy(run.render.video,'preview'));replacements.set(run.render.audio,await copy(run.render.audio,'preview'));run.render={...run.render,video:replacements.get(run.render.video)!,audio:replacements.get(run.render.audio)!};}
        else delete run.render;
      }
      run.scenes=run.scenes.map(scene=>({start:scene.start,end:scene.end}));
      for(const event of run.events){event.candidates=event.candidates.filter(c=>ids.has(c.assetId));for(const layer of event.layers||[])layer.candidates=layer.candidates.filter(c=>ids.has(c.assetId));}
      // Avoid shipping local full-library paths and cached reports in portable snapshots.
      if(run.workflow)run.workflow.options={keywordPreferences:run.keywordPreferences||[],excludedKeywords:run.excludedKeywords||[]};
      delete run.selectionReport;
      const scrub=(value:unknown):unknown=>typeof value==='string'?(replacements.get(value)||value.replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\n\r"<>|]*/g,'[本机路径]')):Array.isArray(value)?value.map(scrub):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,scrub(item)])):value;
      await writeJson(await this.safePath(projectRoot,`versions/${z.string().uuid().parse(run.id)}.json`),scrub(run));versions.push(run.id);
    }
    await writeJson(await this.safePath(projectRoot,'project.json'),{version:1,projectId:project.projectId,name:project.name,currentRunId:project.currentRunId,versions,includeMedia});
    const relative=`projects/${project.projectId}`;
    await this.git(['add','--',relative],cwd);
    if((await this.git(['diff','--cached','--name-only','--',relative],cwd)).stdout.trim())await this.git(['commit','--only','-m',`Spielkiste project: ${project.name.slice(0,120)}`,'--',relative],cwd);
    const commit=(await this.git(['rev-parse','HEAD'],cwd)).stdout.trim();
    try{await this.git(['push','-u','origin',`HEAD:refs/heads/${branch}`],cwd);return {status:'synced' as const,commit,mediaCount,totalBytes,branch};}
    catch(error){return {status:'pending-sync' as const,commit,error:gitFailure(error),mediaCount,totalBytes,branch};}
  });}
  async remoteProjects(){return this.serial(async()=>{const cwd=await this.checkout(),root=path.join(cwd,'projects');let names:string[]=[];try{names=await fs.readdir(root);}catch{return [];}
    const projects=[];for(const name of names){if(!z.string().uuid().safeParse(name).success)continue;try{const value=JSON.parse(await fs.readFile(path.join(root,name,'project.json'),'utf8'));projects.push({projectId:name,name:String(value.name),includeMedia:!!value.includeMedia});}catch{}}
    return projects;
  });}
  async download(projectId:string,targetRoot:string){return this.serial(async()=>{
    const cwd=await this.checkout(),id=z.string().uuid().parse(projectId),root=path.join(cwd,'projects',id),manifest=JSON.parse(await fs.readFile(path.join(root,'project.json'),'utf8'));
    if(manifest.projectId!==id||!Array.isArray(manifest.versions)||!manifest.versions.length||manifest.versions.length>1000||!manifest.versions.includes(manifest.currentRunId))throw new SfxError('远程项目清单不完整');
    const target=path.join(targetRoot,id);await fs.mkdir(target,{recursive:true});
    const runs:SfxRun[]=[];
    const resolve=async(relative:string)=>{const file=path.resolve(root,relative),rel=path.relative(root,file);if(rel.startsWith('..')||path.isAbsolute(rel))throw new SfxError('Git 项目媒体路径无效');
      const real=await fs.realpath(file),base=await fs.realpath(root);if(!real.startsWith(`${base}${path.sep}`))throw new SfxError('Git 项目不能引用外部文件');
      const dest=path.join(target,rel);await fs.mkdir(path.dirname(dest),{recursive:true});await fs.copyFile(file,dest);return dest;};
    if(!manifest.includeMedia)throw new SfxError('该项目只上传了清单，没有包含视频和音频；请在原电脑勾选媒体后重新上传。');
    for(const version of manifest.versions){const versionId=z.string().uuid().parse(version),versionPath=path.join(root,'versions',`${versionId}.json`);const real=await fs.realpath(versionPath),base=await fs.realpath(root);if(!real.startsWith(`${base}${path.sep}`))throw new SfxError('远程版本路径无效');const run=RunSchema.parse(JSON.parse(await fs.readFile(versionPath,'utf8')));if(run.id!==versionId||run.projectId!==id)throw new SfxError('远程版本标识不一致');run.videoPath=await resolve(run.videoPath);for(const asset of run.assets)asset.path=await resolve(asset.path);run.libraryPath=path.join(target,'media/audio');if(run.render){run.render.video=await resolve(run.render.video);run.render.audio=await resolve(run.render.audio);}runs.push(run);}
    return {runs,currentRunId:z.string().uuid().parse(manifest.currentRunId),name:String(manifest.name)};
  });}
}
