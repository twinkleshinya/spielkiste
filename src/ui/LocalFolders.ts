import {promises as fs} from "node:fs";
import path from "node:path";
import os from "node:os";

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
