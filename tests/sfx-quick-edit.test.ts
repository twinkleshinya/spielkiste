import assert from "node:assert/strict";
import {promises as fs} from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import {execa} from "execa";
import {SfxService} from "../src/sfx/SfxService.js";
import {EventSchema,PlacementSchema,type SfxRun} from "../src/sfx/models.js";
import {handleSfxRequest} from "../src/ui/sfx-routes.js";

export async function testQuickEditApi() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"sfx-quick-edit-"));
  const service=new SfxService(path.join(root,"output"));
  const server=http.createServer((req,res)=>{void handleSfxRequest(req,res,new URL(req.url!,"http://localhost"),service);});
  // Windows may allocate a port rejected by Fetch (for example 6000 or 10080).
  // Keep the test HTTP server outside that range so the random allocation is stable.
  do {
    await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
    if ((server.address() as {port:number}).port > 10080) break;
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  } while (true);
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const post=(id:string,body:unknown,action="quick-edit")=>fetch(`${base}/api/sfx/runs/${id}/${action}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  try {
    const video=path.join(root,"source.mp4"),audio=path.join(root,"tone.wav");
    await execa("ffmpeg",["-v","error","-y","-f","lavfi","-i","color=c=blue:s=160x90:r=25:d=2","-c:v","libx264",video]);
    await execa("ffmpeg",["-v","error","-y","-f","lavfi","-i","sine=frequency=600:duration=2",audio]);
    const source=await service.store.createRun({videoPath:video,libraryPath:root,name:"quick edit fixture"});
    Object.assign(source,{status:"ready",duration:2,assets:[{id:"a",path:audio,fileName:"tone.wav",relativePath:"tone.wav",duration:2,size:1,mtimeMs:1,tags:[],usable:true,rmsDb:-21,peakDb:-18}],
      events:[EventSchema.parse({id:"event",start:.2,end:1.5,type:"impact",query:"impact",description:"test action",category:"impact",confidence:1,source:"manual",candidates:[],requiresHumanReview:false})],
      placements:[true,false].map((enabled,i)=>PlacementSchema.parse({id:`clip${i}`,eventId:"event",layerId:`layer${i}`,assetId:"a",start:.2,sourceOffset:.1,duration:1.3,gainDb:-8,fadeIn:.01,fadeOut:.1,category:"impact",enabled}))});
    await service.store.save(source);await service.render(source.id);const rendered=await service.waitForIdle(source.id);
    assert.equal(rendered.status,"ready",rendered.error);
    const parentBytes=await fs.readFile(path.join(service.store.directory(source.id),"run.json"));
    const parentVideo=await fs.readFile(rendered.render!.video);
    const change=async(run:SfxRun,target:string,targetId:string,action:string)=>{
      const response=await post(run.id,{revision:run.revision,target,targetId,action});
      assert.equal(response.status,202,await response.clone().text());
      const result=await response.json() as {runId:string};assert.notEqual(result.runId,run.id);
      const next=await service.waitForIdle(result.runId);assert.equal(next.status,"ready",next.error);
      assert.equal(next.parentRunId,run.id);assert.equal(next.render?.revision,next.revision);
      const usage=JSON.parse(await fs.readFile(path.join(service.store.directory(next.id),"usage-report.json"),"utf8"));
      assert.equal(usage.requests.length,0,"quick edits must not request new model analysis/selection");
      return next;
    };
    const muted=await change(rendered,"event","event","mute");
    assert.equal((muted.events[0] as typeof muted.events[0]&{muted?:boolean}).muted,true);
    assert.deepEqual(muted.placements,rendered.placements,"event mute must retain the prior clip states and source edits");
    const report=JSON.parse(await fs.readFile(path.join(service.store.directory(muted.id),"workflow-report.json"),"utf8"));
    assert.equal(report.counts.placements,0);assert.equal(report.counts.mutedEvents,1);
    const exported=JSON.parse(await fs.readFile(path.join(service.store.directory(muted.id),"placements.json"),"utf8"));assert.equal(exported.placements[0].eventMuted,true);
    const silence=await execa("ffmpeg",["-hide_banner","-i",muted.render!.audio,"-af","volumedetect","-f","null","-"]);
    assert.match(silence.stderr,/max_volume: -91\.0 dB|mean_volume: -91\.0 dB/);
    const restored=await change(muted,"event","event","unmute");
    assert.equal(restored.placements[1].enabled,false,"restoring an event cannot restore an individually disabled clip");
    const restoredVolume=await execa("ffmpeg",["-hide_banner","-i",restored.render!.audio,"-af","volumedetect","-f","null","-"]);assert.doesNotMatch(restoredVolume.stderr,/max_volume: -91\.0/);
    const mutedClip=await change(restored,"placement","clip0","mute");assert.equal(mutedClip.placements[0].enabled,false);
    const enabledClip=await change(mutedClip,"placement","clip0","unmute");assert.equal(enabledClip.placements[0].enabled,true);
    const deletedClip=await change(enabledClip,"placement","clip0","delete");assert.equal(deletedClip.placements.length,1);assert.equal(deletedClip.events.length,1);
    const deletedEvent=await change(deletedClip,"event","event","delete");assert.equal(deletedEvent.events.length,0);assert.equal(deletedEvent.placements.length,0);assert.ok(deletedEvent.render);
    const empty=await service.store.createRun({videoPath:video,libraryPath:root});Object.assign(empty,{status:"ready",duration:2});await service.store.save(empty);
    await service.render(empty.id);assert.equal((await service.waitForIdle(empty.id)).status,"ready","deleting every clip must still permit a silent preview");
    assert.equal((await post(rendered.id,{revision:99,target:"event",targetId:"event",action:"mute"})).status,409);
    assert.equal((await post(rendered.id,{revision:rendered.revision,target:"placement",targetId:"missing",action:"delete"})).status,404);
    const draft={revision:restored.revision,events:restored.events,placements:restored.placements.map(p=>({...p,gainDb:-12})),originalGainDb:restored.originalGainDb,originalMuted:restored.originalMuted,musicEnabled:restored.musicEnabled};
    const response=await post(restored.id,draft,"edit-preview");assert.equal(response.status,202,await response.clone().text());
    const updated=await service.waitForIdle((await response.json() as {runId:string}).runId);
    assert.equal(updated.placements[0].gainDb,-12);assert.equal(updated.render?.revision,updated.revision);
    assert.deepEqual(await fs.readFile(path.join(service.store.directory(source.id),"run.json")),parentBytes);
    assert.deepEqual(await fs.readFile(rendered.render!.video),parentVideo,"quick editing cannot overwrite an earlier preview");
    const packets=async(file:string)=>(await execa("ffmpeg",["-v","error","-i",file,"-map","0:v:0","-c:v","copy","-f","hash","-"])).stdout;
    assert.equal(await packets(muted.render!.video),await packets(rendered.render!.video),"quick previews must reuse encoded frames without generation loss");
    await service.preserve(rendered.id,{revision:rendered.revision});
    await fs.unlink(rendered.render!.audio);
    const noOp={revision:rendered.revision,events:rendered.events,placements:rendered.placements,originalGainDb:rendered.originalGainDb,originalMuted:rendered.originalMuted,musicEnabled:rendered.musicEnabled};
    assert.equal((await post(rendered.id,noOp,"edit-preview")).status,409,"missing accepted media cannot be silently regenerated by a no-op preview update");
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));await fs.rm(root,{recursive:true,force:true});}
}
