import {promises as fs} from "node:fs";
import path from "node:path";
import {createHash,randomUUID} from "node:crypto";
import {AssetSchema,type AudioLibraryIndex,SfxError} from "./models.js";
import {AudioLibraryIndexer} from "./AudioLibraryIndexer.js";
import {preferenceKey,preferencePath} from "./LibraryPreferences.js";

type Options={refresh?:boolean;signal?:AbortSignal;progress?:(count:number)=>void};
type Scan=(directory:string,previous?:AudioLibraryIndex,progress?:(count:number)=>void,signal?:AbortSignal)=>Promise<AudioLibraryIndex>;
type Pending={promise:Promise<void>;controller:AbortController;listeners:Set<(count:number)=>void>;users:number};

/** Raw, local-only directory snapshots. Project weights, styles and exclusions never enter this cache. */
export class AudioLibraryCache {
  private pending=new Map<string,Pending>();
  constructor(public root:string,private scan:Scan=(...args)=>new AudioLibraryIndexer().indexDirectory(...args)){}
  private file(directory:string){return path.join(this.root,createHash("sha256").update(preferenceKey(directory)).digest("hex")+".json");}
  private async read(directory:string):Promise<AudioLibraryIndex|undefined>{
    const legacy=path.join(this.root,createHash("sha256").update(directory).digest("hex")+".json");
    for(const file of new Set([this.file(directory),legacy])){
      try {
        const raw=JSON.parse(await fs.readFile(file,"utf8"));
        if(raw.version!==1||typeof raw.root!=="string"||preferenceKey(raw.root)!==preferenceKey(directory)||!Number.isFinite(Date.parse(raw.generatedAt))||!Array.isArray(raw.assets)||!Array.isArray(raw.warnings)||raw.warnings.some((w:unknown)=>typeof w!=="string"))continue;
        // Validate records without constructing a second full-library Zod clone.
        for(const asset of raw.assets)AssetSchema.parse(asset);
        // Adopt earlier raw-path cache names without copying a huge JSON file.
        // Subsequent path spelling/case variants can then use the canonical key.
        if(file!==this.file(directory))await fs.link(file,this.file(directory)).catch(()=>{});
        return {version:1,root:raw.root,generatedAt:raw.generatedAt,warnings:raw.warnings,assets:raw.assets.filter((a:{fileName:string})=>!a.fileName.startsWith("._"))};
      }catch{/* missing or invalid snapshot: scan again */}
    }
  }
  async get(value:string,options:Options={}):Promise<{index:AudioLibraryIndex;source:"cache"|"scan"}>{
    options.signal?.throwIfAborted();
    const directory=preferencePath(value),key=preferenceKey(directory);
    try{if(!(await fs.stat(directory)).isDirectory())throw new Error();}catch{throw new SfxError(`素材库目录不存在或无法访问：${directory}`);}
    options.signal?.throwIfAborted();
    let job=this.pending.get(key);
    if(!job){
      const previous=await this.read(directory);options.signal?.throwIfAborted();
      job=this.pending.get(key);
      if(!job&&!options.refresh&&previous)return {index:previous,source:"cache"};
      if(!job){
        const controller=new AbortController();
        job={promise:Promise.resolve(),controller,listeners:new Set(),users:0};
        const current=job;
        current.promise=(async()=>{
          let timer:NodeJS.Timeout|undefined;
          const heartbeat=()=>{clearTimeout(timer);timer=setTimeout(()=>controller.abort(new Error("素材库扫描连续 10 分钟没有进展，请检查共享盘连接。")),10*60*1000);};
          const temporary=this.file(directory)+"."+randomUUID()+".tmp";
          try{
            heartbeat();
            const index=await this.scan(directory,previous,count=>{heartbeat();for(const listener of current.listeners)listener(count);},controller.signal);
            controller.signal.throwIfAborted();
            const raw={version:1,root:index.root,generatedAt:index.generatedAt,assets:index.assets,warnings:index.warnings};
            await fs.mkdir(this.root,{recursive:true});await fs.writeFile(temporary,JSON.stringify(raw));
            controller.signal.throwIfAborted();await fs.rename(temporary,this.file(directory));
          }finally{clearTimeout(timer);await fs.rm(temporary,{force:true}).catch(()=>{});}
        })().finally(()=>{if(this.pending.get(key)===current)this.pending.delete(key);});
        this.pending.set(key,current);
        return this.wait(current,directory,options,"scan");
      }
    }
    return this.wait(job,directory,options,"cache");
  }
  private async wait(job:Pending,directory:string,options:Options,source:"cache"|"scan"){
    job.users++;if(options.progress)job.listeners.add(options.progress);
    let abort:()=>void=()=>{};
    try{
      await Promise.race([job.promise,new Promise<never>((_,reject)=>{
        abort=()=>reject(options.signal?.reason||new Error("已取消"));
        options.signal?.addEventListener("abort",abort,{once:true});if(options.signal?.aborted)abort();
      })]);
      options.signal?.throwIfAborted();
      const index=await this.read(directory);if(!index)throw new Error("素材库索引写入后无法读取，请重试");
      return {index,source};
    }finally{
      options.signal?.removeEventListener("abort",abort);if(options.progress)job.listeners.delete(options.progress);
      if(--job.users===0)job.controller.abort(new Error("索引请求已取消"));
    }
  }
}
