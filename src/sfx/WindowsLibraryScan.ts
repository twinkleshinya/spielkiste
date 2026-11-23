import {spawn} from "node:child_process";
import {createInterface} from "node:readline";
import {appResource} from "./RuntimePaths.js";

export type LibraryFile = {path:string;size:number;mtimeMs:number};
/** Windows directory enumeration returns size and timestamps in the same request. */
export async function scanWindowsLibrary(root:string,onFile:(file:LibraryFile)=>void,onWarning:(warning:string)=>void,signal?:AbortSignal) {
  signal?.throwIfAborted();
  const child=spawn("powershell.exe",["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",appResource("scripts/scan-audio-library.ps1")],{windowsHide:true,env:{...process.env,SPIELKISTE_SCAN_ROOT:root},stdio:["ignore","pipe","pipe"]});
  let stderr="",failure:unknown;
  const abort=()=>child.kill();signal?.addEventListener("abort",abort,{once:true});
  const lines=createInterface({input:child.stdout});
  lines.on("line",line=>{if(failure||signal?.aborted)return;try {
    const entry=JSON.parse(line);
    if(typeof entry.warning==="string")onWarning(entry.warning);
    else if(typeof entry.path==="string"&&Number.isFinite(entry.size)&&Number.isFinite(entry.mtimeMs))onFile(entry);
    else throw new Error("Invalid Windows library metadata");
  }catch(error){failure=error;child.kill();}});
  child.stderr.on("data",data=>{stderr=(stderr+data.toString()).slice(-2000);});
  try {
    await new Promise<void>((resolve,reject)=>{child.once("error",reject);child.once("close",code=>failure?reject(failure):signal?.aborted?reject(signal.reason):code===0?resolve():reject(new Error(`Windows 素材库扫描失败：${stderr||code}`)));});
    signal?.throwIfAborted();
  }finally{signal?.removeEventListener("abort",abort);lines.close();}
}
