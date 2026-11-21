import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventSchema, PlacementSchema, type AudioAsset, type SoundEvent } from "../src/sfx/models.js";
import { planAutoMix, isForeground } from "../src/sfx/AutoMix.js";
import { analyzeTemporal, mergeWindowEvents } from "../src/sfx/TemporalAnalysis.js";
import { SfxRunStore, exportTimeline } from "../src/sfx/SfxRunStore.js";
import { buildWorkflowReport } from "../src/sfx/WorkflowReport.js";
import { runFfmpeg } from "../src/sfx/FfmpegBinaries.js";
import { SfxRenderer } from "../src/sfx/SfxRenderer.js";

const source: AudioAsset = { id:"a", path:"stone.wav", fileName:"stone.wav", relativePath:"stone.wav", size:1, mtimeMs:1, tags:[], usable:true, duration:2, rmsDb:-18, peakDb:-1 };
const distance = (range:string, confidence=.9, evidence="声源位于场地远侧，与前景玩家之间可见一段空地") => ({range,confidence,evidence});
const event = (id:string, values:Record<string,unknown>={}) => EventSchema.parse({id,start:1,end:1.2,type:"ground_slam",actor:"boss",phase:"contact",category:"impact",description:"Boss砸地",query:"ground slam",confidence:.9,source:"vision",candidates:[],requiresHumanReview:true,...values});
const clip = (e:SoundEvent) => PlacementSchema.parse({id:`p-${e.id}`,eventId:e.id,assetId:"a",role:e.category==="impact"?"impact":e.category==="music"?"music":"foley",start:1,duration:.8,sourceOffset:0,gainDb:-4,fadeIn:.01,fadeOut:.08,category:e.category,enabled:true});
const mix = (events:SoundEvent[], assets=[source]) => planAutoMix({duration:4,events,assets,placements:events.map(clip)},{preserveSourceEdits:true});

export function testDistanceMixHierarchy() {
  const near=event("near",{distance:distance("near"),importance:"key"});
  const far=event("far",{distance:distance("far"),importance:"key"});
  const detail=event("detail",{type:"boss_footstep",description:"远处轻微脚步",importance:"detail",distance:distance("far")});
  const a=mix([near]).placements[0],b=mix([far]).placements[0],c=mix([detail]).placements[0];
  assert.ok(b.gainDb<=a.gainDb-7,"distance must attenuate after source peak limiting, even for high-crest recordings");
  assert.ok(b.gainDb>=c.gainDb+8,"distant key actions remain above distant footsteps rather than making every impact foreground");
  assert.equal(isForeground(detail,c,source),false,"minor contact details must not trigger foreground protection");
  const steps=event("steps",{type:"boss_footstep",distance:distance("far")});
  assert.ok(mix([steps]).placements[0].gainDb<b.gainDb-5,"legacy foot contact labels should not receive the main ground-slam level");
  const roar=event("roar",{type:"boss_roar",category:"other",phase:"preparation",distance:distance("far"),importance:"detail"});
  assert.equal(isForeground(roar,mix([roar]).placements[0],{fileName:"ape_roar.wav"}),true,"a low-importance model label cannot bury a real vocal warning");
  const charge=event("charge",{type:"boss_charge",category:"other",phase:"sustain",distance:distance("far"),importance:"key"});
  assert.ok(mix([charge]).placements[0].gainDb>c.gainDb+7,"a held charge keeps its body above minor detail");
  for(const values of [{actor:"ui",type:"ui_warning",category:"other"},{type:"music_cue",category:"music"},{type:"wind",category:"ambience"}]) {
    const n=event("exempt",{...values,distance:distance("near")}),f=event("exempt",{...values,distance:distance("far")});
    assert.equal(mix([n]).placements[0].gainDb,mix([f]).placements[0].gainDb,"UI and nonspatial beds cannot inherit monster attenuation");
  }
  const baseline=mix([event("neutral")]).placements[0].gainDb;
  for(const d of [distance("unknown"),distance("far",.3),distance("far",.9,"")])
    assert.equal(mix([event("neutral",{distance:d})]).placements[0].gainDb,baseline,"uncertain distances remain neutral instead of guessing");
  const input={duration:4,events:[far],assets:[source],placements:[clip(far)]};
  const once=planAutoMix(input,{preserveSourceEdits:true});
  assert.deepEqual(planAutoMix({...input,placements:once.placements},{preserveSourceEdits:true}).placements,once.placements,"repeat mixing must not accumulate distance loss");
  assert.deepEqual(planAutoMix({...input,placements:once.placements},{preserveSourceEdits:true,preserveLevels:true}).placements,once.placements,"saved previews retain distance gain and source edits");
  for(const locked of [{...input,placements:[{...input.placements[0],locked:true}]},{...input,events:[{...far,locked:true}]}])
    assert.equal(planAutoMix(locked,{preserveSourceEdits:true}).placements[0].gainDb,-4,"locks protect manual levels");
  const n=mix([near]).report as any,f=mix([far]).report as any;
  assert.ok(f.targetLufs<=n.targetLufs-7,"mastering must reserve distance headroom instead of normalizing all-far sound back to near loudness");
}

export async function testDistanceAnalysisAndPersistence() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"sfx-distance-"));
  const hit=event("hit",{distance:distance("far"),importance:"key"});
  const raw={...hit,distance:distance("far")};
  const prompts:string[]=[];
  try {
    const result=await analyzeTemporal("fixture",2,path.join(root,"analysis"),{
      inspect:async()=>({duration:2,hasAudio:false}),scenes:async()=>[],thumbnail:async()=>undefined,
      sampleFrames:async(_v,start,end)=>[{start,end,thumbnail:"fixture.jpg"}]
    },{model:"gemini-4-argon",analyzeFrames:async(_frames,prompt)=>{
      prompts.push(prompt);
      if(prompt.includes("逐帧复核"))return {visible:true,start:1,end:1.2,confidence:.95,evidence:"石块在前景玩家身旁首次碰撞",distance:distance("near",.95,"落点位于前景玩家身旁"),importance:"key"};
      return prompt.includes("先理解完整视频")?{context:"远处Boss向近处玩家投石",events:[]}:prompt.includes("只分析窗口")?{events:[raw]}:{events:[]};
    }},{musicEnabled:false,style:'修仙',soundRequirements:'突出落地，环境轻一点',videoDescription:'远处投石'});
    const refined=result.events.find(e=>e.type==="ground_slam") as any;
    assert.equal(refined.distance?.range,"near","contact review must replace source distance with actual impact position");
    assert.equal(refined.importance,"key");
    assert.ok(prompts.every(p=>p.includes("distance")&&p.includes("importance")),"each visual stage needs spatial and salience evidence in its response contract");
    assert.ok(prompts.every(p=>p.includes('修仙')&&p.includes('突出落地，环境轻一点')),'all video review stages must share the production brief');
    const merged=mergeWindowEvents([[hit],[event("copy",{confidence:.99})]])[0] as any;
    assert.equal(merged.distance?.range,"far","a timing-only correction must not drop existing distance evidence");
    const store=new SfxRunStore(path.join(root,"runs")),run=await store.createRun({videoPath:"v.mp4",libraryPath:root});
    const mixed=mix([hit]);
    Object.assign(run,{duration:4,status:"ready",events:[hit],assets:[{...source,path:path.join(root,"stone.wav")}],placements:mixed.placements,mixReport:mixed.report});
    await store.save(run);
    const saved=await store.readRun(run.id);
    assert.equal((saved.events[0] as any).distance.range,"far");
    assert.ok((saved.placements[0] as any).perspective.distanceGainDb<0,"applied attenuation must survive save/reload and preview edits");
    assert.ok((saved.mixReport as any).perspective.attenuatedClips>0,"schema must retain spatial mix evidence");
    await exportTimeline(saved,store.directory(saved.id));
    const json=JSON.parse(await fs.readFile(path.join(store.directory(saved.id),"placements.json"),"utf8"));
    assert.equal(json.events[0].distance.range,"far","editable export must explain each sound's distance and priority");
    const report=buildWorkflowReport(saved);
    assert.equal(report.quality.checks.find(c=>c.id==="mix-distance")?.status,"pass");
    const missing=buildWorkflowReport({...saved,events:[event("hit")],mixReport:undefined});
    assert.equal(missing.quality.checks.find(c=>c.id==="mix-distance")?.status,"review","missing evidence must never be reported as a verified distance mix");
  }finally {await fs.rm(root,{recursive:true,force:true});}
}

export async function testDistanceEditPersistence() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"sfx-distance-edit-"));
  try {
    const {SfxService}=await import("../src/sfx/SfxService.js");
    const service=new SfxService(root),run=await service.store.createRun({videoPath:"v.mp4",libraryPath:root});
    const far=event("hit",{distance:distance("far"),importance:"key"}),mixed=mix([far]);
    Object.assign(run,{duration:4,status:"ready",events:[far],assets:[source],placements:mixed.placements,mixReport:mixed.report});
    await service.store.save(run);
    const draft=structuredClone(run.placements);draft[0].gainDb-=1;
    const changed=await service.update(run.id,{revision:0,events:run.events,placements:draft,originalGainDb:-60});
    assert.deepEqual(changed.placements[0].perspective,draft[0].perspective,"editing gain cannot silently discard applied distance");
    const changedAgain=structuredClone(changed.placements);delete changedAgain[0].perspective;
    const retained=await service.update(run.id,{revision:1,events:changed.events,placements:changedAgain,originalGainDb:-60});
    assert.deepEqual(retained.placements[0].perspective,draft[0].perspective,"a client that omits spatial metadata must retain the saved distance instead of mastering back to near loudness");
  }finally {await fs.rm(root,{recursive:true,force:true});}
}

export async function testDistanceRenderedHeadroom() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"sfx-distance-render-"));
  try {
    const video=path.join(root,"video.mp4"),audio=path.join(root,"tone.wav");
    await runFfmpeg(["-v","error","-y","-f","lavfi","-i","color=c=blue:s=160x90:d=5","-c:v","libx264",video]);
    await runFfmpeg(["-v","error","-y","-f","lavfi","-i","sine=frequency=900:duration=2","-c:a","pcm_s24le",audio]);
    const store=new SfxRunStore(path.join(root,"runs"));
    const render=async(range:"near"|"far",sequence=false)=>{
      const run=await store.createRun({videoPath:video,libraryPath:root});
      const events=sequence?[
        event("close",{start:.3,end:1.1,distance:distance("near"),importance:"key"}),
        event("distant",{start:1.9,end:2.7,distance:distance("far"),importance:"key"}),
        event("detail",{start:3.5,end:4.3,type:"boss_footstep",distance:distance("far"),importance:"detail"})
      ]:[event("roar",{start:.3,end:1.1,type:"boss_roar",category:"other",distance:distance(range),importance:"key"})];
      Object.assign(run,{duration:5,status:"ready",events,assets:[{...source,path:audio,rmsDb:-21.07,peakDb:-18.06}],
        placements:events.map(e=>({...clip(e),start:e.start,sourceEdit:{assetId:"a",sourceOffset:0,duration:.8,basis:"manual",reason:"test source interval"}}))});
      run.render=await new SfxRenderer().renderPreview(run,store.directory(run.id));
      assert.equal(run.mixReport?.mastering,"linear-distance-headroom");
      return run;
    };
    const near=await render("near"),far=await render("far"),sequence=await render("near",true);
    assert.ok(far.mixReport!.measuredLufs!<near.mixReport!.measuredLufs!-6,"rendered all-far preview must remain quieter after the actual master bus");
    const sliceRms=async(start:number)=>{
      const result=await runFfmpeg(["-hide_banner","-ss",String(start),"-t","0.5","-i",sequence.render!.audio,"-af","volumedetect","-f","null","-"]);
      const match=result.stderr.match(/mean_volume:\s*(-?[\d.]+) dB/);
      assert.ok(match,"rendered samples need measured energy");return Number(match[1]);
    };
    const close=await sliceRms(.4),distant=await sliceRms(2),detail=await sliceRms(3.6);
    assert.ok(close>distant+6,"master bus must retain near/far hierarchy inside one video");
    assert.ok(distant>detail+8,"master bus must retain key/detail hierarchy");
    const previous=structuredClone(far.placements);
    await new SfxRenderer().renderPreview(far,store.directory(far.id),{preserveSavedMix:true});
    assert.deepEqual(far.placements,previous,"preview refresh cannot reapply distance gain");
  }finally {await fs.rm(root,{recursive:true,force:true});}
}
