import {promises as fs} from "node:fs";
import path from "node:path";
import os from "node:os";

/** Bounded breadth-first search; no audio decoding, uploads or symlink traversal. */
export async function searchLocalFolders(input:{path:string;query:string;signal?:AbortSignal;maxDirectories?:number}) {
  if(!input.path?.trim())throw new Error('请先指定搜索范围目录。');
  const query=input.query?.normalize('NFKC').trim().toLocaleLowerCase();
  if(!query||query.length>120)throw new Error('请输入 1–120 字的路径关键词。');
  const root=path.resolve(input.path.trim().replace(/^"|"$/g,''));
  const signal=AbortSignal.any([...(input.signal?[input.signal]:[]),AbortSignal.timeout(10000)]);
  signal.throwIfAborted();
  const rootStat=await fs.stat(root);if(!rootStat.isDirectory())throw new Error('搜索范围必须是目录。');
  const queue=[root],folders:Array<{name:string;path:string}>=[];
  const max=Math.min(15000,Math.max(1,input.maxDirectories||8000));
  let scanned=0,skipped=0,truncated=false;
  while(queue.length&&scanned<max&&folders.length<200) {
    signal.throwIfAborted();const current=queue.shift()!;scanned++;
    try {
      let aborted:()=>void=()=>{};
      const entries=await Promise.race([fs.readdir(current,{withFileTypes:true}),new Promise<never>((_,reject)=>{
        aborted=()=>reject(signal.reason);signal.addEventListener('abort',aborted,{once:true});
      })]).finally(()=>signal.removeEventListener('abort',aborted));
      for(const entry of entries)if(entry.isDirectory()&&!entry.isSymbolicLink()&&!['.git','node_modules','$RECYCLE.BIN','System Volume Information'].includes(entry.name)) {
        const directory=path.join(current,entry.name);
        if(path.relative(root,directory).normalize('NFKC').toLocaleLowerCase().includes(query))folders.push({name:entry.name,path:directory});
        queue.push(directory);if(folders.length>=200){truncated=true;break;}
      }
    }catch(error){signal.throwIfAborted();if(current===root)throw error;skipped++;}
  }
  truncated ||= queue.length>0;
  return {path:root,folders,scanned,skipped,truncated};
}

/** Read one directory level only. Never scan, copy or upload library contents. */
export async function listLocalFolders(input:{path?:string;offset?:number}={}) {
  const offset=Math.max(0,Math.floor(input.offset||0));
  if(!input.path?.trim()) {
    const roots=process.platform==="win32"?"CDEFGHIJKLMNOPQRSTUVWXYZAB".split("").map(letter=>`${letter}:\\`):[path.parse(os.homedir()).root];
    const available=await Promise.all(roots.map(async root=>{
      let timer:NodeJS.Timeout|undefined;
      try {return await Promise.race([fs.stat(root).then(s=>s.isDirectory()?root:null).catch(()=>null),new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),1500);})]);}
      finally {if(timer)clearTimeout(timer);}
    }));
    return {path:"",parent:null,folders:available.filter((r):r is string=>r!==null).map(p=>({name:p,path:p})),nextOffset:null};
  }
  const directory=path.resolve(input.path.trim().replace(/^"|"$/g,""));
  try {
    const entries=await fs.readdir(directory,{withFileTypes:true});
    const folders=entries.filter(e=>e.isDirectory()&&!e.isSymbolicLink()).map(e=>({name:e.name,path:path.join(directory,e.name)})).sort((a,b)=>a.name.localeCompare(b.name,"zh-CN",{numeric:true}));
    return {path:directory,parent:path.dirname(directory)===directory?"":path.dirname(directory),folders:folders.slice(offset,offset+200),nextOffset:folders.length>offset+200?offset+200:null};
  } catch(e) {
    const code=(e as NodeJS.ErrnoException).code;
    throw new Error(code==="ENOENT"||code==="ENOTDIR"?"文件夹不存在，请检查路径。":code==="EACCES"||code==="EPERM"?"无法读取此目录，请选择有访问权限的文件夹。":"目录暂时无法读取，请检查磁盘或网络连接。");
  }
}
