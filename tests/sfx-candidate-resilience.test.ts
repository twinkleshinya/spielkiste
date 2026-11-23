import assert from "node:assert/strict";
import {promises as fs} from "node:fs";
import os from "node:os";
import path from "node:path";
import {eligibleAssets} from "../src/sfx/AssetExclusions.js";
import {AudioLibraryIndexer} from "../src/sfx/AudioLibraryIndexer.js";
import {measureShortlist,prepareDiverseCandidates} from "../src/sfx/CandidatePreparation.js";
import {GeminiAudioSelector,type AudioSelectionModel} from "../src/sfx/GeminiAudioSelector.js";
import {EventSchema,type AudioAsset,type AudioLibraryIndex} from "../src/sfx/models.js";
import {createPlacements} from "../src/sfx/PlacementEngine.js";

const asset=(id:string):AudioAsset=>({id,path:`E:/library/${id}.wav`,relativePath:`${id}.wav`,fileName:`${id}.wav`,size:10,mtimeMs:1,tags:["hit"],usable:true,duration:1,onset:0,rmsDb:-20,peakDb:-3});
const event=(ids:string[])=>EventSchema.parse({id:"e",start:0,end:1,type:"hit",description:"接触",query:"hit",category:"impact",source:"vision",confidence:.9,requiresHumanReview:false,candidates:ids.map(assetId=>({assetId,score:1,reason:"name"})),layers:[{id:"hit",role:"impact",query:"hit",offset:0,candidates:ids.map(assetId=>({assetId,score:1,reason:"name"}))}]});
const index=(assets:AudioAsset[]):AudioLibraryIndex=>({version:1,root:"E:/library",generatedAt:"now",warnings:[],assets});
const describe:AudioSelectionModel["describe"]=async samples=>({assets:samples.map(s=>({assetId:s.assetId,summary:"短接触",tags:["hit"],energy:.6,hasMusic:false,hasSpeech:false}))});

export function testLegacyMetadataNeverBecomesAudio() {
  const bad=asset("._hit"),mac={...asset("mac"),path:"E:/library/__MACOSX/hit.wav"},good=asset("hit");
  const lib=index([bad,mac,good]),ev=event(lib.assets.map(a=>a.id));
  assert.deepEqual(eligibleAssets(lib.assets).map(a=>a.id),[good.id]);
  assert.deepEqual(new AudioLibraryIndexer().search(lib,"hit",20).map(r=>r.asset.id),[good.id]);
  assert.deepEqual(createPlacements([ev],lib.assets,3).map(p=>p.assetId),[good.id]);
}

export function testBoundedSearchPreservesRanking() {
  const assets=Array.from({length:250},(_,i)=>({...asset(String(i)),fileName:`hit_${i%7===0?"metal":"wood"}_${250-i}.wav`,relativePath:`folder_${i%4}/hit_${250-i}.wav`}));
  const lib=index(assets),indexer=new AudioLibraryIndexer();
  const all=indexer.search(lib,"hit metal",assets.length);
  for(const size of [1,3,5,40])assert.deepEqual(indexer.search(lib,"hit metal",size),all.slice(0,size));
  const untouched=index([new Proxy(asset("hit"),{get(){throw new Error("zero results must not scan the library");}})]);
  assert.deepEqual(indexer.search(untouched,"hit",0),[]);
}

export async function testFailedClipCannotSurviveFallback() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"sfx-bad-clip-"));
  try {
    const bad=asset("bad"),good=asset("good"),ev=event([bad.id,good.id]);
    const model:AudioSelectionModel={model:"test",describe,async choose(){throw new Error("gateway unavailable");}};
    const selector=new GeminiAudioSelector(model,{async sample(a){if(a.id===bad.id)throw new Error("decode failed");return {assetId:a.id,data:"wav",format:"wav",segments:[{start:0,end:1}]};}});
    const report=await selector.select([ev],index([bad,good]),{outputDir:root,cacheDir:path.join(root,"cache")});
    assert.equal(bad.usable,false);
    assert.deepEqual(ev.layers![0].candidates.map(c=>c.assetId),[good.id]);
    assert.deepEqual(createPlacements([ev],[bad,good],3).map(p=>p.assetId),[good.id]);
    assert.ok(report.warnings.some(w=>w.includes("bad.wav")&&!w.includes("保留规则候选")));
  } finally {await fs.rm(root,{recursive:true,force:true});}
}

export async function testDescriptionFailureIsIsolatedToBatch() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"sfx-batch-"));
  try {
    const assets=["first","second","third","later"].map(asset),ev=event(assets.map(a=>a.id));let batches=0,choices=0;
    const selector=new GeminiAudioSelector({model:"test",async describe(samples){batches++;if(samples.some(s=>s.assetId==="first"))throw new Error("bad response");return describe(samples);},async choose(tasks){choices++;return {choices:tasks.map(t=>({taskId:t.taskId,assetId:"later",confidence:.9,reason:"fits"}))};}},
      {async sample(a){return {assetId:a.id,data:"wav",format:"wav",segments:[{start:0,end:1}]};}});
    const report=await selector.select([ev],index(assets),{outputDir:root,cacheDir:path.join(root,"cache")});
    assert.ok(batches>=2);assert.equal(choices,1);assert.equal(ev.layers![0].candidates[0].assetId,"later");assert.equal(report.analyzedAssets,1);
  } finally {await fs.rm(root,{recursive:true,force:true});}
}

export async function testMeasurementInvalidationAndReplacement() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"sfx-measure-invalid-"));
  try {
    const bad=asset("hit_broken");bad.path=path.join(root,"broken.wav");await fs.writeFile(bad.path,"not audio");
    await assert.rejects(measureShortlist(bad,root));assert.equal(bad.usable,false,"measurement copy must propagate decode failure");
    const failures=Array.from({length:9},(_,i)=>({...asset(`hit_${String.fromCharCode(97+i)}broken`),path:bad.path}));
    const good=asset("hit_valid");good.acoustics={version:1,fingerprint:"valid",sampledStart:0,sampledDuration:1,energyEnd:1,activeDuration:1,centroid:1000,bands:[1],envelope:[1],label:"hit"};
    const lib=index([...failures,good]),ev=event(lib.assets.map(a=>a.id));
    await prepareDiverseCandidates([ev],lib,root);
    assert.ok(ev.candidates.some(c=>c.assetId===good.id),"failed families must be replenished from remaining ranked candidates");
    assert.ok(ev.candidates.every(c=>lib.assets.find(a=>a.id===c.assetId)?.usable));
  } finally {await fs.rm(root,{recursive:true,force:true});}
}

