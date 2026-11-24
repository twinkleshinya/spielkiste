import assert from "node:assert/strict";
import {promises as fs} from "node:fs";
import os from "node:os";
import path from "node:path";
import {SfxRunStore,exportTimeline} from "../src/sfx/SfxRunStore.js";
import {CreateRunSchema,EventSchema,PlacementSchema} from "../src/sfx/models.js";
import {readConfig} from "../src/sfx/CcSwitchVisionProvider.js";
import {SfxService} from "../src/sfx/SfxService.js";
import {placementsForOutputMode,eventsForOutputMode} from "../src/sfx/SfxRenderer.js";
import {buildWorkflowReport} from "../src/sfx/WorkflowReport.js";
import http from "node:http";
import {handleSfxRequest} from "../src/ui/sfx-routes.js";
import {testAiConfigDiscoveryAndPrecedence,testAiConfigValidationAndSafePersistence,testAiConfigConnectionTest,testAiConfigDisabledSnapshot,testAiConfigFailedTestBlocksGenerationReadiness} from "./sfx-ai-config.test.js";
import {testAiConfigApi} from "./sfx-ai-config-api.test.js";
import {testAiConfigUi,testAiConfigDialogSavesTestsAndReopens,testAiConfigModelSwitchPersistsAndReopens} from "./sfx-ai-config-ui.test.js";
import * as onboarding from "./sfx-onboarding.test.js";
import {testOnboardingFfmpegUsesCurrentUserInstallation} from "./sfx-onboarding-media.test.js";


export async function testAudioOutputModes() {
  const base={videoPath:"video.mp4",libraryPath:"library"};
  const all=CreateRunSchema.parse(base) as any;
  assert.equal(all.audioOutputMode,"all");assert.equal(all.musicEnabled,true);
  const sfx=CreateRunSchema.parse({...base,audioOutputMode:"sfx"}) as any;
  assert.equal(sfx.audioOutputMode,"sfx");assert.equal(sfx.musicEnabled,false,"仅音效模式必须关闭音乐分析和生成");
  const music=CreateRunSchema.parse({...base,audioOutputMode:"music"}) as any;
  assert.equal(music.audioOutputMode,"music");assert.equal(music.musicEnabled,true);
  const run:any={musicEnabled:true,audioOutputMode:"all"};
  const placements=[{id:"s",category:"foley",enabled:true},{id:"m",category:"music",enabled:true},{id:"off",category:"impact",enabled:false}];
  assert.deepEqual(placementsForOutputMode({...run,audioOutputMode:"all"},placements).map((p:any)=>p.id),["s","m"]);
  assert.deepEqual(placementsForOutputMode({...run,audioOutputMode:"sfx"},placements).map((p:any)=>p.id),["s"]);
  assert.deepEqual(placementsForOutputMode({...run,audioOutputMode:"music"},placements).map((p:any)=>p.id),["m"]);
  const events=[{id:"s",category:"foley"},{id:"m",category:"music"},{id:"a",category:"ambience"}];
  assert.deepEqual(eventsForOutputMode({audioOutputMode:"sfx"},events).map((e:any)=>e.id),["s","a"]);
  assert.deepEqual(eventsForOutputMode({audioOutputMode:"music"},events).map((e:any)=>e.id),["m"]);
}

export async function testAiConfigCore() {
  await testAiConfigDiscoveryAndPrecedence();
  await testAiConfigValidationAndSafePersistence();
  await testAiConfigConnectionTest();
  await testAiConfigDisabledSnapshot();
  await testAiConfigFailedTestBlocksGenerationReadiness();
  await testAiConfigApi();
  await testAiConfigUi();
  await testAiConfigDialogSavesTestsAndReopens();
  await testAiConfigModelSwitchPersistsAndReopens();
  for (const test of Object.values(onboarding)) await test();
  await testOnboardingFfmpegUsesCurrentUserInstallation();
}

export async function testWorkflowApiResources() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"sfx-workflow-api-")),service=new SfxService(root);
  const server=http.createServer((req,res)=>{void handleSfxRequest(req,res,new URL(req.url!,"http://localhost"),service);});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  try {
    const response=await fetch(base+"/api/sfx/workflow");
    assert.equal(response.status,200,"workbench needs the same executable profile and published skill set");
    const data=await response.json() as {profile:{id:string;version:string;mix:{addedReverb:boolean}};skills:unknown[]};
    assert.equal(data.profile.id,"reference-v6");assert.equal(data.profile.version,"1.0.7");assert.equal(data.profile.mix.addedReverb,false);assert.equal(data.skills.length,4);
    const run=await service.store.createRun({videoPath:"v.mp4",libraryPath:root});run.status="failed";run.error="文件扫描超过 10 分钟，已取消扫描";await service.store.save(run);
    const before=await fs.readFile(path.join(service.store.directory(run.id),"run.json"),"utf8");
    const report=await fetch(base+`/api/sfx/runs/${run.id}/export/workflow`);
    assert.equal(report.status,200);
    const failedReport=await report.json() as ReturnType<typeof buildWorkflowReport>;
    assert.equal(failedReport.quality.status,"failed");
    assert.equal(failedReport.error,run.error);
    assert.equal(failedReport.quality.checks[0].id,"execution");
    assert.match(failedReport.quality.checks[0].detail,/文件扫描超过/);
    assert.equal(await fs.readFile(path.join(service.store.directory(run.id),"run.json"),"utf8"),before,"inspecting reports must not rewrite history");
    const zip=await fetch(base+"/api/sfx/workflow/bundle");assert.equal(zip.status,200);
    assert.equal(Buffer.from(await zip.arrayBuffer()).readUInt32LE(0),0x04034b50);
    const skill=await fetch(base+"/api/sfx/workflow/skill/video-sfx-selection");assert.equal(skill.status,200);assert.match(await skill.text(),/name: video-sfx-selection/);
    assert.equal((await fetch(base+"/api/sfx/workflow/skill/.env")).status,404);
  }finally {await new Promise<void>(resolve=>server.close(()=>resolve()));await fs.rm(root,{recursive:true,force:true});}
}

export async function testWorkflowForkProvenance() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"sfx-workflow-fork-"));
  try {
    const service=new SfxService(root);
    const run=await service.store.createRun({videoPath:"v.mp4",libraryPath:root,workflowPreset:"custom",musicEnabled:false,aiSelection:false,originalGainDb:-8});
    run.duration=2;run.status="ready";
    run.analysisMode="ccswitch";run.analysisReport={workflow:"temporal",model:"gemini-4-argon",windows:1,refinedContacts:0,timingNote:"fixture"};run.warnings=["部分短窗复查失败，保留现有清单待复核"];
    run.assets=[{id:"a",path:path.join(root,"move.wav"),fileName:"move.wav",relativePath:"move.wav",duration:1,size:1,mtimeMs:1,tags:[],usable:true,rmsDb:-24,onset:0}];
    run.events=[EventSchema.parse({id:"e",start:.2,end:.8,type:"movement",description:"动作",query:"move",category:"foley",confidence:.9,source:"manual",candidates:[],requiresHumanReview:true})];
    run.placements=[PlacementSchema.parse({id:"p",eventId:"e",assetId:"a",start:.2,duration:.6,sourceOffset:0,gainDb:-6,fadeIn:.005,fadeOut:.08,category:"foley",enabled:true})];
    await service.store.save(run);
    const {runId}=await service.automix(run.id,{revision:0,autoRender:false});
    const next=await service.waitForIdle(runId);
    assert.equal(next.musicEnabled,false,"a remix cannot reset custom options to standard defaults");
    assert.equal(next.aiSelection,false);
    assert.equal(next.originalMuted,false);
    assert.equal(next.originalGainDb,-8);
    assert.equal(next.workflow?.operation,"automix");
    assert.equal(next.workflow?.timing,"reused");
    assert.equal(next.workflow?.selection,"reused");
    assert.equal(buildWorkflowReport(next).stages.find(s=>s.id==="timing")?.status,"partial","inherited incomplete timing must retain its review status");
    const standard=await service.store.createRun({videoPath:"v.mp4",libraryPath:root});
    Object.assign(standard,{duration:run.duration,status:"ready",assets:run.assets,events:run.events,placements:run.placements});
    await service.store.save(standard);
    const edited=await service.update(standard.id,{revision:0,events:standard.events,placements:standard.placements,originalGainDb:-10});
    assert.equal(edited.originalMuted,false,"changing original gain must take effect even if the standard initially muted it");
    const empty=await service.store.createRun({videoPath:"v.mp4",libraryPath:root});
    assert.notEqual(buildWorkflowReport(empty).quality.status,"checks-passed");
  }finally {await fs.rm(root,{recursive:true,force:true});}
}

export async function testStandardWorkflowDefaults() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"sfx-workflow-"));
  try {
    const store=new SfxRunStore(root);
    const standard=await store.createRun({videoPath:"video.mp4",libraryPath:"library"});
    assert.equal(standard.originalGainDb,-60,"new standard generation must not stack existing video sound over library audio");
    const data=standard as typeof standard & {workflow?:{presetId:string;version:string;requestedModel:string}};
    assert.equal(data.workflow?.presetId,"reference-v6","standard runs need a reproducible workflow identity");
    assert.equal(data.workflow?.requestedModel,"gemini-4-argon");
    assert.equal(data.workflow?.version,"1.0.7");
    assert.equal(standard.selectionScope,"selective");
    assert.equal(standard.aiSelection,true);
    assert.equal(standard.autoMix,true);
    assert.equal(standard.originalMuted,true,"standard output uses digital silence for the source track");
    assert.equal((await store.readRun(standard.id)).originalGainDb,-60);
    const custom=await store.createRun({videoPath:"video.mp4",libraryPath:"library",analysisMode:"scene"});
    assert.equal(custom.originalGainDb,0,"explicit manual workflows retain existing original-audio behavior");
    const conflicting=CreateRunSchema.parse({videoPath:"v.mp4",libraryPath:"l",workflowPreset:"reference-v6",analysisMode:"scene",aiSelection:false,autoMix:false,musicEnabled:false,autoRender:false,originalGainDb:0,selectionScope:"full"});
    assert.deepEqual([conflicting.analysisMode,conflicting.aiSelection,conflicting.autoMix,conflicting.musicEnabled,conflicting.autoRender,conflicting.originalGainDb,conflicting.selectionScope],["auto",true,true,true,true,-60,"selective"],"a named fixed profile must not silently execute different settings");
    const config=path.join(root,"gateway.toml");await fs.writeFile(config,'[model_providers.custom]\nbase_url = "http://127.0.0.1:1/v1"\n');
    const oldModel=process.env.SFX_CCSWITCH_MODEL;
    try {
      process.env.SFX_CCSWITCH_MODEL="gemini-custom";
      assert.equal((await readConfig(config,"gemini-4-argon")).model,"gemini-4-argon");
      assert.equal(process.env.SFX_CCSWITCH_MODEL,"gemini-custom","profile must not modify other requests' configuration");
    }finally {if(oldModel===undefined)delete process.env.SFX_CCSWITCH_MODEL;else process.env.SFX_CCSWITCH_MODEL=oldModel;}
  } finally {await fs.rm(root,{recursive:true,force:true});}
}

export async function testWorkflowExportEvidence() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"sfx-workflow-report-"));
  try {
    const store=new SfxRunStore(path.join(root,"runs"));
    const run=await store.createRun({videoPath:"v.mp4",libraryPath:root});
    run.duration=2;run.status="ready";
    const asset={id:"a",path:path.join(root,"sfx.wav"),fileName:"sfx.wav",relativePath:"sfx.wav",duration:1,size:1,mtimeMs:1,tags:[],usable:true};
    run.assets=[asset];
    run.events=[EventSchema.parse({id:"e",start:.2,end:.8,type:"roar",description:"张嘴咆哮",query:"roar",category:"other",confidence:.9,source:"vision",candidates:[{assetId:"a",score:1,reason:"name"}],requiresHumanReview:true})];
    run.placements=[PlacementSchema.parse({id:"p",eventId:"e",assetId:"a",start:.2,duration:.6,sourceOffset:0,gainDb:-6,fadeIn:.005,fadeOut:.08,category:"other",enabled:true})];
    const dir=store.directory(run.id);await exportTimeline(run,dir);
    const exists=await fs.stat(path.join(dir,"workflow-report.json")).then(()=>true,()=>false);
    assert.equal(exists,true,"each generation must export its actual workflow/configuration and quality evidence");
    const report=JSON.parse(await fs.readFile(path.join(dir,"workflow-report.json"),"utf8"));
    assert.equal(report.quality.status,"needs-review","a label cannot certify missing timing/audio/mix model evidence");
    assert.equal(report.quality.checks.find((c:{id:string})=>c.id==="sources").status,"pass");
    assert.notEqual(report.stages.find((s:{id:string})=>s.id==="timing").status,"complete");
    run.assets[0].path=path.join(root,"..","external.wav");run.placements[0].fadeOut=0;
    await exportTimeline(run,dir);
    const invalid=JSON.parse(await fs.readFile(path.join(dir,"workflow-report.json"),"utf8"));
    assert.equal(invalid.quality.status,"failed");
    assert.equal(invalid.quality.checks.find((c:{id:string})=>c.id==="sources").status,"fail");
    assert.equal(invalid.quality.checks.find((c:{id:string})=>c.id==="fades").status,"fail");
    run.assets[0].path=asset.path;run.musicLibraryPath=path.dirname(run.assets[0].path);
    await exportTimeline(run,dir);
    const separate=JSON.parse(await fs.readFile(path.join(dir,"workflow-report.json"),"utf8"));
    assert.equal(separate.quality.checks.find((c:{id:string})=>c.id==="sources").status,"pass","explicit music library paths count as supplied sources");
    run.analysisMode="ccswitch";run.analysisReport={workflow:"temporal",model:"gemini-4-argon",windows:1,refinedContacts:0,timingNote:"fixture"};
    run.warnings=["部分短窗复查失败，保留现有清单待复核"];
    const partial=buildWorkflowReport(run);
    assert.equal(partial.stages.find(s=>s.id==="timing")?.status,"partial","a failed timing audit cannot be labelled fully complete");
    assert.equal(partial.quality.checks.find(c=>c.id==="timing")?.status,"review");
  }finally {await fs.rm(root,{recursive:true,force:true});}
}
