import assert from "node:assert/strict";
import {promises as fs} from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import {SfxService} from "../src/sfx/SfxService.js";
import {EventSchema,PlacementSchema} from "../src/sfx/models.js";
import {handleSfxRequest} from "../src/ui/sfx-routes.js";
import {execa} from "execa";

export async function testPreservedVersionReuse() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"sfx-preserved-"));
  const service=new SfxService(path.join(root,"output"));
  const server=http.createServer((req,res)=>{void handleSfxRequest(req,res,new URL(req.url!,"http://localhost"),service);});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const post=(route:string,body:unknown)=>fetch(base+route,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  const previous=process.env.SFX_USE_CCSWITCH;process.env.SFX_USE_CCSWITCH="0";
  try {
    const video=path.join(root,"video.mp4"),copy=path.join(root,"uploaded-copy.mp4"),library=path.join(root,"library");
    await fs.mkdir(library);await fs.writeFile(video,"same video bytes");await fs.copyFile(video,copy);
    const run=await service.store.createRun({videoPath:video,libraryPath:library});
    Object.assign(run,{status:"ready",duration:3,assets:[{id:"a",path:path.join(library,"charge.wav"),relativePath:"charge.wav",fileName:"charge.wav",size:1,mtimeMs:1,tags:[],usable:true,duration:3}],
      events:[EventSchema.parse({id:"e",start:1,end:2,type:"charge_hold",phase:"sustain",actor:"player",query:"charge loop",description:"持续蓄力",category:"other",source:"vision",confidence:.9,candidates:[],requiresHumanReview:false})],
      placements:[PlacementSchema.parse({id:"p",eventId:"e",assetId:"a",start:1,duration:1,sourceOffset:.3,gainDb:-4,fadeIn:.005,fadeOut:.08,category:"other",enabled:true})]});
    const dir=service.store.directory(run.id);run.render={video:path.join(dir,"preview.mp4"),audio:path.join(dir,"preview.wav"),revision:0};
    await fs.writeFile(run.render.video,"accepted preview");await fs.writeFile(run.render.audio,"accepted audio");await service.store.save(run);
    const original=await fs.readFile(path.join(dir,"run.json"),"utf8");
    const invalid=await post(`/api/sfx/runs/${run.id}/preserve`,{revision:99});assert.equal(invalid.status,409,"approval must target the currently displayed revision");
    const preserved=await post(`/api/sfx/runs/${run.id}/preserve`,{revision:0});
    assert.equal(preserved.status,200,"an accepted version needs a persistent keep-sounds action");
    assert.equal((await preserved.json() as {runId:string}).runId,run.id);
    const recreated=new SfxService(path.join(root,"output"));
    const reusedViaApi=await post("/api/sfx/runs",{videoPath:copy,libraryPath:library});
    assert.equal(reusedViaApi.status,202,"accepted media must remain accessible through the API without AI");
    assert.equal((await reusedViaApi.json() as {runId:string}).runId,run.id);
    const same=await recreated.create({videoPath:copy,libraryPath:library});
    assert.equal(same.runId,run.id,"identical video uploaded at a new path must open the preserved sounds instead of reselecting");
    await assert.rejects(recreated.create({videoPath:copy,libraryPath:library,audioOutputMode:"sfx"}),/Gemini AI/,
      "changing from all audio to SFX only must not reopen a preserved full-audio preview");
    await assert.rejects(recreated.create({videoPath:copy,libraryPath:library,style:'修仙'}),/Gemini AI/,'a new style must not reopen an old unstyled take');
    await assert.rejects(recreated.create({videoPath:copy,libraryPath:library,soundRequirements:'轻一点'}),/Gemini AI/,'new sound requirements must not reuse old matching results');
    assert.equal(await fs.readFile(path.join(dir,"run.json"),"utf8"),original,"preservation/reopening cannot rewrite the reference");
    const preview=await recreated.render(run.id);assert.equal(preview.runId,run.id);
    assert.equal(await fs.readFile(run.render.video,"utf8"),"accepted preview","rendering an unchanged accepted preview must reuse its exact bytes");
    assert.equal(await fs.readFile(path.join(dir,"run.json"),"utf8"),original);
    await assert.rejects(recreated.create({videoPath:copy,libraryPath:library,reusePreserved:false}),/Gemini AI/,"fresh generation requires AI even when an accepted version exists");
    const different=path.join(root,"different.mp4");await fs.writeFile(different,"different video bytes");
    await assert.rejects(recreated.create({videoPath:different,libraryPath:library}),/Gemini AI/,"different video content requires a new AI analysis");
    const otherLibrary=path.join(root,"other-library");await fs.mkdir(otherLibrary);
    await assert.rejects(recreated.create({videoPath:copy,libraryPath:otherLibrary}),/Gemini AI/,"a different supplied library requires fresh choices");
    const gateway=path.join(root,"gateway.toml");
    await fs.writeFile(gateway,'[model_providers.custom]\nbase_url = "http://127.0.0.1:1/v1"\n');
    const overrides:Record<string,string|undefined>={SFX_USE_CCSWITCH:undefined,SFX_CCSWITCH_CONFIG:gateway,SFX_CCSWITCH_MODEL:"gemini-4-hydrogen",SFX_CCSWITCH_REASONING_EFFORT:undefined,SFX_CCSWITCH_BASE_URL:undefined,SFX_CCSWITCH_BEARER:undefined};
    const before=new Map(Object.keys(overrides).map(key=>[key,process.env[key]]));
    try {
      for(const [key,value] of Object.entries(overrides)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
      await assert.rejects(recreated.create({videoPath:copy,libraryPath:library}),/Gemini AI/,"selecting Hydrogen must require fresh analysis rather than silently reuse an Argon preview");
      process.env.SFX_CCSWITCH_MODEL="gemini-4-argon";
      assert.equal((await recreated.create({videoPath:copy,libraryPath:library})).runId,run.id,"the matching model can still reopen its accepted preview without a new connection test");
      process.env.SFX_CCSWITCH_REASONING_EFFORT="xhigh";
      await assert.rejects(recreated.create({videoPath:copy,libraryPath:library}),/Gemini AI/,"changing effort must require fresh analysis instead of reusing a high preview");
    }finally{for(const [key,value] of before){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
    run.placements[0].sourceOffset=.4;await service.store.save(run);
    await assert.rejects(recreated.create({videoPath:copy,libraryPath:library}),/保留.*修改/ ,"changed approved edits must not silently trigger a fresh model run");
  }finally {
    if(previous===undefined)delete process.env.SFX_USE_CCSWITCH;else process.env.SFX_USE_CCSWITCH=previous;
    await new Promise<void>(resolve=>server.close(()=>resolve()));await fs.rm(root,{recursive:true,force:true});
  }
}

export async function testRemixPreservesSourceRanges() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"sfx-remix-preserve-"));
  try {
    const service=new SfxService(root),run=await service.store.createRun({videoPath:"v.mp4",libraryPath:root});
    Object.assign(run,{duration:4,status:"ready",assets:[{id:"a",path:path.join(root,"roar.wav"),fileName:"roar.wav",relativePath:"roar.wav",duration:3,size:1,mtimeMs:1,tags:[],usable:true,onset:0,rmsDb:-18,peakDb:-2}],
      events:[EventSchema.parse({id:"e",start:1,end:1.2,type:"boss_roar",actor:"boss",query:"roar",description:"猩猩咆哮",category:"other",source:"vision",confidence:.9,candidates:[],requiresHumanReview:false})],
      placements:[PlacementSchema.parse({id:"p",eventId:"e",assetId:"a",start:1,duration:1.1,sourceOffset:.6,gainDb:-20,fadeIn:.012,fadeOut:.09,category:"other",enabled:true})]});
    await service.store.save(run);
    const {runId}=await service.automix(run.id,{revision:0,autoRender:false});const mixed=await service.waitForIdle(runId);
    assert.equal(mixed.status,"ready");
    const p=mixed.placements[0];
    assert.deepEqual({assetId:p.assetId,start:p.start,sourceOffset:p.sourceOffset,duration:p.duration,fadeIn:p.fadeIn,fadeOut:p.fadeOut},
      {assetId:"a",start:1,sourceOffset:.6,duration:1.1,fadeIn:.012,fadeOut:.09},"mix-only must retain the exact selected vocal body, tail and fades even for legacy clips without sourceEdit metadata");
    assert.notEqual(p.gainDb,-20,"mix-only still adjusts levels");
    const usage=JSON.parse(await fs.readFile(path.join(service.store.directory(runId),"usage-report.json"),"utf8"));
    assert.equal(usage.requests.length,0,"mix-only cannot call Gemini or change selection");
  }finally {await fs.rm(root,{recursive:true,force:true});}
}

export async function testSavedPreviewRetainsMix() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"sfx-saved-preview-"));
  try {
    const video=path.join(root,"video.mp4"),audio=path.join(root,"roar.wav");
    await execa("ffmpeg",["-v","error","-y","-f","lavfi","-i","color=c=blue:s=160x90:d=3","-c:v","libx264",video]);
    await execa("ffmpeg",["-v","error","-y","-f","lavfi","-i","sine=duration=3",audio]);
    const service=new SfxService(path.join(root,"output")),run=await service.store.createRun({videoPath:video,libraryPath:root});
    Object.assign(run,{status:"ready",duration:3,assets:[{id:"a",path:audio,fileName:"roar.wav",relativePath:"roar.wav",size:1,mtimeMs:1,tags:[],duration:3,rmsDb:-18,peakDb:-2,onset:0,usable:true}],
      events:[EventSchema.parse({id:"e",start:1,end:1.2,type:"boss_roar",query:"roar",description:"咆哮",category:"other",confidence:.9,source:"vision",candidates:[],requiresHumanReview:false})],
      placements:[PlacementSchema.parse({id:"p",eventId:"e",assetId:"a",start:1,sourceOffset:1.9004,duration:1.0996,gainDb:-20,fadeIn:.6,fadeOut:.3,category:"other",enabled:true})]});
    await service.store.save(run);
    const {runId}=await service.render(run.id),rendered=await service.waitForIdle(runId);
    assert.equal(rendered.status,"ready",rendered.error);
    assert.deepEqual(rendered.placements,run.placements,"preview refresh must render saved gains and source edits without making new mix/edit decisions");
    assert.ok(rendered.render);assert.ok((await fs.stat(rendered.render.video)).size>0);
  }finally {await fs.rm(root,{recursive:true,force:true});}
}
