import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventSchema, type AudioAsset, type SfxRun } from "../src/sfx/models.js";
import { createPlacements } from "../src/sfx/PlacementEngine.js";
import { planAutoMix } from "../src/sfx/AutoMix.js";
import * as sourceEditor from "../src/sfx/GeminiSourceEditor.js";

export async function testGeminiSourceEditBoundaries() {
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),"sfx-source-edit-"));
  const a:AudioAsset={id:"voice",fileName:"vo_ape_roar.wav",path:"voice.wav",relativePath:"voice.wav",duration:3.1,size:100,mtimeMs:1,tags:[],usable:true,onset:0,rmsDb:-16.5,peakDb:0};
  const e=EventSchema.parse({id:"roar",start:1,end:1.7,type:"roar",category:"other",actor:"boss",phase:"sustain",description:"Boss张嘴吼叫",query:"ape roar",source:"vision",confidence:.9,requiresHumanReview:true,candidates:[{assetId:a.id,score:1,reason:"name"}]});
  const run={duration:6,events:[e],assets:[a],placements:createPlacements([e],[a],6)} as SfxRun;
  const model={model:"gemini-fixture", async editSources(tasks:any[]) {return {edits:tasks.map(t=>({placementId:t.placementId,assetId:a.id,sourceStart:.2,bodyEnd:.85,releaseEnd:1.1,reason:"保留短吼主体和衰减，避开后续升调",confidence:.9}))};}};
  const clips={async sample(){return {assetId:a.id,data:"d2F2",format:"wav" as const,segments:[{start:0,end:3.1}]};}};
  try {
    const report=await sourceEditor.reviewSourceEdits(run,model,clips,folder);
    assert.equal(report.decisions[0].basis,"gemini-audio");
    assert.equal(run.placements[0].sourceOffset,.2);
    assert.ok(Math.abs(run.placements[0].duration-.9)<.001);
    assert.ok(run.placements[0].fadeIn>0&&run.placements[0].fadeOut>0);
    assert.equal(planAutoMix(run).placements[0].duration,run.placements[0].duration,"mixing cannot overwrite a validated source phrase");
    const locked={...run.placements[0],locked:true};
    run.placements=[locked]; await sourceEditor.reviewSourceEdits(run,model,clips,folder);
    assert.deepEqual(run.placements[0],locked);
    for(const choice of [{sourceStart:-1,bodyEnd:.4,releaseEnd:.8},{sourceStart:0,bodyEnd:1.5,releaseEnd:3},{sourceStart:.2,bodyEnd:.8,releaseEnd:1.1,assetId:"invented"}]) {
      run.placements=createPlacements([e],[a],6);
      const invalid={...model,async editSources(tasks:any[]){return {edits:tasks.map(t=>({placementId:t.placementId,assetId:a.id,reason:"bad",confidence:.9,...choice}))};}};
      const rejected=await sourceEditor.reviewSourceEdits(run,invalid,clips,folder);
      assert.equal(rejected.decisions[0].basis,"local-bounded","invalid source ranges must be labelled fallback");
      assert.ok(run.placements[0].sourceOffset>=0&&run.placements[0].duration<=1.05);
    }
    run.placements=createPlacements([e],[a],6);
    const missing=await sourceEditor.reviewSourceEdits(run,{...model,async editSources(){return {edits:[]};}},clips,folder);
    assert.equal(missing.status,"fallback");
    assert.ok(missing.warnings.length,"a missing model decision must be disclosed in the tool");
    run.placements=createPlacements([e],[a],6);
    const microscopic=await sourceEditor.reviewSourceEdits(run,{...model,async editSources(tasks:any[]){return {edits:tasks.map(t=>({placementId:t.placementId,assetId:a.id,sourceStart:.2004,bodyEnd:.2005,releaseEnd:.2006,reason:"too short",confidence:.9}))};}},clips,folder);
    assert.equal(microscopic.status,"fallback","a sub-millisecond phrase must not round into an invalid placement");
    const failed=await sourceEditor.reviewSourceEdits(run,{...model,async editSources(){throw new Error("offline");}},clips,folder);
    assert.equal(failed.status,"fallback");
    assert.ok(failed.warnings.some(w=>w.includes("失败")));
  } finally {await fs.rm(folder,{recursive:true,force:true});}
}
