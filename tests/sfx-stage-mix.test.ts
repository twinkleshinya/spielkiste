import assert from "node:assert/strict";
import { fitsAssetIntent } from "../src/sfx/AssetIntent.js";
import { planEventCandidates } from "../src/sfx/CandidatePlanner.js";
import { createPlacements } from "../src/sfx/PlacementEngine.js";
import { AudioAsset, EventSchema } from "../src/sfx/models.js";
import { planAutoMix, duckGainAt, isForeground } from "../src/sfx/AutoMix.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SfxService } from "../src/sfx/SfxService.js";
import { selectReviewEvents } from "../src/sfx/SelectionPolicy.js";
import { readConfig } from "../src/sfx/CcSwitchVisionProvider.js";
import { LayerPlanner } from "../src/sfx/LayerPlanner.js";
import { planAllEventCandidates } from "../src/sfx/CandidatePlanner.js";
import { buildWorkflowReport } from "../src/sfx/WorkflowReport.js";

const asset = (id: string, fileName: string, duration = 2): AudioAsset => ({ id, fileName, relativePath: fileName,
  path: fileName, size: 100, mtimeMs: 1, tags: [], usable: true, duration, onset: 0, rmsDb: -24, peakDb: -6 });
const cue = (value: Record<string, unknown>) => EventSchema.parse({ id: "recovery", start: 1, end: 1.1,
  type: "attack_end", phase: "aftermath", actor: "player", category: "foley", description: "攻击结束，收刀回到待机",
  query: "sword foley end", confidence: .9, source: "vision", requiresHumanReview: true, candidates: [], ...value });

export function testFilenameStageConstraints() {
  const end = cue({});
  assert.equal(fitsAssetIntent(end, "foley", asset("start", "sword_foley_start.wav")), false, "attack recovery should flag a start filename as a mismatch");
  assert.equal(fitsAssetIntent(end, "foley", asset("camel", "SwordFoleyStart01.wav")), false, "CamelCase stages must be recognized");
  assert.equal(fitsAssetIntent(end, "foley", asset("chinese", "拟音-剑-开始.wav")), false);
  assert.equal(fitsAssetIntent(end, "foley", asset("end", "sword_foley_end.wav")), true);
  assert.equal(fitsAssetIntent(cue({ phase: "motion", type: "weapon_handling" }), "foley", asset("start", "sword_foley_start.wav")), false, "explicit recovery evidence must still reject start when the model uses generic motion");
  const preparation = cue({ type: "player_guard_stance", phase: "preparation", description: "玩家收回太刀并调整站姿进入格挡防守准备", query: "armor foley stance" });
  assert.equal(fitsAssetIntent(preparation, "foley", asset("start", "armor_foley_start.wav")), true, "preparing a guard may use start even when the description mentions drawing the sword back");
  assert.equal(fitsAssetIntent(preparation, "foley", asset("end", "armor_foley_end.wav")), false);
  const cast = cue({ type: "spell_cast", phase: "motion", description: "施法释放法术", query: "magic cast" });
  assert.equal(fitsAssetIntent(cast, "foley", asset("generic", "magic_foley.wav")), false, "a generic magic filename gets a cast-intent review hint");
  assert.equal(fitsAssetIntent(cast, "foley", asset("cast", "efx_magic_cast_01.wav")), true);
  const music = cue({ category: "music", phase: "aftermath", type: "music_cue", query: "music battle", description: "音乐退出" });
  assert.equal(fitsAssetIntent(music, "music", asset("music", "bgm_battle_start.wav")), true, "continuous music file stage is independent of cue stage");
  const assets = [asset("start", "sword_foley_start.wav"), asset("end", "sword_foley_end.wav")];
  planEventCandidates(end, { version: 1, root: ".", generatedAt: "now", assets, warnings: [] });
  assert.ok(end.candidates.length > 0);
  assert.equal(end.candidates[0]?.assetId, "end", "local fallback should prefer the action-stage name");
  assert.ok(end.candidates.some(c => c.assetId === "start"), "mismatched names are retained for acoustic review");
  const stale = cue({ layers: [{ id: "main", role: "foley", query: "sword foley", offset: 0,
    candidates: [{ assetId: "start", score: 100, reason: "stale AI pick" }, { assetId: "end", score: 5, reason: "stage match" }] }] });
  assert.equal(createPlacements([stale], assets, 5)[0]?.assetId, "start", "an explicit prior or Gemini choice must not be silently discarded for its filename");
  const onlyStart = cue({ layers: undefined, candidates: [] });
  planEventCandidates(onlyStart, { version: 1, root: ".", generatedAt: "now", assets: [assets[0]], warnings: [] });
  assert.equal(onlyStart.candidates[0]?.assetId, "start", "name mismatch must remain available when it is the only related material");
  assert.ok(createPlacements([onlyStart], assets, 5).length, "name advice must not turn a usable action silent");
  const genericMagic = asset("magic", "magic_energy_release.wav");
  const castFallback = cue({ ...cast, layers: undefined, candidates: [] });
  planEventCandidates(castFallback, { version: 1, root: ".", generatedAt: "now", assets: [genericMagic], warnings: [] });
  assert.equal(castFallback.candidates[0]?.assetId, "magic", "cast intent must also retrieve semantic magic material without a literal cast token");
}

export function testNaturalOneShotTails() {
  const landing = cue({ type: "player_land", phase: "contact", description: "玩家落地", query: "footstep land",
    candidates: [{ assetId: "land", score: 10, reason: "filename" }] });
  const p = createPlacements([landing], [asset("land", "player_footstep_land.wav", 2)], 6)[0];
  assert.equal(p.duration, 2, "a 0.1 second visible contact must not crop a 2 second landing decay");
  assert.ok(p.fadeOut >= .08);
  const bounded = createPlacements([{ ...landing, start: 5.5, end: 5.6 }], [asset("land", "player_footstep_land.wav", 2)], 6)[0];
  assert.equal(bounded.duration, .5, "the video boundary still bounds the tail");
  const charge = cue({ type: "player_charge", phase: "sustain", description: "持续蓄力", query: "charge loop", start: 1, end: 3,
    candidates: [{ assetId: "charge", score: 1, reason: "name" }] });
  assert.equal(createPlacements([charge], [asset("charge", "charge_loop.wav", 8)], 6)[0].duration, 2, "a held charge follows the visible hold instead of playing its entire loop file");
}

export function testAutoMixHierarchy() {
  const hit = cue({ id: "hit", type: "ground_slam", phase: "contact", category: "impact", start: 2, end: 2.1,
    description: "Boss砸地", candidates: [{ assetId: "hit", score: 1, reason: "name" }] });
  const debris = cue({ id: "debris", type: "debris_fall", phase: "aftermath", start: 2.1, end: 2.4,
    description: "碎石落地", candidates: [{ assetId: "debris", score: 1, reason: "name" }] });
  const music = cue({ id: "music", type: "music_cue", phase: "sustain", category: "music", start: 0, end: 6,
    description: "音乐", candidates: [{ assetId: "music", score: 1, reason: "name" }] });
  const assets = [asset("hit", "boss_impact.wav"), asset("debris", "debris.wav"), asset("music", "bgm_battle_loop.wav", 10)];
  const placements = createPlacements([hit, debris, music], assets, 6);
  const result = planAutoMix({ duration: 6, events: [hit, debris, music], assets, placements });
  const hitClip = result.placements.find(p => p.eventId === "hit")!;
  const debrisClip = result.placements.find(p => p.eventId === "debris")!;
  const musicClip = result.placements.find(p => p.eventId === "music")!;
  assert.ok(hitClip.gainDb > debrisClip.gainDb + 5, "supporting debris stays below the main contact instead of normalizing all clips equally");
  assert.ok(hitClip.gainDb > musicClip.gainDb + 8, "music leaves room for the main contact");
  assert.equal(duckGainAt(musicClip, 2.1, result.ducks), .36, "overlapping contacts share one duck envelope rather than multiplying dips");
  assert.equal(duckGainAt(musicClip, 5, result.ducks), 1);
  const locked = { ...placements[0], locked: true, gainDb: -4, duration: .1 };
  const keep = planAutoMix({ duration: 6, events: [hit], assets, placements: [locked] });
  assert.equal(keep.placements[0].gainDb, -4, "locked manual edits survive automatic mixing");
  assert.equal(keep.placements[0].duration, .1);
  const eventLocked = planAutoMix({ duration: 6, events: [{ ...hit, locked: true }], assets, placements: [{ ...locked, locked: false }] });
  assert.equal(eventLocked.placements[0].gainDb, -4, "locking the whole event must also protect its clip levels");
  assert.equal(eventLocked.placements[0].duration, .1);
  assert.deepEqual(planAutoMix({ duration: 6, events: [hit, debris, music], assets, placements: result.placements }).placements, result.placements, "repeating a mix must not progressively reduce gains or extend clips");
  assert.deepEqual(placements, createPlacements([hit, debris, music], assets, 6).map((p,i) => ({...p,id:placements[i].id})), "the planner must not mutate its input timeline");
  const unknown = assets.map(a => { const copy = { ...a }; delete copy.rmsDb; return copy; });
  const first = planAutoMix({ duration: 6, events: [hit, debris, music], assets: unknown, placements });
  assert.deepEqual(planAutoMix({ duration: 6, events: [hit, debris, music], assets: unknown, placements: first.placements }).placements, first.placements, "missing source level measurements must not cause repeated attenuation");
}

export function testOrdinaryFootstepsStaySecondary() {
  const slam = cue({ id: "slam", type: "ground_slam", phase: "contact", category: "impact", actor: "boss", importance: "key",
    start: 2, end: 2.2, description: "Boss捶地", query: "boss ground slam", candidates: [{ assetId: "slam", score: 1, reason: "name" }] });
  const step = cue({ id: "step", type: "footstep", phase: "contact", category: "foley", actor: "player", importance: "key",
    start: 2.05, end: 2.2, description: "角色普通脚步落地", query: "player footstep", candidates: [{ assetId: "step", score: 1, reason: "name" }] });
  const assets = [asset("slam", "boss_ground_slam.wav"), asset("step", "player_footstep.wav")];
  const placements = createPlacements([slam, step], assets, 6);
  const mixed = planAutoMix({ duration: 6, events: [slam, step], assets, placements });
  const slamClip = mixed.placements.find(p => p.eventId === slam.id)!;
  const stepClip = mixed.placements.find(p => p.eventId === step.id)!;
  assert.equal(isForeground(step, stepClip, assets[1]), false, "ordinary footsteps must remain secondary even when a vision model overstates importance");
  assert.ok(slamClip.gainDb >= stepClip.gainDb + 8, "ordinary footsteps must sit clearly below the main contact");

  const genericStep = cue({ id: "generic-step", type: "player_move", phase: "motion", category: "foley", actor: "player", importance: "key",
    start: 3, end: 3.2, description: "角色普通移动，脚步落在地面", query: "body movement footstep", candidates: [{ assetId: "step", score: 1, reason: "name" }] });
  const genericPlacement = createPlacements([genericStep], assets, 6)[0];
  assert.equal(isForeground(genericStep, genericPlacement, assets[1]), false, "footstep cues hidden in a generic movement event must remain secondary");
}

export async function testAutoMixFork() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfx-auto-mix-"));
  try {
    const service = new SfxService(root);
    const source = await service.store.createRun({ videoPath: "v.mp4", libraryPath: root });
    source.duration = 6; source.status = "ready"; source.analysisMode = "ccswitch";
    source.analysisReport = { workflow: "temporal", model: "gemini-4-argon", windows: 1, refinedContacts: 1, timingNote: "Gemini timing" };
    source.assets = [asset("bad", "sword_foley_start.wav"), asset("good", "sword_foley_end.wav")];
    source.events = [cue({ candidates: [{ assetId: "bad", score: 100, reason: "old selection" }, { assetId: "good", score: 5, reason: "stage match" }] })];
    source.placements = [{ id: "old", eventId: "recovery", assetId: "bad", start: 1, duration: .1, sourceOffset: 0, gainDb: 0, fadeIn: 0, fadeOut: .01, category: "foley", enabled: true }];
    await service.store.save(source);
    const original = await fs.readFile(path.join(service.store.directory(source.id), "run.json"), "utf8");
    await assert.rejects(service.automix(source.id, { revision: 99, autoRender: false }), /更新/);
    const result = await service.automix(source.id, { revision: 0, autoRender: false });
    const next = await service.waitForIdle(result.runId);
    assert.equal(next.status, "ready");
    assert.notEqual(next.id, source.id);
    assert.equal(next.autoMix, true);
    assert.equal(next.placements[0].assetId, "bad", "mixing must preserve the user's actual asset choice even when the name needs review");
    assert.equal(next.placements[0].duration,.1,"mix-only keeps the existing source interval instead of making a new editing decision");
    assert.deepEqual(next.events.map(e => [e.start, e.end]), source.events.map(e => [e.start, e.end]), "auto mixing must preserve Gemini timing");
    assert.equal(await fs.readFile(path.join(service.store.directory(source.id), "run.json"), "utf8"), original);
    const usage = JSON.parse(await fs.readFile(path.join(service.store.directory(next.id), "usage-report.json"), "utf8"));
    assert.equal(usage.requests.length, 0, "mixing an existing Gemini timeline requires no new model tokens");
    assert.ok(usage.elapsedMs >= 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

export function testCharacterVocalPriority() {
  const roarAsset = asset("voice", "吼叫 [vo_apesstonehand_roar].wav", 3.1);
  roarAsset.rmsDb = -16.5; roarAsset.peakDb = 0;
  const reaction = cue({ id: "reaction", type: "boss_hit_react", category: "other", actor: "boss", start: 1, end: 1.7,
    phase: "aftermath", description: "巨猿受击后起身，张嘴咆哮", query: "ape roar", candidates: [{ assetId: "voice", score: 1, reason: "name" }] });
  const hit = cue({ id: "hit", type: "chest_pound", category: "impact", start: 1.1, end: 1.2, phase: "contact", description: "咆哮中捶胸", query: "chest impact", candidates: [{ assetId: "hit", score: 1, reason: "name" }] });
  const hit2 = { ...hit, id: "hit2", start: 1.3, end: 1.4 };
  const recovery = cue({ id: "recover", type: "boss_recover_stance", start: 4.2, end: 5.1, phase: "motion", description: "Boss咆哮后双臂下沉恢复俯身姿势", query: "armor movement", candidates: [{ assetId: "move", score: 1, reason: "name" }] });
  const music = cue({ id: "music", category: "music", type: "music_cue", start: 0, end: 6, query: "music", candidates: [{ assetId: "music", score: 1, reason: "name" }] });
  const assets = [roarAsset, asset("hit", "chest_impact.wav", .15), asset("move", "armor_movement.wav", .8), asset("music", "music_battle_loop.wav", 10)];
  const events = [reaction, hit, hit2, recovery, music];
  const placements = createPlacements(events, assets, 6);
  const before = structuredClone(placements);
  const mixed = planAutoMix({ events, assets, duration: 6, placements });
  const voice = mixed.placements.find(p => p.eventId === reaction.id)!;
  const move = mixed.placements.find(p => p.eventId === recovery.id)!;
  const musicClip = mixed.placements.find(p => p.eventId === music.id)!;
  assert.ok(voice.gainDb >= -8, "selected roar assets must not receive ordinary foley level plus crowding attenuation");
  assert.ok(voice.duration > .7 && voice.duration <= 1.05, "the roar preserves a brief release without an unrelated long continuation");
  assert.ok(voice.gainDb + roarAsset.rmsDb! > move.gainDb - 24 + 6, "a recovery that mentions a previous roar is still secondary movement");
  assert.ok(duckGainAt(musicClip, 1.8, mixed.ducks) <= .5, "background must leave room for the vocal phrase, not just its first half second");
  assert.deepEqual(placements, before);
  assert.deepEqual(planAutoMix({ events, assets, duration: 6, placements: mixed.placements }).placements, mixed.placements);
}

export function testBossLayerBudgetAndDenseChain() {
  const bossImpact = cue({ id: "boss-impact", actor: "boss", type: "ground_slam", category: "impact", phase: "contact",
    start: 1, end: 1.2, intensity: .95, description: "巨猿砸地，地面产生重击和碎石", query: "ape ground slam rock impact" });
  const layers = new LayerPlanner().planLayers(bossImpact);
  assert.ok(layers.length <= 2, "a large Boss contact gets one primary layer and at most one meaningful secondary layer");
  assert.ok(layers.filter(layer => layer.role === "texture" || layer.role === "tail").length <= 1,
    "a Boss contact must not default to both texture and tail");

  const second = { ...bossImpact, id: "boss-impact-2", start: 1.65, end: 1.85, query: "ape ground slam rock impact" };
  const index = { version: 1 as const, root: ".", generatedAt: "now", warnings: [], assets: [] };
  planAllEventCandidates([bossImpact, second], index);
  assert.ok((second.layers || []).every(layer => layer.role !== "texture" && layer.role !== "tail"),
    "dense consecutive Boss contacts keep their primary impacts but drop repeated decorative layers");

  const preplanned = cue({ id: "preplanned", actor: "boss", type: "ground_slam", category: "impact", phase: "contact",
    start: 5, end: 5.2, description: "巨猿砸地", query: "ape ground slam", layers: [
      { id: "main", role: "impact", query: "ape ground slam impact", offset: 0, candidates: [] },
      { id: "texture", role: "texture", query: "stone debris", offset: .08, candidates: [] },
      { id: "tail", role: "tail", query: "rock tail", offset: .18, candidates: [] }
    ] });
  planAllEventCandidates([preplanned], index);
  assert.ok((preplanned.layers || []).length <= 2, "Gemini-provided Boss layers are normalized to the same layer budget");
}

export function testWorkflowDensityReview() {
  const run = {
    id: "density-fixture", revision: 0, runStatus: "ready", status: "ready", progress: "ready", createdAt: "now", name: "density",
    videoPath: "video.mp4", libraryPath: ".", duration: 4, originalGainDb: -60, originalMuted: true, analysisMode: "ccswitch", warnings: [],
    scenes: [], assets: [], events: [], placements: [], autoMix: true,
    analysisReport: { workflow: "temporal", model: "gemini-4-argon", windows: 1, refinedContacts: 1, timingNote: "fixture" },
    mixReport: { workflow: "mix", extendedTails: 0, naturalTailClips: 0, adjustedClips: 0, peakConcurrency: 7, duckWindows: 1, targetLufs: -20, truePeakDb: -1.5 }
  } as never;
  const report = buildWorkflowReport(run);
  const density = report.quality.checks.find(check => check.id === "mix-density");
  assert.equal(density?.status, "review", "crowded foreground concurrency must be visible in the quality report");
}

export function testSelectiveAudioPolicy() {
  const certain = cue({ id: "certain", type: "weapon_handling", category: "foley", candidates: [{ assetId: "a", score: 10, reason: "name" }, { assetId: "b", score: 3, reason: "name" }] });
  const ambiguous = { ...certain, id: "ambiguous", candidates: [{ assetId: "a", score: 10, reason: "name" }, { assetId: "b", score: 9, reason: "name" }] };
  const key = { ...certain, id: "key", type: "player_charge", phase: "sustain" };
  const locked = { ...key, id: "locked", locked: true };
  assert.deepEqual(selectReviewEvents([certain, ambiguous, key, locked], "selective").map(e => e.id), ["ambiguous", "key"]);
  assert.deepEqual(selectReviewEvents([certain, ambiguous, key, locked], "full").map(e => e.id), ["certain", "ambiguous", "key"]);
  assert.equal(certain.candidates.length, 2, "policy must leave rule candidates for unreviewed actions intact");
}

export async function testGeminiTimingRequired() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfx-gemini-required-"));
  const previous = { cc: process.env.SFX_USE_CCSWITCH, gemini: process.env.SFX_USE_GEMINI, model: process.env.SFX_CCSWITCH_MODEL };
  try {
    process.env.SFX_USE_CCSWITCH = "0"; process.env.SFX_USE_GEMINI = "0";
    const video = path.join(root, "v.mp4"); await fs.writeFile(video, "unread video fixture");
    const service = new SfxService(path.join(root, "output"));
    await assert.rejects(
      service.create({ videoPath: video, libraryPath: root, analysisMode: "auto" }),
      (error: unknown) => error instanceof Error && (error as { status?: number }).status === 503 && /Gemini AI/.test(error.message),
      "automatic generation must fail before creating a long-running scan when Gemini is unavailable"
    );
    assert.equal((await service.store.list()).length, 0, "preflight failure must not leave a partial run");
    const config = path.join(root, "gateway.toml");
    await fs.writeFile(config, '[model_providers.custom]\nbase_url = "http://127.0.0.1:15721/v1"\n');
    process.env.SFX_CCSWITCH_MODEL = "gpt-fixture";
    await assert.rejects(readConfig(config), /必须使用 Gemini/);
    process.env.SFX_CCSWITCH_MODEL = "gemini-fixture";
    assert.equal((await readConfig(config)).model, "gemini-fixture");
  } finally {
    for (const [key,value] of [["SFX_USE_CCSWITCH",previous.cc],["SFX_USE_GEMINI",previous.gemini],["SFX_CCSWITCH_MODEL",previous.model]]) { if (value === undefined) delete process.env[key!]; else process.env[key!] = value; }
    await fs.rm(root, { recursive: true, force: true });
  }
}
