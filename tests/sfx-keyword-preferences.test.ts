import assert from "node:assert/strict";
import {promises as fs} from "node:fs";
import os from "node:os";
import path from "node:path";
import {AudioLibraryIndexer} from "../src/sfx/AudioLibraryIndexer.js";
import {CreateRunSchema,EventSchema,type AudioAsset,type AudioLibraryIndex} from "../src/sfx/models.js";
import {planEventCandidates} from "../src/sfx/CandidatePlanner.js";
import {SfxRunStore,exportTimeline} from "../src/sfx/SfxRunStore.js";
import {PreservedSounds} from "../src/sfx/PreservedSounds.js";
import {GeminiAudioSelector,type SelectionTask} from "../src/sfx/GeminiAudioSelector.js";
import {SfxService} from "../src/sfx/SfxService.js";

const asset=(id:string,name:string):AudioAsset=>({id,path:`E:/Library/${name}`,relativePath:name,fileName:path.posix.basename(name),size:1,mtimeMs:1,tags:[],usable:true,duration:2});
const index=(assets:AudioAsset[],rules:unknown[]):AudioLibraryIndex=>({version:1,root:"E:/Library",generatedAt:"now",warnings:[],assets,keywordPreferences:rules} as AudioLibraryIndex);
const search=(lib:AudioLibraryIndex,query:string,context?:Parameters<AudioLibraryIndexer["search"]>[3])=>new AudioLibraryIndexer().search(lib,query,20,context);
const event=(actor="boss")=>EventSchema.parse({id:"e",start:0,end:1,type:"roar",query:"roar",description:"低沉吼叫",category:"foley",source:"vision",confidence:.9,candidates:[],requiresHumanReview:false,actor});

export function testKeywordRanking() {
  const metal=index([asset("wood","impact_wood.wav"),asset("metal","impact_metal.wav"),asset("metallic","impact_metallic.wav"),asset("chirp","metal_bird_chirp.wav")],[{keyword:"金属",weight:6,scope:"all"}]);
  const material=search(metal,"impact",event("player"));
  const materialPlain=search(index(metal.assets,[]),"impact",event("player"));
  assert.ok(material.find(r=>r.asset.id==="metal")!.score>materialPlain.find(r=>r.asset.id==="metal")!.score,"Chinese material rule must actually add preference weight");
  assert.ok(["metal","metallic"].includes(material[0].asset.id),"Chinese material preference must boost English material filenames");
  assert.ok(!material.some(r=>r.asset.id==="chirp"),"material preference cannot replace action relevance");
  const english=search(index([asset("wood","冲击_木质.wav"),asset("metal","冲击_金属.wav")],[{keyword:"metal",weight:6,scope:"all"}]),"冲击",event("player"));
  assert.equal(english[0].asset.id,"metal","material aliases must also work English to Chinese");
  const rules=[{keyword:"YeTuGa",weight:5,scope:"boss"}];
  const lib=index([asset("other","efx_other_roar.wav"),asset("preferred","efx_yetuga_roar.wav"),asset("irrelevant","efx_yetuga_bird_chirp.wav"),asset("substring","efx_notyetuga_roar.wav")],rules);
  const result=search(lib,"roar",event());
  assert.equal(result[0].asset.id,"preferred","an appropriate yetuga sound must be preferred for Boss");
  assert.match(result[0].reason,/关键词优先.*yetuga/i);
  assert.ok(!result.some(r=>r.asset.id==="irrelevant"),"keyword match alone cannot make bird chirps relevant to a roar");
  const plain=search(index(lib.assets,[]),"roar",event());
  for(const id of ["other","substring"])assert.equal(result.find(r=>r.asset.id===id)!.score,plain.find(r=>r.asset.id===id)!.score,"keyword requires a complete name token");
  for(const context of [event("player"),{actor:"ui",category:"other" as const},{category:"music" as const},{category:"ambience" as const},undefined]) {
    const scoped=search(lib,"roar",context);
    assert.equal(scoped.find(r=>r.asset.id==="preferred")!.score,plain.find(r=>r.asset.id==="preferred")!.score,"Boss preference must not affect other or unknown actors");
  }
  const duplicated=search(index(lib.assets,[...rules,{keyword:"yetuga",weight:2,scope:"boss"}]),"roar",event());
  assert.equal(duplicated[0].score,result[0].score,"overlapping keyword rules use max weight");
  const fromPath=search(index([asset("other","general/roar.wav"),asset("folder","Yetuga/roar.wav")],rules),"roar",event());
  assert.equal(fromPath[0].asset.id,"folder","folder names also count");
  const combined=index([asset("weak","preferred/efx_yetuga_impact.wav"),asset("exact","general/gorilla_roar_heavy_attack.wav")],[{keyword:"yetuga",weight:10,scope:"all"}]);
  combined.libraryPreferences=[{path:"E:/Library/preferred",weight:10}];
  assert.equal(search(combined,"gorilla roar heavy attack",event())[0].asset.id,"exact","strong relevance must win over combined preferences");
  const onlyPreferred=index([asset("yes","preferred/efx_yetuga_roar.wav")],[{keyword:"yetuga",weight:10,scope:"boss"}]);
  const before=search(index(onlyPreferred.assets,[]),"roar",event())[0].score;
  onlyPreferred.libraryPreferences=[{path:"E:/Library/preferred",weight:10}];
  assert.ok(search(onlyPreferred,"roar",event())[0].score-before<=4,"all preference bonuses share a bounded budget");
  const punct=search(index([asset("wrong","other/charge_loop.wav"),asset("right","special/charge_start_roar.wav")],[{keyword:"charge_start",weight:5,scope:"all"}]),"roar",event());
  assert.equal(punct[0].asset.id,"right","phrase separators are literal, not regex or query instructions");
}

export function testKeywordPlannerScope() {
  const neutral=event();neutral.description="猩猩咆哮";
  planEventCandidates(neutral,index([asset("generic","aaa_roar.wav"),asset("old","efx_apesstonehand_roar.wav")],[]));
  assert.ok(neutral.layers!.every(l=>!l.query.includes("apesstonehand")),"a generic ape must never imply a specific creature identifier");
  const lib=index([asset("generic","aaa_roar.wav"),asset("old","efx_apesstonehand_roar.wav"),asset("new","efx_yetuga_roar.wav")],[{keyword:"yetuga",weight:5,scope:"boss"}]);
  const boss=event();boss.description="猩猩咆哮";
  planEventCandidates(boss,lib);
  assert.equal(boss.layers![0].candidates[0].assetId,"new","explicit creature preference must supersede the legacy default creature name");
  assert.doesNotMatch(boss.layers![0].query,/apesstonehand/);
  assert.equal(search(lib,"apesstonehand roar",boss)[0].asset.id,"new","historical auto-injected creature prefix cannot override current preference");
  assert.equal(search(lib,"nonexistent_sound",event()).length,0,"no appropriate action means no fabricated fallback");
  assert.ok(search(index(lib.assets,[{keyword:"missing",weight:10,scope:"boss"}]),"roar",event()).length,"unmatched keywords retain the general library fallback");
  const charge=event();charge.type="charge";charge.query="charge";charge.description="Boss 持续蓄力";charge.phase="sustain";
  planEventCandidates(charge,index([asset("sword","efx_gsword_com_charge_loop.wav"),asset("boss-charge","efx_yetuga_charge_loop.wav")],[{keyword:"yetuga",weight:5,scope:"boss"}]));
  assert.equal(charge.layers![0].candidates[0].assetId,"boss-charge","legacy sword charge injection cannot override a suitable preferred Boss charge");
}

export async function testKeywordPersistence() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"sfx-keywords-"));
  try {
    const video=path.join(root,"video.mp4");await fs.writeFile(video,"same video");
    const rules=[{keyword:"yetuga",weight:5,scope:"boss"}];
    const input={videoPath:video,libraryPath:root,keywordPreferences:rules};
    assert.deepEqual((CreateRunSchema.parse(input) as any).keywordPreferences,rules,"create API must retain keyword rules");
    for(const invalid of [{keyword:" ",weight:5,scope:"boss"},{keyword:"x",weight:11,scope:"all"},{keyword:"x",weight:2,scope:"not-a-scope"}])
      assert.equal(CreateRunSchema.safeParse({...input,keywordPreferences:[invalid]}).success,false);
    const store=new SfxRunStore(path.join(root,"runs")),run=await store.createRun(input as any);
    const saved=await store.readRun(run.id);
    assert.deepEqual((saved as any).keywordPreferences,rules);
    assert.deepEqual(saved.workflow!.options.keywordPreferences,rules);
    await exportTimeline(saved,store.directory(saved.id));
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(store.directory(saved.id),"placements.json"),"utf8")).keywordPreferences,rules);
    const preserved=new PreservedSounds(path.join(root,"preserved"));
    const base={videoPath:video,libraryPath:root};
    const plain=await (preserved as any).identity(base),empty=await (preserved as any).identity({...base,keywordPreferences:[]}),weighted=await (preserved as any).identity(input);
    assert.equal(plain.file,empty.file,"legacy empty-rule preservation remains compatible");assert.notEqual(plain.file,weighted.file);
    assert.equal((await (preserved as any).identity({...input,keywordPreferences:[...rules,{keyword:"YeTuGa",weight:2,scope:"boss"}]})).file,weighted.file,"equivalent duplicate rules have stable identities");
    const service=new SfxService(path.join(root,"service"));const editable=await service.store.createRun({videoPath:video,libraryPath:root});
    editable.status="ready";editable.duration=3;editable.events=[event()];editable.assets=[asset("general","aaa_roar.wav"),asset("preferred","efx_yetuga_roar.wav")];
    for(const a of editable.assets)a.acoustics={version:1,fingerprint:a.id,sampledStart:0,sampledDuration:1,energyEnd:1,activeDuration:1,centroid:1000,bands:[1],envelope:[1],label:"roar"};
    await service.store.save(editable);
    const file=path.join(service.store.directory(editable.id),"run.json"),before=await fs.readFile(file,"utf8");
    const found=await (service.search as Function).call(service,editable.id,"roar","foley",{eventId:"e",keywordPreferences:rules});
    assert.equal(found[0].assetId,"preferred","manual search can use current unsaved preferences and saved actor context");
    assert.equal(await fs.readFile(file,"utf8"),before,"search must not rewrite the project");
    const child=await service.update(editable.id,{revision:0,events:editable.events,placements:[],originalGainDb:-60,keywordPreferences:rules},{fork:true});
    assert.notEqual(child.id,editable.id,"preference-only changes create a version");
    assert.deepEqual((child as any).keywordPreferences,rules);assert.deepEqual(child.events,editable.events);assert.deepEqual(child.placements,editable.placements);
    const reopened=await service.readRun(child.id);assert.deepEqual((reopened as any).keywordPreferences,rules);
    const next=await service.update(child.id,{revision:child.revision,events:child.events.map(e=>({...e,description:"edited label"})),placements:[],originalGainDb:-60},{fork:true});
    assert.deepEqual((next as any).keywordPreferences,rules,"older edit clients cannot clear the preference");
    const newEventSearch=await service.search(next.id,"roar","foley",{eventId:"new-unsaved-event"});
    assert.ok(newEventSearch.length,"search for a newly added unsaved event must still work");
    const copied=await service.saveProjectAs(next.projectId!,"copy");
    assert.deepEqual((await service.readRun(copied.runId) as any).keywordPreferences,rules,"save-as retains preferences");
  } finally {await fs.rm(root,{recursive:true,force:true});}
}

export async function testGeminiReceivesKeywordPreference() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"sfx-keyword-gemini-"));
  try {
    const a=asset("a","efx_yetuga_roar.wav"),ev=event();ev.candidates=[{assetId:a.id,score:4,reason:"roar"}];
    let sent:SelectionTask[]=[];
    const selector=new GeminiAudioSelector({model:"test",describe:async()=>({assets:[{assetId:"a",summary:"低沉吼叫",tags:["roar"],energy:.8,hasMusic:false,hasSpeech:false}]}),choose:async tasks=>{sent=tasks;return {choices:tasks.map(t=>({taskId:t.taskId,assetId:"a",reason:"符合Boss声音",confidence:.9}))};}},
      {sample:async()=>({assetId:"a",data:"test",format:"wav",segments:[{start:0,end:2}]})});
    await selector.select([ev],index([a],[{keyword:"yetuga",weight:5,scope:"boss"}]),{outputDir:root,cacheDir:path.join(root,"cache")});
    assert.deepEqual((sent[0].candidates[0] as any).keywordPreference,{keyword:"yetuga",weight:5,scope:"boss"},"Gemini must see the matching keyword and scope");
  } finally {await fs.rm(root,{recursive:true,force:true});}
}
