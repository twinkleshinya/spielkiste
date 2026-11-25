import assert from "node:assert/strict";
import {promises as fs} from "node:fs";
import os from "node:os";
import path from "node:path";
import {AudioLibraryIndexer} from "../src/sfx/AudioLibraryIndexer.js";
import {planEventCandidates,repairEventCandidates} from "../src/sfx/CandidatePlanner.js";
import {prepareDiverseCandidates} from "../src/sfx/CandidatePreparation.js";
import {prepareCandidates} from "../src/sfx/PrepareCandidates.js";
import {GeminiAudioSelector} from "../src/sfx/GeminiAudioSelector.js";
import {CreateRunSchema,EventSchema,type AudioAsset,type AudioLibraryIndex} from "../src/sfx/models.js";
import {SfxService} from "../src/sfx/SfxService.js";
import {exportTimeline} from "../src/sfx/SfxRunStore.js";
import {PreservedSounds} from "../src/sfx/PreservedSounds.js";
import {createPlacements} from "../src/sfx/PlacementEngine.js";
import {handleSfxRequest} from "../src/ui/sfx-routes.js";
import http from "node:http";

const asset=(id:string,file:string):AudioAsset=>({id,path:file,relativePath:file,fileName:file.split(/[\\/]/).at(-1)!,size:1,mtimeMs:1,tags:[],usable:true,duration:2,rmsDb:-20,peakDb:-8,onset:0,
  acoustics:{version:1,fingerprint:id,sampledStart:0,sampledDuration:1,energyEnd:1,activeDuration:1,centroid:1000,bands:[1],envelope:[1],label:"roar"}});
const event=()=>EventSchema.parse({id:"e",start:0,end:1,type:"roar",description:"Boss吼叫",query:"roar",category:"foley",source:"vision",confidence:.9,candidates:[],requiresHumanReview:false,actor:"boss"});
const library=():AudioLibraryIndex=>({version:1,root:"E:/Library",generatedAt:"now",warnings:[],assets:[asset("folder","E:/Library/blocked/deep/roar.wav"),asset("word","E:/Library/normal/roar_START.wav"),asset("safe","E:/Library/blocked2/roar.wav")],
  libraryPreferences:[{path:"E:/Library/blocked",weight:10}],keywordPreferences:[{keyword:"start",weight:10,scope:"all"}],excludedLibraryPaths:["e:\\LIBRARY\\blocked\\"],excludedKeywords:["start"]} as AudioLibraryIndex);
const staleEvent=()=>{const ev=event();ev.candidates=library().assets.map(a=>({assetId:a.id,score:10,reason:"stale"}));ev.layers=[{id:"voice",role:"foley",query:"roar",offset:0,candidates:[...ev.candidates]}];return ev;};

export function testLibraryExclusionsSearchAndPlanner() {
  const lib=library(),indexer=new AudioLibraryIndexer();
  assert.deepEqual(indexer.search(lib,"roar",20).map(r=>r.asset.id),["safe"],"directory and keywords must override all priority weights");
  const ev=event();planEventCandidates(ev,lib);assert.deepEqual(ev.candidates.map(c=>c.assetId),["safe"]);
  const stale=staleEvent();repairEventCandidates(stale,lib);assert.deepEqual(stale.candidates.map(c=>c.assetId),["safe"],"saved candidate lists cannot bypass exclusions");
  const all={...lib,excludedKeywords:["ROAR"]};assert.equal(indexer.search(all,"roar",20).length,0,"all forbidden means empty, never unfiltered fallback");
  assert.deepEqual(createPlacements([staleEvent()],lib.assets,3,lib).map(p=>p.assetId),["safe"],"placement creation revalidates stale picks");
  const unc={...lib,assets:[asset("no","\\\\SyNaS\\音效\\禁止\\roar.wav"),asset("yes","\\\\synas\\音效\\禁止2\\roar.wav")],excludedLibraryPaths:["//synas/音效/禁止"],excludedKeywords:[]};
  assert.deepEqual(indexer.search(unc,"roar",20).map(r=>r.asset.id),["yes"],"UNC boundaries and case must be respected");
  const literal={...lib,assets:[asset("literal","E:/Library/roar_[old].wav"),asset("safe","E:/Library/roar_old.wav")],excludedLibraryPaths:[],excludedKeywords:["[ＯＬＤ]"]};
  assert.deepEqual(indexer.search(literal,"roar",20).map(r=>r.asset.id),["safe"],"keywords are NFKC literal substrings, not regex or synonyms");
  const staleEmpty = event();
  staleEmpty.type = "boss_move";
  staleEmpty.description = "巨兽低伏游走并迈步";
  staleEmpty.query = "heavy monster prowl step";
  staleEmpty.actor = "boss";
  staleEmpty.phase = "motion";
  staleEmpty.category = "foley";
  staleEmpty.layers = [{ id: "old-layer-id", role: "foley", query: staleEmpty.query, offset: 0, candidates: [] }];
  staleEmpty.candidates = [];
  repairEventCandidates(staleEmpty, { ...lib, assets: [asset("movement", "efx_apesstonehand_bodyturn_movement_01.wav")] });
  assert.equal(staleEmpty.layers[0].candidates[0]?.assetId, "movement", "empty persisted layers must be replenished even when replanning creates a new layer id");
}

export async function testExclusionsCandidateAndGeminiBoundaries() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"sfx-exclusion-model-"));
  try {
    const lib=library(),ev=staleEvent();await prepareCandidates([ev],lib);
    assert.deepEqual(ev.candidates.map(c=>c.assetId),["safe"]);
    const diverse=staleEvent();await prepareDiverseCandidates([diverse],lib,root);assert.deepEqual(diverse.candidates.map(c=>c.assetId),["safe"]);
    for(const fail of [false,true]) {
      const modelEvent=staleEvent();const sampled:string[]=[];const sent:string[]=[];
      const selector=new GeminiAudioSelector({model:"test",describe:async samples=>({assets:samples.map(s=>({assetId:s.assetId,summary:"低沉吼叫",tags:["roar"],energy:.8,hasMusic:false,hasSpeech:false}))}),choose:async tasks=>{
        sent.push(...tasks.flatMap(t=>t.candidates.map(c=>c.assetId)));if(fail)throw new Error("gateway unavailable");
        return {choices:tasks.map(t=>({taskId:t.taskId,assetId:"folder",reason:"stale model id",confidence:.9}))};}},
      {sample:async a=>{sampled.push(a.id);return {assetId:a.id,data:"test",format:"wav",segments:[{start:0,end:1}]};}});
      await selector.select([modelEvent],lib,{outputDir:root,cacheDir:path.join(root,`cache-${fail}`),previousPlacements:[{id:"p",eventId:"e",layerId:"voice",assetId:"folder",start:0,duration:1,sourceOffset:0,gainDb:-8,fadeIn:.01,fadeOut:.05,category:"foley",enabled:true}]});
      assert.deepEqual(sampled,["safe"],"forbidden audio must never be sent to the model");assert.deepEqual(sent,["safe"]);
      assert.deepEqual(modelEvent.candidates.map(c=>c.assetId),["safe"],"invalid model choices and outages must retain only allowed fallback");
    }
  }finally {await fs.rm(root,{recursive:true,force:true});}
}

export async function testExclusionsPersistenceAndManualSelection() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"sfx-exclusion-project-"));
  try {
    const video=path.join(root,"v.mp4");await fs.writeFile(video,"video fixture");
    const rules={excludedLibraryPaths:["E:\\Library\\blocked"],excludedKeywords:["start"]};
    assert.deepEqual((CreateRunSchema.parse({videoPath:video,libraryPath:root,...rules}) as any).excludedKeywords,["start"]);
    for(const invalid of [{excludedLibraryPaths:[" "]},{excludedKeywords:[""]},{excludedKeywords:Array(51).fill("x")}])assert.equal(CreateRunSchema.safeParse({videoPath:video,libraryPath:root,...invalid}).success,false);
    const service=new SfxService(path.join(root,"output")),run=await service.store.createRun({videoPath:video,libraryPath:root,...rules} as any);
    run.duration=3;run.status="ready";run.assets=library().assets;run.events=[staleEvent()];
    run.placements=[{id:"existing",eventId:"e",layerId:"voice",assetId:"folder",start:0,duration:1,sourceOffset:0,gainDb:-8,fadeIn:.01,fadeOut:.05,category:"foley",enabled:true}];await service.store.save(run);
    const original=await fs.readFile(path.join(service.store.directory(run.id),"run.json"),"utf8");
    assert.deepEqual((await service.search(run.id,"roar")).map(r=>r.assetId),["safe"]);
    assert.ok((await (service.search as Function).call(service,run.id,"roar","foley",{excludedLibraryPaths:[],excludedKeywords:[]})).some((r:any)=>r.assetId==="folder"),"unsaved removal of exclusions must take effect; similar alternatives may be merged");
    assert.equal(await fs.readFile(path.join(service.store.directory(run.id),"run.json"),"utf8"),original);
    const changedRules={excludedLibraryPaths:["E:\\Library\\blocked"],excludedKeywords:["start","chirp"]};
    const child=await service.update(run.id,{revision:0,events:run.events,placements:run.placements,originalGainDb:run.originalGainDb,...changedRules},{fork:true});
    assert.notEqual(child.id,run.id);assert.deepEqual(child.placements,run.placements,"adding exclusions must preserve current sounds");
    assert.deepEqual((await service.readRun(child.id) as any).excludedKeywords,["chirp","start"]);
    assert.deepEqual(child.workflow!.options.excludedKeywords,["chirp","start"]);
    const blockedSwap={...run.placements[0],assetId:"word"};
    await assert.rejects(service.update(child.id,{revision:child.revision,events:child.events,placements:[blockedSwap],originalGainDb:child.originalGainDb},{fork:true}),/排除|禁用/);
    const copied=await service.saveProjectAs(child.projectId!,"copy");assert.deepEqual((await service.readRun(copied.runId) as any).excludedKeywords,["chirp","start"]);
    const olderClient=await service.update(child.id,{revision:child.revision,events:child.events.map(e=>({...e,description:"edited"})),placements:child.placements,originalGainDb:child.originalGainDb},{fork:true});
    assert.deepEqual(olderClient.excludedKeywords,["chirp","start"],"older clients must retain the exclusion policy");
    const restored=await service.restoreProjectVersion(child.projectId!,child.id);assert.deepEqual((await service.readRun(restored.runId)).excludedKeywords,["chirp","start"]);
    await exportTimeline(child,service.store.directory(child.id));assert.deepEqual(JSON.parse(await fs.readFile(path.join(service.store.directory(child.id),"placements.json"),"utf8")).excludedKeywords,["chirp","start"]);
    const preserved=new PreservedSounds(path.join(root,"preserved")),base={videoPath:video,libraryPath:root};
    const plain=await (preserved as any).identity(base),empty=await (preserved as any).identity({...base,excludedLibraryPaths:[],excludedKeywords:[]}),filtered=await (preserved as any).identity({...base,...rules});
    assert.equal(plain.file,empty.file);assert.notEqual(plain.file,filtered.file,"preserved runs with different exclusions cannot be reused");
    assert.equal((await (preserved as any).identity({...base,excludedLibraryPaths:["e:/LIBRARY/blocked/"],excludedKeywords:["START","start"]})).file,filtered.file);
  }finally {await fs.rm(root,{recursive:true,force:true});}
}

export async function testExclusionsHttpRoutes() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"sfx-exclusion-http-")),service=new SfxService(path.join(root,"output"));
  const server=http.createServer((req,res)=>{void handleSfxRequest(req,res,new URL(req.url!,"http://localhost"),service);});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  try {
    const run=await service.store.createRun({videoPath:path.join(root,"v.mp4"),libraryPath:root,analysisMode:"scene"});run.status="ready";run.duration=3;run.events=[event()];run.assets=library().assets;await service.store.save(run);
    const before=await fs.readFile(path.join(service.store.directory(run.id),"run.json"),"utf8");
    const post=(body:unknown)=>fetch(`${base}/api/sfx/runs/${run.id}/search`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
    const response=await post({query:"roar",eventId:"e",excludedLibraryPaths:["E:/Library/blocked"],excludedKeywords:["START"]});
    assert.equal(response.status,200);assert.deepEqual((await response.json() as any[]).map(r=>r.assetId),["safe"],"HTTP must retain unsaved exclusions");
    assert.equal((await post({query:"roar",excludedKeywords:[""]})).status,400);
    const module=await fetch(`${base}/sfx-asset-exclusions.js`);assert.equal(module.status,200);assert.match(module.headers.get("content-type")||"",/javascript/);assert.match(await module.text(),/assetExclusionReasonResolver/);
    assert.equal(await fs.readFile(path.join(service.store.directory(run.id),"run.json"),"utf8"),before);
  }finally {await new Promise<void>(resolve=>server.close(()=>resolve()));await fs.rm(root,{recursive:true,force:true});}
}
