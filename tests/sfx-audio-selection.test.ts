import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GeminiAudioSelector, type AudioSelectionModel, type AudioSample, type SelectionTask } from "../src/sfx/GeminiAudioSelector.js";
import { AudioAsset, EventSchema, CreateRunSchema, RunSchema } from "../src/sfx/models.js";
import { createPlacements } from "../src/sfx/PlacementEngine.js";
import { SfxService } from "../src/sfx/SfxService.js";
import { AudioCandidateClips } from "../src/sfx/AudioCandidateClips.js";
import { planEventCandidates } from "../src/sfx/CandidatePlanner.js";
import { hasPronouncedPitchSweep } from "../src/sfx/AudioAcoustics.js";

export function testChargeCandidateStages() {
  const named = (id: string, fileName: string) => ({ ...asset(id), fileName, relativePath: fileName });
  const assets = [named("attack", "efx_gsword_weakatk_chargeatk.wav"), named("guard", "efx_pc_gsword_chargestrike_charge_guard.wav"), named("done", "efx_gsword_charge_done.wav"), named("loop", "efx_gsword_common_charge_loop.wav"), named("charge", "蓄力-大剑 [efx_gsword_common_charge_a].wav")];
  const event = EventSchema.parse({ ...cue("charge", []), type: "player_charge", category: "other", phase: "sustain", query: "skill charge loop", description: "架刀持续蓄力", layers: undefined });
  planEventCandidates(event, { version: 1, root: ".", generatedAt: "now", assets, warnings: [] });
  assert.equal(event.candidates[0]?.assetId, "loop", "sustained charge must prefer actual charge beds over charge attacks or guards");
  assert.ok(event.candidates.find(c => c.assetId === "loop")!.score > event.candidates.find(c => c.assetId === "done")!.score, "charge completion names should rank below the sustained bed without becoming forbidden");
  const oneShot = createPlacements([{ ...event, layers: [{ ...event.layers![0], candidates: [{ assetId: "charge", score: 1, reason: "name" }] }], end: 4 }], [{ ...assets[4], duration: 1 }], 6)[0];
  assert.notEqual(oneShot?.loop, true, "a short charge one-shot must not become repeated chirps by blind looping");
}

export async function testSelectionKeepsCompatibleBaseline() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfx-charge-baseline-"));
  try {
    const a = { ...asset("charge"), fileName: "efx_gsword_common_charge_loop.wav", relativePath: "efx_gsword_common_charge_loop.wav" };
    const e = EventSchema.parse({ ...cue("charge-event", [a.id]), type: "player_charge", category: "other", phase: "sustain", query: "skill charge loop" });
    const model: AudioSelectionModel = { model: "test", async describe(samples) { return { assets: samples.map(s => ({ assetId: s.assetId, summary: "不确定的噪声", tags: [], energy: .5, hasMusic: false, hasSpeech: false })) }; }, async choose(tasks) { return { choices: tasks.map(t => ({ taskId: t.taskId, assetId: null, reason: "听感不确定", confidence: .6 })) }; } };
    const clips = { async sample(a: AudioAsset) { return { assetId: a.id, data: "d2F2", format: "wav" as const, segments: [{ start: 0, end: 2 }] }; } };
    const previous = createPlacements([e], [a], 6);
    const options = { outputDir: root, cacheDir: path.join(root, "cache"), previousPlacements: previous };
    const report = await new GeminiAudioSelector(model, clips).select([e], { version: 1, root: ".", generatedAt: "now", assets: [a], warnings: [] }, options);
    assert.equal(e.layers![0].candidates[0]?.assetId, a.id, "uncertain reselection must retain a previously used compatible charge bed");
    assert.equal(report.fallbackLayers, 1, "retained source material must be disclosed as fallback, never as a fresh AI choice");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

export async function testUiSweepRejection() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfx-ui-sweep-"));
  try {
    const sr = 16000, count = sr / 2, wav = Buffer.alloc(44 + count * 2);
    wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(sr, 24); wav.writeUInt32LE(sr * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(count * 2, 40);
    for (let i = 0; i < count; i++) { const t = i / sr; wav.writeInt16LE(Math.round(9000 * Math.sin(2 * Math.PI * (1700 * t + 5500 * t * t))), 44 + i * 2); }
    const click = Buffer.from(wav);
    let random = 19;
    for (let i = 0; i < count; i++) { random = (random * 16807) % 2147483647; const t = i / sr, envelope = Math.exp(-Math.max(0, t - .1) * 90) * (t >= .1 ? 1 : 0); click.writeInt16LE(Math.round((random / 2147483647 - .5) * 12000 * envelope), 44 + i * 2); }
    assert.equal(hasPronouncedPitchSweep(click), false, "a broadband click with a quiet tail is not a sustained pitch sweep");
    const twoNotes = Buffer.from(wav);
    for (let i = 0; i < count; i++) { const t = i / sr; const hz = t < .08 ? 1750 : 3750; const active = t < .06 || t >= .1 && t < .16; twoNotes.writeInt16LE(active ? Math.round(9000 * Math.sin(2 * Math.PI * hz * t)) : 0, 44 + i * 2); }
    assert.equal(hasPronouncedPitchSweep(twoNotes), false, "two discrete short confirmation notes must not be rejected as a broad pitch sweep");
    const a = asset("sweep"); a.path = path.join(root, "ui-sweep.wav"); a.fileName = "UI_SelectButton.wav"; a.duration = .5; await fs.writeFile(a.path, wav);
    await new AudioCandidateClips().sample(a, false, root);
    const e = EventSchema.parse({ ...cue("ui", [a.id]), type: "ui_button_hide", actor: "ui", category: "other" });
    const model: AudioSelectionModel = { model: "test", async describe(samples) { return { assets: samples.map(s => ({ assetId: s.assetId, summary: "不带音高的咔哒", tags: [], energy: .5, hasMusic: false, hasSpeech: false })) }; }, async choose(tasks) { return { choices: tasks.map(t => ({ taskId: t.taskId, assetId: a.id, confidence: .9, reason: "合适" })) }; } };
    const report = await new GeminiAudioSelector(model, new AudioCandidateClips()).select([e], { version: 1, root, generatedAt: "now", assets: [a], warnings: [] }, { outputDir: root, cacheDir: path.join(root, "cache") });
    assert.equal(createPlacements([e], [a], 3).length, 0, "measured pronounced pitch sweep must not be inserted as a subtle UI hide click despite model miscaptioning");
    assert.ok(report.warnings.some(w => /扫频/.test(w)), "rejected sweep must be visible for review");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

const asset = (id: string, music = false): AudioAsset => ({ id, fileName: `${id}.wav`, relativePath: `${music ? "music/" : ""}${id}.wav`, path: `${id}.wav`, duration: music ? 40 : 2, size: 100, mtimeMs: 1, tags: [], usable: true, onset: 0, rmsDb: -20, peakDb: -3 });
const cue = (id: string, ids: string[], music = false, start = 0) => EventSchema.parse({ id, start, end: start + 2, type: music ? "music_cue" : "sword_hit", category: music ? "music" : "impact", actor: "player", phase: "contact", source: "vision", description: "持刀命中", query: "sword hit", confidence: .9, requiresHumanReview: true, candidates: ids.map(assetId => ({ assetId, score: 2, reason: "filename" })), layers: [{ id: `${id}-layer`, role: music ? "music" : "impact", query: "sword hit", offset: 0, candidates: ids.map(assetId => ({ assetId, score: 2, reason: "filename" })) }] });

export async function testGeminiNameAdviceOverride() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfx-name-advice-"));
  const assets = ["start", "end"].map(id => ({ ...asset(id), fileName: `sword_foley_${id}.wav`, relativePath: `sword_foley_${id}.wav` }));
  const event = EventSchema.parse({ ...cue("recovery", ["end", "start"]), type: "attack_end", category: "foley", phase: "aftermath", description: "攻击收势", query: "sword foley end", layers: [{ id: "main", role: "foley", query: "sword foley", offset: 0, candidates: ["end", "start"].map(assetId => ({ assetId, score: 1, reason: "name" })) }] });
  const model: AudioSelectionModel = { model: "test-gemini", async describe(samples) { return { assets: samples.map(s => ({ assetId: s.assetId, summary: "短促布料金属摩擦，平滑收尾", tags: [], energy: .4, hasMusic: false, hasSpeech: false })) }; }, async choose(tasks) {
    assert.ok(tasks[0].candidates.find(c => c.assetId === "start")?.nameAdvice?.warnings.length, "Gemini must receive the naming concern alongside acoustic evidence");
    return { choices: tasks.map(t => ({ taskId: t.taskId, assetId: "start", reason: "虽然名称含start，声音是短摩擦并收尾，适合收势", confidence: .9 })) };
  } };
  const clips = { async sample(a: AudioAsset) { return { assetId: a.id, data: "d2F2", format: "wav" as const, segments: [{ start: 0, end: 2 }] }; } };
  try {
    const report = await new GeminiAudioSelector(model, clips).select([event], { version: 1, root, generatedAt: "now", assets, warnings: [] }, { outputDir: root, cacheDir: path.join(root, "cache") });
    assert.equal(report.selectedLayers, 1);
    assert.equal(createPlacements([event], assets, 6)[0]?.assetId, "start", "acoustically justified Gemini exceptions must survive placement construction");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

export async function testGeminiAudioSelection() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfx-audio-choice-"));
  let described = 0;
  const model: AudioSelectionModel = {
    model: "test-gemini",
    async describe(samples: AudioSample[]) { described += samples.length; return { assets: samples.map(s => ({ assetId: s.assetId, summary: s.assetId === "hit-b" ? "短促金属接触，低频结实" : "轻柔长音", tags: ["metal"], energy: .7, hasMusic: s.assetId.startsWith("music"), hasSpeech: false })) }; },
    async choose(tasks: SelectionTask[]) { return { choices: tasks.map(t => ({ taskId: t.taskId, assetId: t.event.category === "music" ? "music-b" : "hit-b", reason: "实际声音瞬态和材质符合动作", confidence: .8 })) }; }
  };
  const clips = { async sample(a: AudioAsset) { return { assetId: a.id, data: "d2F2", format: "wav" as const, segments: [{ start: 0, end: 2 }] }; } };
  try {
    const events = [cue("e", ["hit-a", "hit-b"]), cue("m1", ["music-a", "music-b"], true), cue("m2", ["music-a", "music-b"], true, 2)];
    const index = { version: 1 as const, root: ".", generatedAt: "now", assets: [asset("hit-a"), asset("hit-b"), asset("music-a", true), asset("music-b", true)], warnings: [] };
    const selector = new GeminiAudioSelector(model, clips);
    const options = { outputDir: root, cacheDir: path.join(root, "cache") };
    const report = await selector.select(events, index, options);
    assert.equal(events[0].layers![0].candidates[0].assetId, "hit-b", "Gemini choice must replace filename-first ranking");
    assert.equal(events[1].layers![0].candidates[0].assetId, "music-b");
    assert.equal(events[2].layers![0].candidates[0].assetId, "music-b", "music cues must continue the selected song");
    assert.equal(report.analyzedAssets, 4);
    assert.match(events[0].candidates[0].reason, /Gemini/);
    const placed = createPlacements(events, index.assets, 8).filter(p => p.category === "music");
    assert.equal(placed[1].sourceOffset, 2, "AI choice must preserve continuous source offsets");
    const persisted = JSON.parse(await fs.readFile(path.join(root, "selection-report.json"), "utf8"));
    assert.equal(persisted.model, "test-gemini");
    await selector.select(events, index, options);
    assert.equal(described, 4, "unchanged audio descriptions should be cached");
    index.assets[0].mtimeMs = 2;
    await selector.select(events, index, options);
    assert.equal(described, 5, "modified file must invalidate the listening cache");
    model.reasoningEffort = "xhigh";
    await selector.select(events, index, options);
    assert.equal(described, 9, "Extreme High must not reuse descriptions generated at High");
    model.reasoningEffort = "high";
    await selector.select(events, index, options);
    assert.equal(described, 9, "switching back may reuse the matching High cache");
    const input = CreateRunSchema.parse({ videoPath: "v.mp4", libraryPath: "lib" });
    assert.equal(input.aiSelection, true);
    assert.ok(RunSchema.safeParse({ version: 1, id: "old", name: "old", createdAt: "now", revision: 0, status: "ready", progress: "", videoPath: "v", libraryPath: "l", duration: 1, originalGainDb: 0, analysisMode: "scene", warnings: [], scenes: [], assets: [], events: [], placements: [] }).success);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

export async function testGeminiAudioSelectionBoundaries() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfx-choice-boundaries-"));
  const clips = { async sample(a: AudioAsset) { return { assetId: a.id, data: "d2F2", format: "wav" as const, segments: [{ start: 0, end: 2 }] }; } };
  const events = [cue("reject", ["a", "b"]), cue("invalid", ["a", "b"], false, 3), cue("locked", ["a", "b"], false, 6)];
  events[2].locked = true;
  const index = { version: 1 as const, root: ".", generatedAt: "now", assets: [asset("a"), asset("b")], warnings: [] };
  let calls = 0;
  const model: AudioSelectionModel = { model: "test", async describe(samples) { calls++; return { assets: samples.map(s => ({ assetId: s.assetId, summary: "金属音", tags: [], energy: .5, hasMusic: false, hasSpeech: false })) }; }, async choose(tasks) { calls++; return { choices: tasks.map(t => ({ taskId: t.taskId, assetId: t.event.id === "reject" ? null : "invented", reason: "不适合", confidence: .9 })) }; } };
  try {
    const selector = new GeminiAudioSelector(model, clips);
    const report = await selector.select(events, index, { outputDir: root, cacheDir: path.join(root, "cache") });
    assert.equal(events[0].layers![0].candidates.length, 0, "explicit no-fit cannot silently select first candidate");
    assert.equal(events[1].layers![0].candidates[0].assetId, "a", "fabricated asset ID must not enter placements");
    assert.equal(events[2].layers![0].candidates[0].reason, "filename", "locked events must remain unchanged");
    assert.equal(report.rejectedLayers, 1);
    assert.equal(report.fallbackLayers, 1);
    assert.equal(report.decisions.find(d=>d.eventIds.includes("invalid"))?.assetId,"a","fallback evidence must identify the retained choice rather than implying silence");
    const before = calls;
    const abort = new AbortController(); abort.abort(new Error("cancelled"));
    await assert.rejects(selector.select(events, index, { outputDir: root, cacheDir: root, signal: abort.signal }), /cancelled/);
    assert.equal(calls, before, "cancelled selection cannot send audio");
    const broken = new GeminiAudioSelector({ ...model, async describe() { throw new Error("unsupported audio"); } }, clips);
    const fallback = [cue("e", ["a", "b"])];
    const failed = await broken.select(fallback, index, { outputDir: root, cacheDir: path.join(root, "empty-cache") });
    assert.equal(failed.status, "fallback");
    assert.equal(fallback[0].layers![0].candidates[0].assetId, "a");
    assert.equal(failed.analyzedAssets, 0);
    assert.ok(failed.warnings.length);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

export async function testGeminiAudioReselectRun() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfx-reselect-"));
  try {
    let described = 0;
    const model: AudioSelectionModel = { model: "test", async describe(samples) { described += samples.length; return { assets: samples.map(s => ({ assetId: s.assetId, summary: "金属冲击", tags: [], energy: .8, hasMusic: false, hasSpeech: false })) }; }, async choose(tasks) { return { choices: tasks.map(t => ({ taskId: t.taskId, assetId: "b", reason: "更符合金属命中", confidence: .8 })) }; } };
    const selector = () => new GeminiAudioSelector(model, { async sample(a) { Object.assign(a, { duration: 2, onset: 0, rmsDb: -20, peakDb: -3 }); return { assetId: a.id, data: "d2F2", format: "wav", segments: [{ start: 0, end: 2 }] }; } });
    const service = new SfxService(root, selector);
    const source = await service.store.createRun({ videoPath: "v.mp4", libraryPath: "library" });
    source.duration = 10; source.status = "ready"; source.assets = [asset("a"), asset("b")];
    for (const a of source.assets) {
      a.path = path.join(root, a.fileName); await fs.writeFile(a.path, "original audio fixture");
      const stat = await fs.stat(a.path); a.size = stat.size; a.mtimeMs = stat.mtimeMs;
    }
    source.events = [cue("editable", ["a", "b"], false, 1), cue("locked-placement", ["a", "b"], false, 5)];
    source.placements = createPlacements(source.events, source.assets, source.duration);
    source.placements[1].locked = true; source.placements[1].gainDb = -14;
    source.placements.push({ ...source.placements[1], id: "unlocked-tail", layerId: "tail", locked: false, gainDb: -22 });
    await service.store.save(source);
    const original = await fs.readFile(path.join(service.store.directory(source.id), "run.json"), "utf8");
    await assert.rejects(service.reselect(source.id, { revision: 99, autoRender: false }), /更新/);
    const result = await service.reselect(source.id, { revision: 0, autoRender: false });
    assert.notEqual(result.runId, source.id, "reselection creates a separate editable result");
    const next = await service.waitForIdle(result.runId);
    assert.equal(next.status, "ready");
    assert.deepEqual(next.events.map(e => [e.id, e.start, e.end]), source.events.map(e => [e.id, e.start, e.end]), "reselection cannot change recognized action points");
    assert.equal(next.placements.find(p => p.eventId === "editable")?.assetId, "b");
    assert.deepEqual(next.placements.find(p => p.eventId === "locked-placement"), source.placements[1], "locked placement must retain time, material and gain");
    assert.ok(next.placements.some(p => p.id === "unlocked-tail"), "preserving a locked event must not delete its other existing sound layers");
    assert.equal(await fs.readFile(path.join(service.store.directory(source.id), "run.json"), "utf8"), original, "source project must stay byte-identical");
    const exported = JSON.parse(await fs.readFile(path.join(service.store.directory(next.id), "placements.json"), "utf8"));
    assert.equal(exported.selectionReport.model, "test");
    assert.equal(described, 2);
    await fs.appendFile(source.assets[1].path, " changed audio");
    const rerun = await service.reselect(source.id, { revision: 0, autoRender: false });
    const refreshed = await service.waitForIdle(rerun.runId);
    assert.equal(refreshed.status, "ready");
    assert.equal(described, 3, "reselection must stat actual files and invalidate cached descriptions when source audio changes");
    assert.equal(refreshed.assets.find(a => a.id === "b")!.size, (await fs.stat(source.assets[1].path)).size);
    assert.equal(await fs.readFile(path.join(service.store.directory(source.id), "run.json"), "utf8"), original);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

export async function testGeminiAudioDistinctLayers() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfx-distinct-"));
  try {
    const e = cue("hit", ["a", "b"]);
    e.layers!.push({ ...structuredClone(e.layers![0]), id: "texture", role: "texture" });
    const model: AudioSelectionModel = { model: "test", async describe(samples) { return { assets: samples.map(s => ({ assetId: s.assetId, summary: "短促冲击", tags: [], energy: .5, hasMusic: false, hasSpeech: false })) }; }, async choose(tasks) { return { choices: tasks.map(t => ({ taskId: t.taskId, assetId: "a", reason: "合适", confidence: .8 })) }; } };
    const selector = new GeminiAudioSelector(model, { async sample(a) { return { assetId: a.id, data: "d2F2", format: "wav", segments: [{ start: 0, end: 2 }] }; } });
    await selector.select([e], { version: 1, root: ".", generatedAt: "now", assets: [asset("a"), asset("b")], warnings: [] }, { outputDir: root, cacheDir: path.join(root, "cache") });
    const placements = createPlacements([e], [asset("a"), asset("b")], 4);
    assert.equal(new Set(placements.map(p => p.assetId)).size, placements.length, "AI cannot duplicate the same sound across impact and decorative layers");
    for (const missing of [0, 1]) {
      const mixed = cue(`mixed-${missing}`, ["a", "b"]);
      mixed.layers!.push({ ...structuredClone(mixed.layers![0]), id: "tail", role: "tail" });
      const partial = { ...model, async choose(tasks: SelectionTask[]) { return { choices: tasks.filter((_, i) => i !== missing).map(t => ({ taskId: t.taskId, assetId: "a", reason: "合适", confidence: .8 })) }; } };
      const report = await new GeminiAudioSelector(partial, { async sample(a) { return { assetId: a.id, data: "d2F2", format: "wav", segments: [{ start: 0, end: 2 }] }; } }).select([mixed], { version: 1, root: ".", generatedAt: "now", assets: [asset("a"), asset("b")], warnings: [] }, { outputDir: root, cacheDir: path.join(root, "cache") });
      const mixedPlacements = createPlacements([mixed], [asset("a"), asset("b")], 4);
      assert.equal(report.fallbackLayers, 1);
      assert.equal(new Set(mixedPlacements.map(p => p.assetId)).size, mixedPlacements.length, "rule fallback and AI choices cannot repeat a file within one action");
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

export async function testGeminiCandidateOnset() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfx-candidate-onset-"));
  try {
    const sampleRate = 16000, frames = sampleRate * 2;
    const wav = Buffer.alloc(44 + frames * 2);
    wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(frames * 2, 40);
    for (let i = Math.round(.4 * sampleRate); i < frames; i++) wav.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * 440 * i / sampleRate)), 44 + i * 2);
    const a = asset("delayed"); a.path = path.join(root, "delayed.wav");
    delete a.duration; delete a.onset; delete a.rmsDb; delete a.peakDb;
    await fs.writeFile(a.path, wav);
    const sample = await new AudioCandidateClips().sample(a, false, root);
    assert.ok(a.onset! >= .38 && a.onset! <= .42, "new candidate must measure leading silence before sampling or placement");
    assert.ok(Number.isFinite(a.rmsDb) && Number.isFinite(a.peakDb), "AI selected alternatives must have measured mixing levels");
    assert.ok(sample.segments[0].start >= .38);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
