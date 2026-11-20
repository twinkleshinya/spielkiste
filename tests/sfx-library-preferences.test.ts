import assert from "node:assert/strict";
import {promises as fs} from "node:fs";
import os from "node:os";
import path from "node:path";
import {AudioLibraryIndexer} from "../src/sfx/AudioLibraryIndexer.js";
import {CreateRunSchema,EventSchema,type AudioAsset,type AudioLibraryIndex} from "../src/sfx/models.js";
import {SfxRunStore,exportTimeline} from "../src/sfx/SfxRunStore.js";
import {GeminiAudioSelector,type SelectionTask} from "../src/sfx/GeminiAudioSelector.js";
import {PreservedSounds} from "../src/sfx/PreservedSounds.js";
import {planEventCandidates} from "../src/sfx/CandidatePlanner.js";
import {additionalLibraryRoots} from "../src/sfx/LibraryPreferences.js";
import {SfxService} from "../src/sfx/SfxService.js";
import {handleSfxRequest} from "../src/ui/sfx-routes.js";
import http from "node:http";
import {buildWorkflowReport} from "../src/sfx/WorkflowReport.js";

const asset=(id:string,file:string):AudioAsset=>({id,path:file,relativePath:file,fileName:path.win32.basename(file),size:1,mtimeMs:1,tags:[],usable:true,duration:2});
export function testLibraryPathRanking() {
  const index:AudioLibraryIndex & {libraryPreferences:{path:string;weight:number}[]}={version:1,root:"E:\\Library",generatedAt:"now",warnings:[],libraryPreferences:[{path:"e:/library/preferred",weight:5}],assets:[
    asset("general","E:\\Library\\general\\heavy_impact.wav"),asset("preferred","E:\\Library\\preferred\\heavy_impact.wav"),
    asset("unrelated","E:\\Library\\preferred\\bird_chirp.wav"),asset("sibling","E:\\Library\\preferred2\\heavy_impact.wav")
  ]};
  const indexer=new AudioLibraryIndexer();
  const results=indexer.search(index,"heavy impact",20);
  assert.equal(results[0].asset.id,"preferred","equally relevant sounds must prefer the weighted directory");
  assert.match(results[0].reason,/路径优先.*5/);
  assert.ok(!results.find(r=>r.asset.id==="unrelated"),"directory preference cannot make an unrelated recording relevant");
  assert.equal(results.find(r=>r.asset.id==="general")!.score,results.find(r=>r.asset.id==="sibling")!.score,"directory boundaries must not match preferred2");
  const unmatched=indexer.search(index,"heavy impact",20).find(r=>r.asset.id==="general")!;
  const stackedIndex={...index,libraryPreferences:[...index.libraryPreferences,{path:"E:\\Library",weight:2}]};
  const stacked=indexer.search(stackedIndex,"heavy impact",20);
  assert.equal(stacked.find(r=>r.asset.id==="preferred")!.score,results[0].score,"overlapping rules must use max weight, not multiply");
  assert.ok(stacked.find(r=>r.asset.id==="general")!.score>unmatched.score);
  const exact=asset("specific","E:\\Library\\general\\gorilla_roar_heavy_attack.wav");
  const weak=asset("weak","E:\\Library\\preferred\\light_impact.wav");
  assert.equal(indexer.search({...index,assets:[weak,exact]},"gorilla roar heavy attack",10)[0].asset.id,"specific","strong relevance outranks path preference");
  const event=EventSchema.parse({id:"e",start:0,end:1,type:"hit",query:"heavy impact",description:"重击",category:"foley",source:"vision",confidence:.9,candidates:[],requiresHumanReview:false});
  planEventCandidates(event,index);assert.equal(event.candidates[0].assetId,"preferred","weighted picks must reach the actual event shortlist");
  const unc={...index,libraryPreferences:[{path:"\\\\synas\\音频部\\Boss",weight:4}],assets:[asset("a","\\\\synas\\音频部\\Other\\roar.wav"),asset("b","\\\\SYNAS\\音频部\\boss\\roar.wav")]};
  assert.equal(indexer.search(unc,"roar",5)[0].asset.id,"b","UNC case and Chinese path matching must work");
  assert.deepEqual(additionalLibraryRoots("E:\\Library",[{path:"E:\\Library\\preferred",weight:3},{path:"F:\\Project",weight:3},{path:"F:\\Project\\boss",weight:5}]),["F:\\Project"],"overlapping preferred roots must not rescan the same files");
}

export async function testLibraryPreferencePersistence() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"sfx-path-priority-"));
  try {
    const preferences=[{path:path.join(root,"preferred"),weight:4}];
    const input={videoPath:path.join(root,"v.mp4"),libraryPath:root,libraryPreferences:preferences};
    assert.deepEqual((CreateRunSchema.parse(input) as any).libraryPreferences,preferences,"schema must retain preferences");
    assert.equal(CreateRunSchema.safeParse({...input,libraryPreferences:[{path:" ",weight:3}]}).success,false);
    assert.equal(CreateRunSchema.safeParse({...input,libraryPreferences:[{path:root,weight:100}]}).success,false);
    const store=new SfxRunStore(path.join(root,"runs")),run=await store.createRun(input);
    const saved=await store.readRun(run.id);assert.deepEqual((saved as any).libraryPreferences,preferences,"run reload must retain preferences");
    await exportTimeline(saved,store.directory(saved.id));
    const timeline=JSON.parse(await fs.readFile(path.join(store.directory(saved.id),"placements.json"),"utf8"));
    assert.deepEqual(timeline.libraryPreferences,preferences,"editable delivery must record actual path policy");
    const video=path.join(root,"v.mp4");await fs.writeFile(video,"same bytes");
    const records=new PreservedSounds(path.join(root,"preserved"));
    const base={videoPath:video,libraryPath:root,musicEnabled:true};
    const plain=await (records as any).identity(base),empty=await (records as any).identity({...base,libraryPreferences:[]});
    const weighted=await (records as any).identity({...base,libraryPreferences:preferences});
    assert.equal(plain.file,empty.file,"legacy preservation identity stays compatible without preferences");
    assert.notEqual(plain.file,weighted.file,"changed material preference must not reopen a different policy's accepted take");
    assert.equal((await (records as any).identity({...base,libraryPreferences:[...preferences,{path:preferences[0].path,weight:2}]})).file,weighted.file,"equivalent duplicate rules must have a stable preservation key");
    assert.deepEqual((saved.workflow!.options as any).libraryPreferences,preferences,"workflow snapshot must record effective preferences");
  }finally {await fs.rm(root,{recursive:true,force:true});}
}

export async function testLocalFolderBrowserApi() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"sfx-folder-browser-"));
  const service=new SfxService(path.join(root,"output"));
  const server=http.createServer((req,res)=>{void handleSfxRequest(req,res,new URL(req.url!,"http://localhost"),service);});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  try {
    await fs.mkdir(path.join(root,"音效目录"));await fs.mkdir(path.join(root,"preferred2"));await fs.writeFile(path.join(root,"hidden-file.wav"),"not a folder");
    const response=await fetch(`${base}/api/sfx/local-folders?path=${encodeURIComponent(root)}`);
    assert.equal(response.status,200,"folder selection needs an immediately usable directory listing");
    const folders=await response.json() as {path:string;parent:string;folders:{path:string;name:string}[]};
    assert.equal(folders.path,root);assert.equal(folders.parent,path.dirname(root));
    assert.ok(folders.folders.some(f=>f.name==="音效目录"));assert.ok(!folders.folders.some(f=>f.name==="hidden-file.wav"));
    const nested=await fetch(`${base}/api/sfx/local-folders?path=${encodeURIComponent(path.join(root,"音效目录"))}`);
    assert.equal(nested.status,200);assert.deepEqual((await nested.json() as any).folders,[]);
    const missing=await fetch(`${base}/api/sfx/local-folders?path=${encodeURIComponent(path.join(root,"missing"))}`);
    assert.equal(missing.status,400);assert.match((await missing.json() as any).error,/不存在/);
    const foreign=await fetch(`${base}/api/sfx/local-folders?path=${encodeURIComponent(root)}`,{headers:{origin:"https://unrelated.example"}});
    assert.equal(foreign.status,403,"other web pages cannot browse local directories");
    const drives=await fetch(`${base}/api/sfx/local-folders`);assert.equal(drives.status,200);assert.ok((await drives.json() as any).folders.length>0);
  }finally {await new Promise<void>(resolve=>server.close(()=>resolve()));await fs.rm(root,{recursive:true,force:true});}
}

export async function testLibraryPreferenceIndexAndFork() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"sfx-priority-integration-"));
  const originalEnv=process.env.SFX_USE_CCSWITCH;process.env.SFX_USE_CCSWITCH="0";
  try {
    const library=path.join(root,"general"),preferred=path.join(root,"preferred"),video=path.join(root,"video.mp4");
    await fs.mkdir(library);await fs.mkdir(preferred);await fs.writeFile(video,"fixture");
    await fs.writeFile(path.join(library,"heavy_impact.wav"),"fixture");await fs.writeFile(path.join(preferred,"heavy_impact.wav"),"fixture");
    const service=new SfxService(path.join(root,"output")),preferences=[{path:preferred,weight:5}];
    const created=await service.create({videoPath:video,libraryPath:library,libraryPreferences:preferences,analysisMode:"scene"});
    const indexed=await service.waitForIdle(created.runId);
    assert.equal(indexed.assets.length,2,"an external priority directory must actually join the lazy index");
    assert.deepEqual(indexed.libraryPreferences,preferences);
    await assert.rejects(service.create({videoPath:video,libraryPath:library,libraryPreferences:[{path:path.join(root,"missing"),weight:3}]}),/优先素材目录/);
    indexed.status="ready";indexed.error=undefined;indexed.duration=3;indexed.events=[EventSchema.parse({id:"e",start:0,end:1,type:"impact",query:"heavy impact",description:"重击",category:"impact",source:"vision",confidence:1,candidates:[],requiresHumanReview:false})];
    for(const item of indexed.assets){item.duration=2;item.acoustics={version:1,fingerprint:item.id,sampledStart:0,sampledDuration:1,energyEnd:1,activeDuration:1,centroid:1000,bands:[1],envelope:[1],label:"impact"};}
    await service.store.save(indexed);
    const before=await fs.readFile(path.join(service.store.directory(indexed.id),"run.json"),"utf8");
    const found=await service.search(indexed.id,"heavy impact");
    assert.ok(found[0].asset.path.startsWith(preferred),"manual candidate search must use the run's saved path weights");
    assert.equal(await fs.readFile(path.join(service.store.directory(indexed.id),"run.json"),"utf8"),before,"search remains read-only");
    const child=await service.update(indexed.id,{revision:0,events:indexed.events.map(e=>({...e,description:"changed"})),placements:[],originalGainDb:-60},{fork:true});
    assert.deepEqual(child.libraryPreferences,preferences,"edit child must preserve path configuration");
    indexed.placements=[{id:"p",eventId:"e",assetId:indexed.assets.find(a=>a.path.startsWith(preferred))!.id,start:0,duration:1,sourceOffset:0,gainDb:-10,fadeIn:.005,fadeOut:.08,category:"impact",enabled:true}];
    assert.equal(buildWorkflowReport(indexed).quality.checks.find(c=>c.id==="sources")!.status,"pass","explicit external priority folders are user-supplied sources");
  }finally {if(originalEnv===undefined)delete process.env.SFX_USE_CCSWITCH;else process.env.SFX_USE_CCSWITCH=originalEnv;await fs.rm(root,{recursive:true,force:true});}
}

export async function testGeminiReceivesLibraryPreference() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"sfx-gemini-path-"));
  try {
    const a=asset("a",path.join(root,"preferred","roar.wav"));
    const event=EventSchema.parse({id:"e",start:0,end:1,type:"roar",query:"roar",description:"吼叫",category:"foley",source:"vision",confidence:.9,candidates:[{assetId:"a",score:2,reason:"roar"}],requiresHumanReview:false});
    let sent:SelectionTask[]=[];
    const selector=new GeminiAudioSelector({model:"test",describe:async()=>({assets:[{assetId:"a",summary:"单次低沉吼叫",tags:["roar"],energy:.8,hasMusic:false,hasSpeech:false}]}),choose:async tasks=>{sent=tasks;return {choices:tasks.map(t=>({taskId:t.taskId,assetId:"a",reason:"匹配",confidence:.9}))};}},
      {sample:async()=>({assetId:"a",data:"test",format:"wav",segments:[{start:0,end:2}]})});
    await selector.select([event],{version:1,root,generatedAt:"now",warnings:[],assets:[a],libraryPreferences:[{path:path.dirname(a.path),weight:4}]} as any,{outputDir:root,cacheDir:path.join(root,"cache")});
    const preference=(sent[0].candidates[0] as any).pathPreference;
    assert.equal(preference?.weight,4,"Gemini must know the path preference used in retrieval");
  }finally {await fs.rm(root,{recursive:true,force:true});}
}
