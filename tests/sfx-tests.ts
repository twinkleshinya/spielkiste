import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AudioLibraryIndexer, tokens } from "../src/sfx/AudioLibraryIndexer.js";
import { SfxVideoAnalyzer } from "../src/sfx/SfxVideoAnalyzer.js";
import { createPlacements } from "../src/sfx/PlacementEngine.js";
import { CreateRunSchema, EventSchema, PlacementSchema, SoundEvent, validateTimeline } from "../src/sfx/models.js";
import { SfxRunStore } from "../src/sfx/SfxRunStore.js";
import { SfxRenderer } from "../src/sfx/SfxRenderer.js";
import { execa } from "execa";
import http from "node:http";
import { SfxService } from "../src/sfx/SfxService.js";
import { handleSfxRequest } from "../src/ui/sfx-routes.js";
import { LayerPlanner } from "../src/sfx/LayerPlanner.js";
import { buildEventTimeline } from "../src/sfx/EventTimelineBuilder.js";
import { planEventCandidates } from "../src/sfx/CandidatePlanner.js";

export async function testSfxLibrary() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfx-library-"));
  try {
    await fs.mkdir(path.join(root, "doors"));
    await fs.writeFile(path.join(root, "doors", "wood_door_open.wav"), "fixture");
    await fs.writeFile(path.join(root, "rain.mp3"), "fixture");
    await fs.writeFile(path.join(root, "notes.txt"), "ignore");
    let probes = 0;
    const indexer = new AudioLibraryIndexer(async () => { probes++; return { duration: 2, channels: 2, sampleRate: 48000 }; }, { probeMetadata: true });
    const first = await indexer.indexDirectory(root);
    assert.equal(first.assets.length, 2);
    assert.equal(probes, 2);
    assert.match(first.assets.find(a => a.fileName.includes("door"))!.relativePath, /doors/);
    const second = await indexer.indexDirectory(root, first);
    assert.equal(probes, 2, "unchanged assets must reuse metadata");
    await fs.writeFile(path.join(root, "wind.wav"), "new sound");
    const third = await indexer.indexDirectory(root, second);
    assert.equal(probes, 3);
    assert.equal(third.assets.length, 3);
    assert.match(indexer.search(third, "木门 打开 wooden door opening", 3)[0].asset.fileName, /door/);
    assert.equal(indexer.search(third, "unrelated spaceship", 3).length, 0, "do not fill with unrelated sounds");
    await fs.unlink(path.join(root, "rain.mp3"));
    assert.equal((await indexer.indexDirectory(root, third)).assets.length, 2);
    const empty = path.join(root, "empty"); await fs.mkdir(empty);
    assert.equal((await indexer.indexDirectory(empty)).assets.length, 0);
    const broken = new AudioLibraryIndexer(async () => { throw new Error("bad audio"); }, { probeMetadata: true });
    const degraded = await broken.indexDirectory(root);
    assert.ok(degraded.warnings.length > 0);
    assert.equal(degraded.assets[0].usable, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

export function testSfxActionCoverageAndSemanticMatching() {
  const assets = [
    { id: "sword", path: "sword_whoosh.wav", relativePath: "sword_whoosh.wav", fileName: "sword_whoosh.wav", size: 1, mtimeMs: 1, tags: ["sword", "whoosh"], usable: true, duration: 1 },
    { id: "rock", path: "debris_rock_throw.wav", relativePath: "debris_rock_throw.wav", fileName: "debris_rock_throw.wav", size: 1, mtimeMs: 1, tags: ["debris", "rock", "throw"], usable: true, duration: 1 },
    { id: "wind", path: "ambience_wind.wav", relativePath: "ambience_wind.wav", fileName: "ambience_wind.wav", size: 1, mtimeMs: 1, tags: ["ambience", "wind"], usable: true, duration: 2 }
  ];
  const index = { version: 1 as const, root: ".", generatedAt: new Date().toISOString(), assets, warnings: [] };
  const event: SoundEvent = { id: "throw", start: 1, end: 2, description: "巨猿投掷巨石", query: "giant boulder flying whoosh", category: "whoosh", confidence: .4, type: "rock_throw", source: "vision", candidates: [], requiresHumanReview: true };
  planEventCandidates(event, index);
  assert.ok(event.layers?.[0]?.candidates.length, "every visible action must get at least one candidate");
  assert.equal(event.layers?.[0]?.candidates[0]?.assetId, "rock", "rock action must outrank generic sword whoosh");

  const ambience: SoundEvent = { id: "amb", start: 0, end: 10, description: "全片环境", query: "ambience wind", category: "ambience", confidence: .4, type: "ambience", source: "vision", candidates: [], requiresHumanReview: true };
  planEventCandidates(ambience, index);
  assert.ok(ambience.layers?.[0]?.candidates.length);
  assert.equal(ambience.layers?.[0]?.candidates[0]?.assetId, "wind");
}

export async function testSfxLazyLibrary() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfx-lazy-"));
  try {
    for (let i = 0; i < 80; i++) await fs.writeFile(path.join(root, "impact_" + String(i).padStart(3, "0") + ".wav"), "metadata deferred");
    let probes = 0;
    const index = await new AudioLibraryIndexer(async () => { probes++; return { duration: 2 }; }).indexDirectory(root);
    assert.equal(index.assets.length, 80);
    assert.equal(probes, 0, "default indexing must not launch one FFprobe process per asset");
    const cancelled = new AbortController(); cancelled.abort(new Error("scan cancelled"));
    await assert.rejects(new AudioLibraryIndexer().indexDirectory(root, undefined, undefined, cancelled.signal), /scan cancelled/);
    assert.equal(index.assets.every(asset => asset.usable && asset.duration === undefined), true);
    const candidate = new AudioLibraryIndexer().search(index, "impact", 1)[0];
    const event: SoundEvent = { id: "lazy-event", start: 0, end: 0.4, description: "延迟 metadata", query: "impact", category: "impact", confidence: 1, type: "manual", source: "manual", candidates: [{ assetId: candidate.asset.id, score: 1, reason: "filename" }], requiresHumanReview: false };
    const placements = createPlacements([event], index.assets, 1);
    assert.equal(placements.length, 1, "unknown asset duration must still produce an editable placement");
    assert.equal(placements[0].duration, 0.4);
    validateTimeline({ duration: 1, assets: index.assets }, [event], placements);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

export async function testSfxApi() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfx-api-"));
  const service = new SfxService(path.join(root, "output"));
  const server = http.createServer(async (req, res) => {
    if (!await handleSfxRequest(req, res, new URL(req.url!, "http://localhost"), service)) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number }; const base = `http://127.0.0.1:${address.port}`;
  const post = (url: string, body: unknown) => fetch(base + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal((await post("/api/sfx/runs", {})).status, 400);
    assert.equal((await fetch(base + "/api/sfx/runs", { headers: { origin: "http://evil.example" } })).status, 403);
    const video = path.join(root, "video.mp4");
    await execa("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=160x90:d=2", "-c:v", "libx264", video]);
    await execa("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=duration=1", path.join(root, "door_open.wav")]);
    const created = await post("/api/sfx/runs", { videoPath: video, libraryPath: root, analysisMode: "scene" });
    assert.equal(created.status, 202); const { runId } = await created.json() as { runId: string };
    let run = await service.waitForIdle(runId);
    assert.equal(run.status, "ready"); assert.ok(run.events.length > 0); assert.equal(run.placements.length, 0);
    const emptyRender = await post(`/api/sfx/runs/${runId}/render`, {});
    assert.equal(emptyRender.status, 202, "an empty edited timeline must allow a playable preview");
    run=await service.waitForIdle(runId);assert.equal(run.status,"ready",run.error);
    assert.equal((await fetch(base + `/api/sfx/runs/${runId}`)).status, 200);
    const event = { ...run.events[0], query: "door open", description: "开门", category: "foley", source: "manual", requiresHumanReview: false };
    const searched = await post(`/api/sfx/runs/${runId}/search`, { query: "开门" });
    const choices = await searched.json() as Array<{assetId: string; asset: { duration: number }}>; assert.equal(choices.length, 1);
    assert.equal(choices[0].asset.duration, 1, "search must return hydrated metadata for the browser chooser");
    const statusResponse = await fetch(base + `/api/sfx/runs/${runId}/status`);
    assert.equal(statusResponse.status, 200, "polling must not repeatedly transfer the complete large audio index");
    const compact = await statusResponse.json() as { status: string; assets?: unknown };
    assert.equal(compact.status, "ready"); assert.equal(compact.assets, undefined);
    assert.equal((await service.readRun(runId)).assets.find(a => a.id === choices[0].assetId)!.duration, undefined,"search must return metadata without rewriting the saved project");
    const deferred = await service.readRun(runId);
    delete deferred.assets[0].duration;
    deferred.placements = [{ id: "deferred", eventId: deferred.events[0].id, assetId: deferred.assets[0].id, start: 0, duration: 2, sourceOffset: 0, gainDb: -6, fadeIn: 0.01, fadeOut: 0.05, category: "foley", enabled: true }];
    await service.store.save(deferred);
    const shortSearch = await post(`/api/sfx/runs/${runId}/search`, { query: "door open" });
    assert.equal(shortSearch.status, 200, "hydration must not invalidate existing deferred placements");
    run = await service.readRun(runId);
    assert.equal(run.placements[0].duration, 2,"search cannot shorten an existing clip without an explicit edit");
    const payload = { revision: run.revision, originalGainDb: -3, events: [event], placements: [{ id: "p1", eventId: event.id, assetId: choices[0].assetId, start: 0.5, duration: 1, sourceOffset: 0, gainDb: -6, fadeIn: 0.01, fadeOut: 0.05, category: "foley", enabled: true }] };
    assert.equal((await post(`/api/sfx/runs/${runId}/placements`, { ...payload, placements: [{ ...payload.placements[0], start: 9 }] })).status, 400);
    assert.equal((await post(`/api/sfx/runs/${runId}/placements`, payload)).status, 200);
    assert.equal((await post(`/api/sfx/runs/${runId}/placements`, payload)).status, 409);
    const media = await fetch(base + `/api/sfx/runs/${runId}/media/video`, { headers: { range: "bytes=0-9" } });
    assert.equal(media.status, 206); assert.equal((await media.arrayBuffer()).byteLength, 10);
    assert.equal((await fetch(base + `/api/sfx/runs/${runId}/media/video`, { headers: { range: "bytes=999999999-" } })).status, 416);
    assert.equal((await post(`/api/sfx/runs/${runId}/render`, {})).status, 202);
    run = await service.waitForIdle(runId); assert.equal(run.status, "ready"); assert.ok(run.render);
    const exported = await fetch(base + `/api/sfx/runs/${runId}/export/json`); assert.equal(exported.status, 200);
    const data = await exported.json() as { placements: Array<{assetPath: string}> }; assert.match(data.placements[0].assetPath, /door_open/);
    const preview = await fetch(base + `/api/sfx/runs/${runId}/media/preview`); assert.equal(preview.status, 200); await preview.arrayBuffer();
    const reopened = new SfxService(path.join(root, "output")); assert.equal((await reopened.readRun(runId)).placements.length, 1);
    // A storage error while reporting a worker failure must be observed, not an unhandled rejection.
    const failing = new SfxService(path.join(root, "failing"));
    const normalSave = failing.store.save.bind(failing.store); let saves = 0;
    failing.store.save = async value => { saves++; if (saves > 1) throw new Error("disk unavailable"); await normalSave(value); };
    const failed = await failing.create({ videoPath: video, libraryPath: root, analysisMode: "scene" });
    await failing.waitForIdle(failed.runId);
    assert.ok((await failing.readRun(failed.runId)).error?.includes("disk unavailable"));
    const pendingRun = await service.store.createRun({ videoPath: video, libraryPath: root, name: "interrupted", analysisMode: "scene" });
    assert.equal((await service.readRun(pendingRun.id)).status, "failed");
    await fs.writeFile(path.join(root, "broken_unique.wav"), "not an audio file");
    const badIndex = await new AudioLibraryIndexer().indexDirectory(root);
    const brokenRun = await service.readRun(runId);
    const broken = badIndex.assets.find(a => a.fileName === "broken_unique.wav")!;
    brokenRun.assets.push(broken); await service.store.save(brokenRun);
    const unusable = await (await post(`/api/sfx/runs/${runId}/search`, { query: "broken_unique" })).json() as Array<{asset: {usable: boolean; warning?: string}}>;
    assert.equal(unusable[0].asset.usable, false); assert.ok(unusable[0].asset.warning);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await fs.rm(root, { recursive: true, force: true }); }
}

export async function testSfxRendering() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfx-render-"));
  try {
    const video = path.join(root, "silent video.mp4"); const audio = path.join(root, "tone, 音效.wav");
    await execa("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=24:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", video]);
    await execa("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", audio]);
    const index = await new AudioLibraryIndexer().indexDirectory(root);
    const asset = index.assets[0];
    const event: SoundEvent = { id: "evt", start: 0.5, end: 1.5, description: "测试", query: "tone", category: "impact", confidence: 1, type: "test", source: "manual", candidates: [{ assetId: asset.id, score: 1, reason: "test" }], requiresHumanReview: false };
    const placements = createPlacements([event], index.assets, 2);
    const store = new SfxRunStore(path.join(root, "runs"));
    let run = await store.createRun({ videoPath: video, libraryPath: root, name: "test", analysisMode: "scene" });
    run = { ...run, duration: 2, assets: index.assets, events: [event], placements, status: "ready" };
    await store.save(run);
    assert.deepEqual((await store.readRun(run.id)).placements, placements);
    await assert.rejects(store.readRun("../escape"));
    const outputDir = store.directory(run.id);
    const result = await new SfxRenderer().renderPreview(run, outputDir);
    const { stdout } = await execa("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", result.video]);
    const meta = JSON.parse(stdout); assert.ok(meta.streams.some((s: {codec_type: string}) => s.codec_type === "audio"));
    assert.ok(Math.abs(Number(meta.format.duration) - 2) < 0.15);
    const { stderr } = await execa("ffmpeg", ["-hide_banner", "-i", result.audio, "-af", "volumedetect", "-f", "null", "-"]);
    assert.doesNotMatch(stderr, /max_volume: -inf/, "enabled sound must be audible");
    const before = await execa("ffmpeg", ["-hide_banner", "-i", result.audio, "-af", "atrim=start=0:end=0.4,volumedetect", "-f", "null", "-"]);
    assert.match(before.stderr, /max_volume: -91| -inf/, "sound must not start before placement time");
    const during = await execa("ffmpeg", ["-hide_banner", "-i", result.audio, "-af", "atrim=start=0.6:end=0.9,volumedetect", "-f", "null", "-"]);
    assert.doesNotMatch(during.stderr, /max_volume: -91| -inf/, "sound must be audible at placement time");
    const disabled = await new SfxRenderer().renderPreview({ ...run, placements: placements.map(p => ({ ...p, enabled: false })) }, outputDir);
    const silence = await execa("ffmpeg", ["-hide_banner", "-i", disabled.audio, "-af", "volumedetect", "-f", "null", "-"]);
    assert.match(silence.stderr, /max_volume: -91| -inf/);
    const csv = await fs.readFile(path.join(outputDir, "placements.csv"), "utf8");
    assert.match(csv, /eventId,layerId,role,start,end/); assert.ok(csv.includes("tone, 音效.wav"));
    assert.equal(JSON.parse(await fs.readFile(path.join(outputDir, "placements.json"), "utf8")).placements[0].assetPath, audio);
    const voiced = path.join(root, "original-audio.mp4");
    await execa("ffmpeg", ["-v", "error", "-y", "-i", video, "-stream_loop", "-1", "-i", audio, "-map", "0:v:0", "-map", "1:a:0", "-t", "2", "-c:v", "copy", "-c:a", "aac", voiced]);
    const originalOnly = await new SfxRenderer().renderPreview({ ...run, videoPath: voiced, placements: [] }, outputDir);
    const originalVolume = await execa("ffmpeg", ["-hide_banner", "-i", originalOnly.audio, "-af", "volumedetect", "-f", "null", "-"]);
    assert.doesNotMatch(originalVolume.stderr, /max_volume: -91| -inf/, "original audio must be retained when there are no placements");
    await assert.rejects(new SfxRenderer().renderPreview({ ...run, videoPath: path.join(root, "missing.mp4") }, outputDir), /视频读取失败/);
    const dcAudio = path.join(root, "positive.wav"); const negativeVideo = path.join(root, "negative.mkv");
    await execa("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "aevalsrc=0.8:d=1:s=48000", "-c:a", "pcm_f32le", dcAudio]);
    await execa("ffmpeg", ["-v", "error", "-y", "-i", video, "-f", "lavfi", "-i", "aevalsrc=-0.8:d=2:s=48000", "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "pcm_f32le", negativeVideo]);
    const loudAssets = [{ ...asset, path: dcAudio, duration: 1 }];
    const loud = { ...placements[0], gainDb: 0, fadeIn: 0, fadeOut: 0 };
    const cancellation = await new SfxRenderer().renderPreview({ ...run, autoMix: false, videoPath: negativeVideo, assets: loudAssets, placements: [loud, { ...loud, id: "second" }] }, outputDir);
    const level = await execa("ffmpeg", ["-hide_banner", "-i", cancellation.audio, "-af", "atrim=start=0.7:end=0.8,volumedetect", "-f", "null", "-"]);
    const peak = Number(/max_volume: ([-\d.]+)/.exec(level.stderr)?.[1]);
    assert.ok(peak > -6, `intermediate mix must retain floating-point headroom and zero fades must preserve level, got ${peak} dB`);
    const musicEvent = EventSchema.parse({ ...event, id: "music", start: 0, end: 2, category: "music", type: "music_cue", musicStage: "build", intensity: .7 });
    const musicAsset = { ...asset, duration: 1 };
    const musicPlacement = PlacementSchema.parse({ ...placements[0], id: "music", eventId: "music", role: "music", category: "music", start: 0, duration: 2, sourceOffset: 0, gainDb: -6, fadeIn: .05, fadeOut: .1, loop: true });
    const musicalRun = { ...run, assets: [musicAsset], events: [musicEvent, event], placements: [musicPlacement] };
    const score = await new SfxRenderer().renderPreview(musicalRun, outputDir);
    const loopLevel = await execa("ffmpeg", ["-hide_banner", "-i", score.audio, "-af", "atrim=start=1.6:end=1.8,volumedetect", "-f", "null", "-"]);
    assert.doesNotMatch(loopLevel.stderr, /max_volume: -91| -inf/, "short local music must continue through its cue interval");
    const mutedScore = await new SfxRenderer().renderPreview({ ...musicalRun, musicEnabled: false }, outputDir);
    const mutedLevel = await execa("ffmpeg", ["-hide_banner", "-i", mutedScore.audio, "-af", "volumedetect", "-f", "null", "-"]);
    assert.match(mutedLevel.stderr, /max_volume: -91| -inf/, "music master switch must remove music from the render");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

export async function testSfxAnalysis() {
  const media = { inspect: async () => ({ duration: 6, hasAudio: false }), scenes: async () => [2.12345, 2.13, 4], thumbnail: async () => undefined };
  const fallback = await new SfxVideoAnalyzer(media).analyze("fixture.mp4", ".");
  assert.equal(fallback.mode, "scene");
  assert.equal(fallback.scenes.length, 3);
  assert.equal(fallback.events.length, 3);
  assert.equal(fallback.events[0].end, 2.123);
  assert.ok(fallback.events.every(e => e.source === "scene" && e.requiresHumanReview && e.query === ""));
  assert.ok(fallback.warnings.some(w => w.includes("动作")));
  const provider = { describe: async (scenes: unknown) => [{ start: 0.51234, end: 1.5, description: "打开木门", query: "wood door open", type: "door_open", category: "foley", confidence: 0.8 }] };
  const vision = await new SfxVideoAnalyzer(media, provider).analyze("fixture.mp4", ".");
  assert.equal(vision.mode, "ollama");
  assert.equal(vision.events[0].start, 0.512);
  assert.equal(vision.events[0].source, "vision");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfx-analysis-"));
  try {
    await fs.writeFile(path.join(root, "wood_door_open.wav"), "fixture");
    const index = await new AudioLibraryIndexer(async () => ({ duration: 2 }), { probeMetadata: true }).indexDirectory(root);
    const e = vision.events[0]; const choices = new AudioLibraryIndexer().search(index, e.query);
    e.candidates = choices.map(c => ({ assetId: c.asset.id, score: c.score, reason: c.reason }));
    const placements = createPlacements([e], index.assets, 6);
    assert.equal(placements.length, 1); assert.equal(placements[0].gainDb, -6);
    assert.equal(placements[0].enabled, true);
    assert.equal(createPlacements(fallback.events, index.assets, 6).length, 0);
    validateTimeline({ duration: 6, assets: index.assets }, [e], placements);
    assert.throws(() => validateTimeline({ duration: 1, assets: index.assets }, [e], placements));
    assert.equal(EventSchema.safeParse({ ...e, end: -1 }).success, false);
    assert.equal(PlacementSchema.safeParse({ ...placements[0], duration: 0 }).success, false);
    assert.throws(() => validateTimeline({ duration: 6, assets: index.assets }, [e], [{ ...placements[0], fadeIn: 8 }]));
    const brokenProvider = { describe: async () => { throw new Error("model offline"); } };
    const degraded = await new SfxVideoAnalyzer(media, brokenProvider).analyze("fixture.mp4", ".");
    assert.equal(degraded.mode, "scene"); assert.ok(degraded.warnings.some(w => w.includes("model offline")));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

export function testSfxMultilayer() {
  const event = { id: "evt", start: 1, end: 2, type: "impact", description: "金属击中木头", query: "metal hit wood", category: "impact", confidence: .8, source: "manual", candidates: [], requiresHumanReview: true };
  const layers = new LayerPlanner().planLayers(event as never);
  assert.deepEqual(layers.map(layer => layer.role), ["impact", "texture"]);
  assert.equal(layers[1].offset, .08);
  const events = buildEventTimeline({ duration: 25.9, scenes: [{ start: 0, end: 5 }, { start: 5, end: 12 }, { start: 12, end: 20 }, { start: 20, end: 25.9 }] }, { includeReviewEvents: true });
  assert.ok(events.length >= 3);
  assert.ok(events.some(e => e.category === "ambience"));
  assert.ok(events.every(e => (e.layers || []).length >= 1));
  const locked = { ...events[0], locked: true, start: 3, end: 4 };
  const rebuilt = buildEventTimeline({ duration: 25.9, scenes: [{ start: 0, end: 5 }, { start: 5, end: 12 }, { start: 12, end: 20 }, { start: 20, end: 25.9 }] }, { includeReviewEvents: true, previous: [locked] });
  assert.equal(rebuilt.find(e => e.id === locked.id)?.start, 3);
  const assets = [{ id: "a", path: "a.wav", relativePath: "a.wav", fileName: "a.wav", size: 1, mtimeMs: 1, tags: ["ambience", "whoosh"], usable: true, duration: 2 }];
  for (const item of events) for (const layer of item.layers || []) layer.candidates = [{ assetId: "a", score: 1, reason: "test" }];
  const placements = createPlacements(events, assets, 25.9);
  assert.ok(placements.length >= 1);
}

export function testSfxAutoModeSchema() {
  const parsed = CreateRunSchema.parse({ videoPath: "C:/video.mp4", libraryPath: "E:/M98/整理版" });
  assert.equal(parsed.analysisMode, "auto");
  const explicit = CreateRunSchema.parse({ videoPath: "C:/video.mp4", libraryPath: "E:/M98/整理版", analysisMode: "auto" });
  assert.equal(explicit.analysisMode, "auto");
}
