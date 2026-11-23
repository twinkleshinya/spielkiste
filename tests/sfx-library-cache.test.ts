import assert from "node:assert/strict";
import {promises as fs} from "node:fs";
import os from "node:os";
import path from "node:path";
import {createHash} from "node:crypto";
import {AudioLibraryCache} from "../src/sfx/AudioLibraryCache.js";
import type {AudioLibraryIndex} from "../src/sfx/models.js";
import {SfxService} from "../src/sfx/SfxService.js";
import {handleSfxRequest} from "../src/ui/sfx-routes.js";
import http from "node:http";
import {editorHarness} from "./sfx-edit-preview-ui.test.js";

export async function testLibraryIndexRefreshUi(){
  const ui=await editorHarness();let sent:any;let statusReads=0;
  ui.context.fetch=async(url:string,options:any)=>{
    if(options?.body){sent=JSON.parse(options.body);return {ok:true,json:async()=>({id:"index-job"})};}
    statusReads++;return {ok:true,json:async()=>({status:"ready",progress:"索引已更新 · 3 个音频"})};
  };
  ui.$("library-path").value="D:\\Library";ui.$("music-library-path").value="D:\\Music";
  ui.exec('libraryPreferences.load([{path:"E:\\\\Priority",weight:3}])');
  const before=ui.getRun();await ui.$("refresh-library-index").onclick();
  assert.deepEqual(sent.paths,["D:\\Library","E:\\Priority","D:\\Music"]);assert.equal(statusReads,1);
  assert.equal(ui.$("refresh-library-index").disabled,false);assert.deepEqual(ui.getRun(),before,"refresh never changes project sounds or renders video");
  ui.exec("resetToNewProject()");assert.equal(ui.$("library-path").value,"");assert.match(ui.$("library-index-status").textContent,/首次/);
}

export async function testLibraryIndexRefreshApi(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"spielkiste-index-api-")),library=path.join(root,"library");await fs.mkdir(library);
  const service=new SfxService(path.join(root,"output"));let scans=0;
  service.libraryCache=new AudioLibraryCache(path.join(root,"indexes"),async directory=>{scans++;return {version:1,root:directory,generatedAt:new Date().toISOString(),assets:[],warnings:[]};});
  const server=http.createServer((req,res)=>{void handleSfxRequest(req,res,new URL(req.url!,"http://localhost"),service);});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  try{
    const response=await fetch(base+"/api/sfx/library-index",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({paths:[library,library+path.sep]})});assert.equal(response.status,202);
    const {id}=await response.json() as {id:string};let result:any;
    for(let n=0;n<100;n++){result=await (await fetch(base+"/api/sfx/library-index/"+id)).json();if(result.status!=="indexing")break;await new Promise(resolve=>setTimeout(resolve,10));}
    assert.equal(result.status,"ready");assert.equal(scans,1);assert.equal(result.libraries.length,1);assert.equal(result.libraries[0].count,0);assert.ok(!JSON.stringify(result).includes('"assets"'));
    await service.libraryCache.get(library);assert.equal(scans,1);
    assert.equal((await fetch(base+"/api/sfx/library-index/missing")).status,404);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await fs.rm(root,{recursive:true,force:true});}
}

export async function testLibraryCacheReuseAndRefresh() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"spielkiste-index-")),library=path.join(root,"素材库"),cacheRoot=path.join(root,"indexes");
  await fs.mkdir(library);let calls=0,fail=false,names=["impact.wav"];
  const scan=async(directory:string):Promise<AudioLibraryIndex>=>{
    calls++;if(fail)throw new Error("network disconnected");
    return {version:1,root:directory,generatedAt:new Date().toISOString(),warnings:[],assets:names.map(fileName=>({id:fileName,fileName,path:path.join(directory,fileName),relativePath:fileName,size:1,mtimeMs:1,tags:[],usable:true}))};
  };
  try {
    const cache=new AudioLibraryCache(cacheRoot,scan);
    const first=await cache.get(library);assert.equal(first.source,"scan");assert.equal(calls,1);
    // Project-specific edits must never leak into another project's raw index.
    first.index.assets.length=0;first.index.excludedKeywords=["impact"];
    const restarted=new AudioLibraryCache(cacheRoot,scan);
    const hit=await restarted.get(library+path.sep);assert.equal(hit.source,"cache");assert.equal(hit.index.assets.length,1);assert.equal(hit.index.excludedKeywords,undefined);assert.equal(calls,1);
    names=["cast.wav","roar.wav"];
    assert.equal((await restarted.get(library)).index.assets[0].fileName,"impact.wav","ordinary reuse must not traverse the directory");
    const refreshed=await restarted.get(library,{refresh:true});assert.equal(calls,2);assert.deepEqual(refreshed.index.assets.map(a=>a.fileName),names);
    fail=true;await assert.rejects(restarted.get(library,{refresh:true}),/network disconnected/);
    assert.deepEqual((await restarted.get(library)).index.assets.map(a=>a.fileName),names,"failed refresh preserves last successful index");
    const cancelled=new AbortController();cancelled.abort();await assert.rejects(restarted.get(library,{signal:cancelled.signal}));
  } finally {await fs.rm(root,{recursive:true,force:true});}
}

export async function testLibraryCacheLegacyCorruptAndConcurrent() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"spielkiste-index-")),library=path.join(root,"library"),cacheRoot=path.join(root,"indexes");
  await fs.mkdir(library);await fs.mkdir(cacheRoot);let calls=0;
  const index:AudioLibraryIndex={version:1,root:library,generatedAt:new Date().toISOString(),warnings:[],assets:[{id:"a",fileName:"._fake.wav",path:path.join(library,"._fake.wav"),relativePath:"._fake.wav",tags:[],size:1,mtimeMs:1,usable:true}]};
  const rawFile=path.join(cacheRoot,createHash("sha256").update(library).digest("hex")+".json");
  await fs.writeFile(rawFile,JSON.stringify(index));
  const cache=new AudioLibraryCache(cacheRoot,async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,15));return {...index,assets:[]};});
  try {
    const legacy=await cache.get(library);assert.equal(legacy.source,"cache");assert.equal(calls,0);assert.equal(legacy.index.assets.length,0,"legacy AppleDouble pseudo-audio must not be reused");
    for(const file of await fs.readdir(cacheRoot))await fs.writeFile(path.join(cacheRoot,file),"broken");
    const results=await Promise.all([cache.get(library),cache.get(library)]);assert.equal(calls,1,"concurrent requests scan once");assert.deepEqual(results.map(r=>r.source).sort(),["cache","scan"]);
    assert.notEqual(results[0].index,results[1].index);
    await fs.rename(library,library+"-offline");await assert.rejects(cache.get(library),/不存在|无法/);
  } finally {await fs.rm(root,{recursive:true,force:true});}
}
