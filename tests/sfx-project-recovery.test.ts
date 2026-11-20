import assert from "node:assert/strict";
import {promises as fs} from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import {SfxService} from "../src/sfx/SfxService.js";
import {SfxRunStore} from "../src/sfx/SfxRunStore.js";
import {handleSfxRequest} from "../src/ui/sfx-routes.js";

export async function testSavedProjectRecovery() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"sfx-recovery-"));
  let service=new SfxService(root);
  const server=http.createServer(async(req,res)=>{
    if(!await handleSfxRequest(req,res,new URL(req.url!,"http://localhost"),service)){res.writeHead(404);res.end();}
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const post=(body:unknown,headers:Record<string,string>={})=>fetch(base+"/api/sfx/workspace",{method:"POST",headers:{"content-type":"application/json",...headers},body:JSON.stringify(body)});
  try {
    const empty=await fetch(base+"/api/sfx/workspace");
    assert.equal(empty.status,200,"a new browser needs a server-side recovery endpoint");
    assert.deepEqual(await empty.json(),{runId:null});
    const first=await service.store.createRun({name:"Boss 编辑6",videoPath:path.join(root,"video.mp4"),libraryPath:root});
    first.status="ready";await service.store.save(first);
    const later=await service.store.createRun({name:"另一段视频",videoPath:path.join(root,"other.mp4"),libraryPath:root});
    later.status="ready";later.createdAt="2099-01-01T00:00:00.000Z";await service.store.save(later);
    const projectFile=path.join(service.store.directory(first.id),"run.json");
    const original=await fs.readFile(projectFile,"utf8");
    assert.equal((await post({runId:first.id})).status,200);
    service=new SfxService(root);
    const restored=await fetch(base+"/api/sfx/workspace");
    assert.deepEqual(await restored.json(),{runId:first.id},"recovery survives service restarts and has no browser cookie dependency");
    await fetch(base+`/api/sfx/runs/${later.id}`);
    await fetch(base+"/api/sfx/runs");
    assert.deepEqual(await (await fetch(base+"/api/sfx/workspace")).json(),{runId:first.id},"background reads must not change the active project");
    assert.equal(await fs.readFile(projectFile,"utf8"),original,"opening and remembering cannot rewrite the accepted project");
    assert.equal((await post({runId:"../elsewhere"})).status,400);
    assert.equal((await post({runId:"00000000-0000-0000-0000-000000000000"})).status,404);
    assert.equal((await post({runId:later.id},{origin:"http://evil.example"})).status,403);
    assert.equal((await fetch(base+"/api/sfx/workspace",{headers:{"sec-fetch-site":"cross-site"}})).status,403);
    await fs.unlink(projectFile);
    assert.deepEqual(await (await fetch(base+"/api/sfx/workspace")).json(),{runId:later.id},"a removed project must not trap new browsers on a broken page");
  } finally {
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await fs.rm(root,{recursive:true,force:true});
  }
}

export async function testProjectSummaryMigration() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"sfx-summaries-"));
  try {
    let store=new SfxRunStore(root);
    const run=await store.createRun({name:"已保存的编辑版",videoPath:path.join(root,"video.mp4"),libraryPath:root});
    run.status="ready";await store.save(run);
    const file=path.join(store.directory(run.id),"run.json");
    const summaryFile=path.join(store.directory(run.id),"summary.json");
    await fs.rm(summaryFile,{force:true});
    const before=await fs.readFile(file,"utf8");
    store=new SfxRunStore(root);
    const migrated=await store.list();
    assert.equal(migrated[0].name,"已保存的编辑版");
    assert.equal(await fs.readFile(file,"utf8"),before,"legacy migration only writes a rebuildable summary");
    assert.equal(await fs.stat(summaryFile).then(()=>true,()=>false),true,"history must gain a compact persistent index");
    store=new SfxRunStore(root);
    store.readRun=async()=>{throw new Error("history must not parse the complete library on a cache hit");};
    assert.equal((await store.list())[0].id,run.id,"a fresh service can list projects from compact summaries");
    run.name="外部保存后的新名称";run.revision=3;await fs.writeFile(file,JSON.stringify(run));
    store=new SfxRunStore(root);
    assert.equal((await store.list())[0].name,"外部保存后的新名称","stale summary must not hide saved changes");
    await fs.writeFile(summaryFile,"broken cache");
    assert.equal((await store.list())[0].id,run.id,"corrupt summaries rebuild from the original run");
    await fs.writeFile(file,"incomplete project");
    assert.equal((await new SfxRunStore(root).list()).length,0,"a broken project must not block the whole project library");
  } finally {await fs.rm(root,{recursive:true,force:true});}
}

export async function testClientRunPayloadOmitsUnreferencedLibraryAssets() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"sfx-client-payload-"));
  const service=new SfxService(root), server=http.createServer(async(req,res)=>{
    if(!await handleSfxRequest(req,res,new URL(req.url!,"http://localhost"),service)){res.writeHead(404);res.end();}
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const asset=(id:string)=>({id,path:path.join(root,`${id}.wav`),relativePath:`${id}.wav`,fileName:`${id}.wav`,size:1,mtimeMs:1,tags:[],duration:1,channels:1,sampleRate:48000,usable:true});
  try {
    const run=await service.store.createRun({name:"大素材库客户端响应",videoPath:path.join(root,"video.mp4"),libraryPath:root});
    const used=asset("used"),unused=asset("unused");
    const event={id:"event",start:0,end:1,type:"impact",description:"命中",query:"impact",category:"impact" as const,confidence:1,source:"manual" as const,candidates:[{assetId:used.id,score:1,reason:"filename"}],requiresHumanReview:false};
    Object.assign(run,{duration:1,status:"ready" as const,assets:[used,unused],events:[event],placements:[{id:"placement",eventId:event.id,assetId:used.id,start:0,duration:1,sourceOffset:0,gainDb:-6,fadeIn:.01,fadeOut:.05,category:"impact" as const,enabled:true}]});
    await service.store.save(run);
    const response=await fetch(base+`/api/sfx/runs/${run.id}`);
    assert.equal(response.status,200);
    const body=await response.json() as {assets:Array<{id:string}>;events:unknown[];placements:unknown[]};
    assert.deepEqual(body.assets.map(asset=>asset.id),[used.id],"opening a project must return only assets referenced by its editable timeline");
    assert.equal(body.events.length,1);
    assert.equal(body.placements.length,1);
  } finally {
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await fs.rm(root,{recursive:true,force:true});
  }
}
