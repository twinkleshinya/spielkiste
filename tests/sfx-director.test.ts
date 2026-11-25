import assert from "node:assert/strict";
import { AudioLibraryIndexer, tokens } from "../src/sfx/AudioLibraryIndexer.js";
import { CategorySchema, CreateRunSchema, EventSchema, RunSchema, SoundEvent, AudioAsset } from "../src/sfx/models.js";
import { planEventCandidates } from "../src/sfx/CandidatePlanner.js";
import { createPlacements } from "../src/sfx/PlacementEngine.js";
import { mergeWindowEvents, temporalWindows, actionReviewWindows } from "../src/sfx/TemporalAnalysis.js";
import { analyzeTemporal } from "../src/sfx/TemporalAnalysis.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export async function testDirectorWorkflow() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfx-director-"));
  const seen: number[] = [];
  const media = { inspect: async () => ({ duration: 12, hasAudio: false }), scenes: async () => [], thumbnail: async () => undefined, sampleFrames: async (_v: string, start: number, end: number, fps: number) => Array.from({ length: Math.ceil((end - start) * fps) }, (_, i) => ({ start: start + i / fps, end: Math.min(end, start + (i + 1) / fps), thumbnail: "fixture.jpg" })) };
  const director = { analyzeFrames: async (frames: Array<{ start: number }>, prompt: string) => {
    seen.push(...frames.map(f => f.start));
    if (prompt.includes("逐帧复核")) return { visible: true, start: 11.7, end: 11.9, evidence: "首次碰撞帧", confidence: .9 };
    if (prompt.includes("先理解完整视频")) return { context: "战斗", events: [{ ...event({ start: 0, end: 12 }), category: "music", musicStage: "build", intensity: .6 }] };
    if (prompt.includes("短窗动作复查")) return { events: [], replaceEventIds: [] };
    return { events: frames.some(f => f.start > 11.5) ? [{ ...event({ start: 11.6, end: 11.9, type: "hit", category: "impact" }), phase: "contact" }] : [] };
  } };
  try {
    const result = await analyzeTemporal("fixture", 12, root, media, director);
    assert.ok(seen.some(t => t >= 11.8), "workflow must send the tail of the clip to the model");
    assert.equal(result.events.find(e => e.type === "hit")?.start, 11.7, "dense contact review must correct coarse timing");
    assert.equal(result.report.refinedContacts, 1);
    assert.ok(result.events.some(e => e.category === "music"));
    const abort = new AbortController(); abort.abort(new Error("cancelled"));
    const callsBefore = seen.length;
    await assert.rejects(analyzeTemporal("fixture", 12, root, media, director, { signal: abort.signal }), /cancelled/);
    assert.equal(seen.length, callsBefore, "cancelled jobs cannot make further model requests");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

const asset = (id: string, name: string, duration = 2): AudioAsset => ({ id, path: name, relativePath: name, fileName: name, duration, size: 100, mtimeMs: 1, tags: tokens(name), usable: true });
const event = (overrides: Partial<SoundEvent> = {}): SoundEvent => EventSchema.parse({ id: "e", start: 0, end: 1, type: "cast", description: "施法", query: "cast spell", category: "other", confidence: .8, source: "vision", candidates: [], requiresHumanReview: true, ...overrides });

export function testDirectorMusicSchema() {
  assert.ok(CategorySchema.safeParse("music").success, "music must be a first-class editable category");
  const input = CreateRunSchema.parse({ videoPath: "v.mp4", libraryPath: "library", musicEnabled: true, musicLibraryPath: "music" });
  assert.equal((input as any).musicLibraryPath, "music");
  const cue = EventSchema.parse({ ...event(), category: "music", musicStage: "climax", intensity: .85, evidence: "Boss 举起双臂", timingPrecision: .2 });
  assert.equal((cue as any).musicStage, "climax");
  assert.equal((cue as any).evidence, "Boss 举起双臂");
  assert.equal(RunSchema.safeParse({ version: 1, id: "old", name: "old", createdAt: "now", revision: 0, status: "ready", progress: "", videoPath: "v", libraryPath: "l", duration: 1, originalGainDb: 0, analysisMode: "scene", warnings: [], scenes: [], assets: [], events: [], placements: [] }).success, true, "legacy runs must remain readable");
}

export function testDirectorSemanticSafety() {
  const assets = [asset("hit", "efx_pc_gsword_com_sword_impact.wav"), asset("swing", "efx_pc_gsword_com_swish.wav"), asset("cast", "efx_apesstonehand_foley_cast.wav"), asset("wind", "amb_wind.wav"), asset("music", "music/boss_battle_loop.wav", 50)];
  const index = { version: 1 as const, root: ".", generatedAt: "now", assets, warnings: [] };
  const indexer = new AudioLibraryIndexer();
  assert.equal(indexer.search(index, "sword swing whoosh")[0]?.asset.id, "swing", "raw swish filename must outrank impact synonym pollution");
  assert.equal(indexer.search(index, "gorilla cast")[0]?.asset.id, "cast");
  const precise = { ...index, assets: [asset("wrong", "music/ForgottenBattlefield_CIN.wav", 30), asset("battle", "music/bgm_battle_boss_main.wav", 30), asset("drop", "Play_UI_Gold_Drop.wav"), asset("warn", "SFX_FB_IconWarning_01.wav")] };
  assert.equal(indexer.search(precise, "music boss battle")[0]?.asset.id, "battle", "battlefield names cannot outrank explicit battle music");
  assert.equal(indexer.search(precise, "ui warning")[0]?.asset.id, "warn", "UI warning cannot pick item drop just because it says UI");
  const missing = event({ query: "spaceship laser", description: "太空激光" });
  planEventCandidates(missing, index);
  assert.equal(missing.candidates.length, 0, "never fill an uncovered action with an unrelated file");
  const music = event({ category: "music" as never, query: "music boss battle" });
  planEventCandidates(music, { ...index, musicLibraryConfigured: true, assets: assets.map(a => a.id === "music" ? { ...a, musicOnly: true } : a) } as any);
  assert.equal(music.candidates[0]?.assetId, "music", "music must only select actual music assets");
  const empty = event({ category: "music" as never, query: "music battle" });
  planEventCandidates(empty, { ...index, assets: assets.filter(a => a.id !== "music") });
  assert.equal(empty.candidates.length, 0, "wind cannot stand in for missing music");
  const impact = event({ category: "impact", query: "sword impact" });
  planEventCandidates(impact, index);
  const placed = createPlacements([impact], assets, 10);
  assert.equal(new Set(placed.map(p => p.assetId)).size, placed.length, "same impact file cannot be tripled across layers");
  const rejected = event({ category: "impact", phase: "contact", confidence: .35, query: "sword impact", evidence: "密集帧未确认接触" });
  planEventCandidates(rejected, index);
  assert.equal(rejected.candidates.length, 0, "unconfirmed physical contact must remain a review gap");
  const warning = event({ type: "boss_skill_warning", actor: "boss", phase: "preparation", query: "skill cast warning red" });
  planEventCandidates(warning, precise);
  assert.equal(warning.candidates[0]?.assetId, "warn", "warning intent must override generic spell words");
  const raise = event({ type: "player_weapon_raise", actor: "player", phase: "motion", category: "foley", description: "玩家举起武器", query: "sword weapon foley" });
  planEventCandidates(raise, { ...index, assets: [asset("bad", "sword_foley_impact.wav"), asset("good", "sword_foley_ready.wav")] });
  assert.equal(raise.candidates[0]?.assetId, "good", "preparing a weapon cannot select a collision just because its name also says foley");
  const bodyShift = event({ type: "boss_stance_shift", actor: "boss", phase: "motion", category: "foley", description: "巨兽重心移动并转身", query: "heavy creature body shift" });
  planEventCandidates(bodyShift, { ...index, assets: [asset("movement", "efx_apesstonehand_bodyturn_movement_01.wav")] });
  assert.equal(bodyShift.candidates[0]?.assetId, "movement", "visible body movement must recall movement/bodyturn assets even when the model query says body shift");
  const prowl = event({ type: "boss_move", actor: "boss", phase: "motion", category: "foley", description: "巨兽低伏游走并迈步", query: "heavy monster prowl step" });
  planEventCandidates(prowl, { ...index, assets: [asset("movement", "efx_apesstonehand_bodyturn_movement_01.wav"), asset("footstep", "efx_yetuga_run_foley_01.wav")] });
  assert.ok(prowl.candidates.length, "prowl/step movement must recall a usable movement or footstep asset");
}

export function testMusicCandidatesRequireIndependentLibrary() {
  const assets = [asset("main-music", "main/bgm_battle_loop.wav", 30), { ...asset("music-library", "selected/bgm_battle_loop.wav", 30), musicOnly: true }];
  const musicEvent = event({ id: "music-independent", category: "music" as never, query: "music battle", description: "背景音乐" });
  planEventCandidates(musicEvent, { version: 1, root: ".", generatedAt: "now", assets, warnings: [], musicLibraryConfigured: true } as any);
  assert.deepEqual(musicEvent.candidates.map(candidate => candidate.assetId), ["music-library"], "music candidates must come only from the selected music library");
  const noLibrary = event({ id: "music-none", category: "music" as never, query: "music battle", description: "背景音乐" });
  planEventCandidates(noLibrary, { version: 1, root: ".", generatedAt: "now", assets: [assets[0]], warnings: [], musicLibraryConfigured: false } as any);
  assert.equal(noLibrary.candidates.length, 0, "music must stay empty when no independent music library is selected");
}

export function testDirectorContinuousPlacements() {
  const assets = [asset("wind", "amb_wind.wav", 2), asset("music", "music/boss_battle_loop.wav", 30)];
  const amb = event({ id: "amb", end: 8, category: "ambience", candidates: [{ assetId: "wind", score: 1, reason: "name" }] });
  const wind = createPlacements([amb], assets, 10);
  assert.equal((wind[0] as any).loop, true, "sustained beds must loop the short local asset");
  assert.equal(wind[0].duration, 8);
  const cues = [event({ id: "m1", start: 0, end: 5, category: "music" as never, candidates: [{ assetId: "music", score: 1, reason: "name" }] }), event({ id: "m2", start: 5, end: 10, category: "music" as never, candidates: [{ assetId: "music", score: 1, reason: "name" }] })];
  const placed = createPlacements(cues, assets, 10);
  assert.equal(placed[1]?.sourceOffset, 5, "adjacent musical cues must continue the same track");
  assert.ok(placed[0].fadeIn >= .1, "music entrance needs an audible fade");
}

export function testDirectorTemporalMerging() {
  const windows = temporalWindows(25.9);
  assert.equal(windows[0].start, 0);
  assert.equal(windows.at(-1)?.end, 25.9, "last seconds must never be dropped");
  assert.ok(windows.every((w, i) => i === 0 || w.start < windows[i - 1].end), "analysis windows must overlap");
  const a = event({ id: "a", start: 5.5, end: 5.8, type: "player_hit", category: "impact" });
  const duplicate = event({ ...a, id: "dupe", start: 5.6, end: 5.85, confidence: .9 });
  const next = event({ ...a, id: "next", start: 6.2, end: 6.4 });
  const otherActor = EventSchema.parse({ ...a, id: "boss", actor: "boss" });
  const player = EventSchema.parse({ ...a, actor: "player" });
  assert.equal(mergeWindowEvents([[a], [duplicate, next]]).length, 2, "merge overlap evidence while preserving a distinct follow-up hit");
  assert.equal(mergeWindowEvents([[player, otherActor]]).length, 2, "simultaneous actions by different actors remain distinct");
  const sameLand = event({ id: "land", start: 5.5, end: 5.8, type: "player_land", category: "foley", actor: "player", phase: "contact" });
  assert.equal(mergeWindowEvents([[sameLand], [{ ...sameLand, id: "land2", category: "impact" }]]).length, 1, "one landing cannot be doubled by category disagreement");
  const fast = event({ id: "first", start: 1, end: 1.3, type: "boss_chest_pound", actor: "boss", phase: "contact", category: "impact" });
  const fastNext = event({ ...fast, id: "second", start: 1.15, end: 1.45 });
  assert.equal(mergeWindowEvents([[fast, fastNext]]).length, 2, "distinct contacts from one window must survive even when sound tails overlap");
  assert.equal(mergeWindowEvents([[fast, fastNext], [{ ...fast, id: "copy", start: 1.01 }]]).length, 2, "cross-window evidence can match only one existing contact");
  const reviewWindows = actionReviewWindows(25.9);
  assert.equal(reviewWindows.at(-1)?.end, 25.9);
  assert.ok(reviewWindows.every(w => w.end - w.start <= 3.001), "dense action review must use short windows so recovery cannot hide a second attack");
}
