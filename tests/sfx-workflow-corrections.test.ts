import assert from "node:assert/strict";
import {promises as fs} from "node:fs";
import path from "node:path";
import os from "node:os";
import {SfxService} from "../src/sfx/SfxService.js";
import {EventSchema,PlacementSchema} from "../src/sfx/models.js";
import {GeminiAudioSelector,type SelectionTask} from "../src/sfx/GeminiAudioSelector.js";
import {buildWorkflowReport} from "../src/sfx/WorkflowReport.js";
import {planAutoMix} from "../src/sfx/AutoMix.js";

async function preservedFixture(root:string) {
  const library=path.join(root,"library"),video=path.join(root,"video.mp4");
  await fs.mkdir(library);await fs.writeFile(video,"fixture video");
  const service=new SfxService(path.join(root,"output"));
  const run=await service.store.createRun({videoPath:video,libraryPath:library});
  Object.assign(run,{status:"ready",duration:4,assets:[{id:"a",path:path.join(library,"charge.wav"),fileName:"charge.wav",relativePath:"charge.wav",duration:3,size:1,mtimeMs:1,tags:[],usable:true}],
    events:[EventSchema.parse({id:"e",start:1,end:2,type:"player_charge",phase:"sustain",actor:"player",query:"continuous charge",description:"持续蓄力",category:"other",source:"vision",confidence:.9,candidates:[],requiresHumanReview:false})],
    placements:[PlacementSchema.parse({id:"p",eventId:"e",assetId:"a",start:1,duration:1,sourceOffset:.3,gainDb:-4,fadeIn:.4,fadeOut:.5,category:"other",enabled:true})]});
  const dir=service.store.directory(run.id);
  run.render={video:path.join(dir,"preview.mp4"),audio:path.join(dir,"preview.wav"),revision:0};
  await fs.writeFile(run.render.video,"accepted video");await fs.writeFile(run.render.audio,"accepted audio");await service.store.save(run);
  await service.preserve(run.id,{revision:0});
  return {service,run,dir,edit:{revision:0,events:run.events,placements:run.placements,originalGainDb:run.originalGainDb,originalMuted:run.originalMuted,musicEnabled:run.musicEnabled}};
}

export async function testPreservedEditCreatesChild() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"sfx-edit-child-"));
  try {
    const {service,run,dir,edit}=await preservedFixture(root);
    const before=await fs.readFile(path.join(dir,"run.json"),"utf8");
    const updated=await service.update(run.id,{...edit,placements:edit.placements.map(p=>({...p,gainDb:-8}))});
    assert.notEqual(updated.id,run.id,"editing an accepted version must save a child, not overwrite its original");
    assert.equal(updated.parentRunId,run.id);
    assert.equal(updated.placements[0].gainDb,-8);
    assert.equal(updated.placements[0].fadeOut,.5,"editing a level cannot silently shorten an existing fade");
    assert.equal(updated.render,undefined,"a child cannot claim the parent preview matches its new edits");
    assert.equal(await fs.readFile(path.join(dir,"run.json"),"utf8"),before);
    assert.equal(await fs.readFile(run.render!.video,"utf8"),"accepted video");
    assert.equal((await service.create({videoPath:run.videoPath,libraryPath:run.libraryPath,analysisMode:"scene",workflowPreset:"custom"})).runId,run.id);
    const usage=JSON.parse(await fs.readFile(path.join(service.store.directory(updated.id),"usage-report.json"),"utf8"));
    assert.equal(usage.requests.length,0,"editing retained results must not call the model or inherit old token charges");
    // Protection is by run identity: it must survive an unavailable input video.
    await fs.rename(run.videoPath,run.videoPath+".moved");
    const second=await new SfxService(service.root).update(run.id,{...edit,placements:edit.placements.map(p=>({...p,gainDb:-9}))});
    assert.notEqual(second.id,run.id);
    assert.equal(await fs.readFile(path.join(dir,"run.json"),"utf8"),before);
  } finally {await fs.rm(root,{recursive:true,force:true});}
}

export async function testPreservedNoOpAndReadOnlySearch() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"sfx-edit-noop-"));
  try {
    const {service,run,dir,edit}=await preservedFixture(root);
    const before=await fs.readFile(path.join(dir,"run.json"),"utf8");
    const same=await service.update(run.id,edit);
    assert.equal(same.id,run.id);assert.equal(same.revision,0,"unchanged saves must be no-ops");
    await service.search(run.id,"there is no matching sound");
    assert.equal(await fs.readFile(path.join(dir,"run.json"),"utf8"),before,"search cannot reconcile ranges or rewrite the accepted project");
    assert.equal((await service.create({videoPath:run.videoPath,libraryPath:run.libraryPath,analysisMode:"scene",workflowPreset:"custom"})).runId,run.id);
    await fs.unlink(run.render!.audio);
    await assert.rejects(service.render(run.id),/预览.*缺失/,"a missing preserved preview requires explicit recovery, never in-place regeneration");
    assert.equal(await fs.readFile(path.join(dir,"run.json"),"utf8"),before);
  } finally {await fs.rm(root,{recursive:true,force:true});}
}

export async function testOlderAcceptedVersionStaysProtected() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"sfx-preserved-default-"));
  try {
    const {service,run,dir,edit}=await preservedFixture(root);
    const original=await fs.readFile(path.join(dir,"run.json"),"utf8");
    // A legacy accepted run only has the content-keyed record. A new default cannot discard its protection.
    await fs.unlink(path.join(service.root,"preserved","runs",`${run.id}.json`));
    const next=await service.store.createRun({videoPath:run.videoPath,libraryPath:run.libraryPath});
    const nextDir=service.store.directory(next.id);
    const alternate={...structuredClone(run),id:next.id,createdAt:next.createdAt,render:{video:path.join(nextDir,"preview.mp4"),audio:path.join(nextDir,"preview.wav"),revision:0}};
    await fs.writeFile(alternate.render.video,"new accepted video");await fs.writeFile(alternate.render.audio,"new accepted audio");await service.store.save(alternate);
    await service.preserve(alternate.id,{revision:0});
    assert.equal((await service.create({videoPath:run.videoPath,libraryPath:run.libraryPath,analysisMode:"scene",workflowPreset:"custom"})).runId,alternate.id);
    const edited=await service.update(run.id,{...edit,placements:edit.placements.map(p=>({...p,gainDb:-10}))});
    assert.notEqual(edited.id,run.id,"choosing a new default must not unprotect an older accepted version");
    assert.equal(await fs.readFile(path.join(dir,"run.json"),"utf8"),original);
  }finally {await fs.rm(root,{recursive:true,force:true});}
}

export async function testRetainedFadesSurviveMix() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"sfx-fade-retain-"));
  try {
    const {service,run}=await preservedFixture(root);
    const plan=planAutoMix(run,{preserveSourceEdits:true,preserveLevels:true});
    assert.deepEqual(plan.placements,run.placements,"saved-preview planning must preserve even unusually long but valid fades");
    const {runId}=await service.automix(run.id,{revision:0,autoRender:false});const mixed=await service.waitForIdle(runId);
    assert.equal(mixed.status,"ready",mixed.error);
    assert.equal(mixed.placements[0].fadeIn,.4);assert.equal(mixed.placements[0].fadeOut,.5);
  } finally {await fs.rm(root,{recursive:true,force:true});}
}

export async function testSelectionReceivesSoundIntent() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"sfx-intent-"));
  try {
    const asset=(id:string,fileName:string,duration:number)=>({id,path:path.join(root,fileName),fileName,relativePath:fileName,duration,size:1,mtimeMs:1,tags:[],usable:true});
    const assets=[asset("pulse","firemultishoot_loop_charge.wav",1.277),asset("body","javelin_charge_loop.wav",7.106)];
    const event=EventSchema.parse({id:"e",start:4,end:6,type:"player_charge",phase:"sustain",actor:"player",description:"玩家架刀不动",query:"平滑连续低频充能，不要咔咔脉冲",category:"other",source:"vision",confidence:.9,requiresHumanReview:false,candidates:[],layers:[{id:"body",role:"foley",offset:0,query:"continuous low rumble body",candidates:assets.map(a=>({assetId:a.id,score:1,reason:"name"}))}]});
    let received:SelectionTask[]=[];
    const model={model:"fixture",async describe(){return {assets:assets.map(a=>({assetId:a.id,summary:a.id==="pulse"?"多次脉冲、密集脆裂与摩擦":"连续平滑低频持续声，无明显重复瞬态",tags:[],energy:.5,hasMusic:false,hasSpeech:false}))};},async choose(tasks:SelectionTask[]){received=tasks;return {choices:tasks.map(t=>({taskId:t.taskId,assetId:"pulse",confidence:.8,reason:"文件名有loop"}))};}};
    const clips={async sample(a:{id:string}){return {assetId:a.id,data:"d2F2",format:"wav" as const,segments:[{start:0,end:1}]};}};
    const report=await new GeminiAudioSelector(model,clips).select([event],{version:1,root,generatedAt:"now",assets,warnings:[]},{outputDir:root,cacheDir:path.join(root,"cache")});
    const task=received[0] as SelectionTask & {event:{query?:string};layerQuery?:string};
    assert.equal(task.event.query,event.query,"the sound intent may differ from the visible action and must reach Gemini");
    assert.equal(task.layerQuery,event.layers![0].query,"layer-specific material/body intent cannot be dropped");
    assert.ok((task.candidates.find(c=>c.assetId==="pulse") as {continuityAdvice?:{warnings:string[]}})?.continuityAdvice?.warnings.length,"the model must see the acoustic conflict before selecting");
    assert.ok(report.warnings.some(w=>/持续蓄力/.test(w)&&/脉冲|脆裂/.test(w)),"a contradictory loop choice must be exposed for review");
    assert.equal(event.requiresHumanReview,true);
    const run=await new SfxService(root).store.createRun({videoPath:"v.mp4",libraryPath:root});
    Object.assign(run,{duration:8,assets,events:[event],selectionReport:report,placements:[PlacementSchema.parse({id:"p",eventId:"e",layerId:"body",assetId:"pulse",start:4,duration:2,sourceOffset:0,loop:true,gainDb:-10,fadeIn:.005,fadeOut:.08,category:"other",enabled:true})]});
    const check=buildWorkflowReport(run).quality.checks.find(c=>c.id==="sound-intent");
    assert.equal(check?.status,"review","completion of a model call must not certify acoustic suitability");
    event.query="节奏化反复脉冲蓄力";event.layers![0].query="rhythmic pulses";event.requiresHumanReview=false;
    const pulsed=await new GeminiAudioSelector(model,clips).select([event],{version:1,root,generatedAt:"now",assets,warnings:[]},{outputDir:root,cacheDir:path.join(root,"cache")});
    assert.equal(pulsed.warnings.some(w=>/持续蓄力.*脉冲/.test(w)),false,"intentional pulsed charging is valid; this is not a universal sound ban");
  } finally {await fs.rm(root,{recursive:true,force:true});}
}
