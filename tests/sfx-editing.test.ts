import assert from "node:assert/strict";
import { createPlacements } from "../src/sfx/PlacementEngine.js";
import { planAutoMix } from "../src/sfx/AutoMix.js";
import { planEventCandidates } from "../src/sfx/CandidatePlanner.js";
import { AudioAsset, EventSchema } from "../src/sfx/models.js";
import { AudioCandidateClips } from "../src/sfx/AudioCandidateClips.js";
import { similarRecordings, diverseCandidates } from "../src/sfx/CandidateDiversity.js";
import { prepareDiverseCandidates } from "../src/sfx/CandidatePreparation.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const asset = (id: string, fileName: string, duration = 3.131): AudioAsset => ({
  id, fileName, path: fileName, relativePath: fileName, size: 100, mtimeMs: 1,
  tags: [], usable: true, duration, onset: .016, rmsDb: -16.5, peakDb: 0
});
const roar = () => EventSchema.parse({ id: "roar", start: 8.8, end: 9.5, type: "boss_hit_react", category: "other",
  actor: "boss", phase: "aftermath", description: "巨猿受击后张嘴咆哮", query: "ape roar", source: "vision",
  confidence: .9, requiresHumanReview: true, candidates: [{ assetId: "voice", score: 1, reason: "selected" }] });

export function testSoundAwareSourceLengths() {
  const e = roar(), a = asset("voice", "vo_apesstonehand_roar.wav");
  const voice = createPlacements([e], [a], 25.9)[0];
  assert.ok(voice.duration > .7 && voice.duration <= 1.05, "a short vocal must allow a brief release without playing all 3.1 seconds");
  const longLegacy = { ...voice, duration: 3.115, fadeIn: 0, fadeOut: 0 };
  const mixed = planAutoMix({ duration: 25.9, events: [e], assets: [a], placements: [longLegacy] });
  assert.ok(mixed.placements[0].duration <= 1.05, "remixing a legacy full-length roar must respect its visual phrase");
  assert.ok(mixed.placements[0].gainDb >= -8, "vocal priority must survive sound-aware trimming");
  assert.deepEqual(planAutoMix({ duration: 25.9, events: [e], assets: [a], placements: mixed.placements }).placements, mixed.placements);
  const movement = { ...e, type: "boss_recover", category: "foley" as const, description: "Boss恢复站姿", query: "armor movement", phase: "motion" };
  const move = createPlacements([movement], [asset("voice", "armor_movement.wav", 5)], 25.9)[0];
  assert.ok(move.duration <= .9, "ordinary movement must not use an unrelated 5-second continuation");
  const contact = { ...e, type: "ground_hit", category: "impact" as const, phase: "contact", end: 8.9, description: "砸地命中" };
  const hit = createPlacements([contact], [asset("voice", "ground_hit.wav", 2)], 25.9)[0];
  assert.ok(hit.duration > 1.9, "contact sounds may keep their recorded release beyond a short visible contact");
}

export function testCroppedEdgeFades() {
  const e = roar(), a = asset("voice", "vo_apesstonehand_roar.wav");
  const p = createPlacements([e], [a], 25.9)[0];
  const mixed = planAutoMix({ duration: 25.9, events: [e], assets: [a], placements: [{ ...p, duration: .7, fadeIn: 0, fadeOut: 0 }] });
  const cut = mixed.placements[0];
  assert.ok(cut.fadeIn >= .004, "a source cut needs a small fade-in even if inherited fades were zero");
  assert.ok(cut.fadeOut >= .04, "a cropped voice needs a smooth short fade-out");
  assert.ok(cut.fadeIn + cut.fadeOut <= cut.duration);
  const tiny = createPlacements([{ ...e, start: 25.89, end: 25.9 }], [a], 25.9)[0];
  assert.ok(tiny.fadeIn > 0 && tiny.fadeOut > 0 && tiny.fadeIn + tiny.fadeOut <= tiny.duration + .001);
}

export function testMeaningfulFilenameAlternatives() {
  const assets = [
    asset("v1", "vo_apesstonehand_roar_01 [11111111.wem].wav"),
    asset("v2", "vo_apesstonehand_roar_02 [22222222.wem].wav"),
    asset("v3", "vo_apesstonehand_roar_03 [33333333.wem].wav"),
    asset("v4", "vo_apesstonehand_roar_04 [44444444.wem].wav"),
    asset("v5", "vo_apesstonehand_roar_05 [55555555.wem].wav"),
    asset("deep", "vo_ape_roar_deep_growl.wav"),
    asset("breath", "vo_ape_roar_breathy_short.wav")
  ];
  const e = EventSchema.parse({ ...roar(), layers: undefined, candidates: [] });
  planEventCandidates(e, { version: 1, root: ".", generatedAt: "now", warnings: [], assets });
  const ids = e.layers![0].candidates.map(c => c.assetId);
  assert.equal(ids.filter(id => /^v\d/.test(id)).length, 1, "five takes of the same family are one meaningful alternative");
  assert.ok(ids.includes("deep") && ids.includes("breath"), "alternative slots should offer different vocal characters");
  const ui = [
    asset("warning", "界面 [ui_warning] [11111111.wem].wav"),
    asset("warningTake", "界面 [ui_warning_02] [22222222.wem].wav"),
    asset("scroll", "界面 [ui_scroll] [33333333.wem].wav"),
    asset("chinese", "界面 [确认按钮] [44444444.wem].wav")
  ];
  const distinctUi = diverseCandidates(ui.map(asset => ({asset, score: 1, reason: "UI"}))).map(c => c.asset.id);
  assert.deepEqual(distinctUi, ["warning", "scroll", "chinese"], "semantic bracket labels must remain distinct while numbered takes collapse");
  const firstPass = diverseCandidates(ui.map(asset => ({asset, score: 1, reason: "名称匹配 UI"})));
  const repeated = diverseCandidates(diverseCandidates(firstPass));
  assert.deepEqual(repeated.map(c => c.reason), firstPass.map(c => c.reason), "refreshing alternatives must not keep appending the same diversity explanation");
}

export async function testMeasuredCandidateSimilarity() {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "sfx-acoustic-diversity-"));
  const wav = (hz: number) => {
    const rate=16000, frames=rate;
    const data=Buffer.alloc(44+frames*2); data.write("RIFF"); data.writeUInt32LE(data.length-8,4); data.write("WAVEfmt ",8);
    data.writeUInt32LE(16,16); data.writeUInt16LE(1,20); data.writeUInt16LE(1,22); data.writeUInt32LE(rate,24); data.writeUInt32LE(rate*2,28); data.writeUInt16LE(2,32); data.writeUInt16LE(16,34); data.write("data",36); data.writeUInt32LE(frames*2,40);
    for(let i=0;i<frames;i++) data.writeInt16LE(Math.round(10000*Math.sin(2*Math.PI*hz*i/rate)*Math.exp(-i/rate*4)),44+i*2);
    return data;
  };
  try {
    const assets = [asset("a", "low_beast.wav", 1),asset("b","different_name.wav",1),asset("c","bright_beast.wav",1)];
    const clips = new AudioCandidateClips();
    for (let i=0;i<assets.length;i++) {
      const a=assets[i]; a.path=path.join(folder,a.fileName); a.onset=0;
      await fs.writeFile(a.path,wav(i===2?2500:220));
      await clips.sample(a,false,folder);
    }
    assert.ok(assets.every(a=>a.acoustics?.label), "shortlist listening must measure reusable spectral/envelope features");
    assert.equal(similarRecordings(assets[0],assets[1]),true,"renaming identical recordings cannot create a meaningful alternative");
    assert.equal(similarRecordings(assets[0],assets[2]),false,"different timbre must remain a meaningful alternative");
    for(const category of ["ambience","music"] as const) {
      const e=EventSchema.parse({...roar(),category,query:category==="music"?"music":"wind",layers:[{id:"bed",role:category,offset:0,query:category,candidates:assets.map(a=>({assetId:a.id,score:1,reason:"previous"}))}]});
      await prepareDiverseCandidates([e],{version:1,root:folder,generatedAt:"now",assets,warnings:[]},folder);
      assert.equal(e.layers![0].candidates.length,2,"environment/music alternatives also need acoustic diversity");
      assert.equal(e.layers![0].candidates[0].assetId,"a","the current bed must remain first");
    }
  } finally { await fs.rm(folder,{recursive:true,force:true}); }
}
