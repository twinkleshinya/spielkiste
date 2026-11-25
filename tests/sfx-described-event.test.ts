import {mock} from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { SfxService } from "../src/sfx/SfxService.js";
import { EventSchema, PlacementSchema } from "../src/sfx/models.js";
import { handleSfxRequest } from "../src/ui/sfx-routes.js";
import { planAutoMix } from "../src/sfx/AutoMix.js";

function makeAsset(file: string) {
  return {
    id: "bite-asset",
    path: file,
    relativePath: "bite/gorilla_bite.wav",
    fileName: "gorilla_bite.wav",
    size: 4,
    mtimeMs: 1,
    tags: ["gorilla", "bite"],
    duration: 1.2,
    channels: 1,
    sampleRate: 48000,
    usable: true,
    onset: 0,
    rmsDb: -18,
    peakDb: -4,
    acoustics: {
      version: 1 as const,
      fingerprint: "fixture",
      sampledStart: 0,
      sampledDuration: 1.2,
      energyEnd: .7,
      activeDuration: .7,
      centroid: 900,
      bands: [1, 1, 1],
      envelope: [1, .5, 0],
      label: "低沉的咬合冲击"
    }
  };
}

export async function testAddDescribedEventApiLocatesAndPreservesExistingTimeline(simulateLongWait = false, scenario?: "scoped" | "missing" | "filtered") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfx-described-event-"));
  const video = path.join(root, "source.mp4");
  const audio = path.join(root, "gorilla_bite.wav");
  await fs.writeFile(video, "video fixture");
  await fs.writeFile(audio, "audio fixture");
  const existingEvent = EventSchema.parse({
    id: "existing",
    start: .2,
    end: .8,
    type: "boss_roar",
    description: "猩猩咆哮",
    query: "gorilla roar",
    category: "other",
    confidence: .9,
    source: "vision",
    candidates: [{ assetId: "bite-asset", score: 1, reason: "fixture" }],
    requiresHumanReview: false
  });
  const existingPlacement = PlacementSchema.parse({
    id: "existing-placement",
    eventId: "existing",
    layerId: "main",
    role: "foley",
    assetId: "bite-asset",
    start: .2,
    duration: .6,
    sourceOffset: .1,
    gainDb: -20,
    fadeIn: .01,
    fadeOut: .08,
    category: "other",
    enabled: true,
    sourceEdit: { assetId: "bite-asset", sourceOffset: .1, duration: .6, basis: "manual", reason: "existing locked edit" }
  });
  const fakeMedia = {
    inspect: async () => ({ duration: 4, hasAudio: false }),
    scenes: async () => [],
    thumbnail: async () => undefined,
    sampleFrames: async (_file: string, start: number, end: number) => [{ start, end, thumbnail: "fixture.jpg" }]
  };
  const fakeTimingProvider = {
    locateEvents: async (_frames:any, _prompt:any, signal?:AbortSignal) => { if(simulateLongWait){mock.timers.tick(65*60000); const aborted=signal?.aborted; mock.timers.reset(); assert.equal(aborted,false,"processing past 65 minutes must remain active");} return ({ events: [{ start: 1, end: 2, type: "monster_bite", description: "猩猩张嘴啃咬角色", query: "gorilla bite jaw attack", category: "impact", confidence: .86, evidence: "看到猩猩张嘴接触角色", actor: "boss", phase: "contact" }] });},
    locateEvent: async () => ({ start: 1.25, end: 1.75, confidence: .95, evidence: "逐帧看到牙齿接触角色", timingPrecision: .033 })
  };
  const fakeSelector = {
    model: "test-gemini",
    async select(events: any[], index: any) {
      if (scenario === "scoped") {
        assert.equal(index.videoDescription, undefined, "historical exclusive description must not veto an explicit supplement");
        assert.match(index.soundRequirements, /猩猩啃咬角色/);
        assert.doesNotMatch(JSON.stringify(index.descriptionConstraints), /只要吼叫/);
        assert.equal(index.audioOutputMode, "sfx");
      }
      for (const event of events) for (const layer of event.layers || []) {
        layer.candidates = scenario === "missing" ? [] : [{ assetId: "bite-asset", score: 99, reason: "Gemini 听到低沉咬合冲击" }];
      }
      return {
        model: "test-gemini",
        status: "complete",
        analyzedAssets: 1,
        cachedAssets: 0,
        selectedLayers: events.reduce((sum: number, event: any) => sum + (event.layers?.length || 1), 0),
        rejectedLayers: 0,
        fallbackLayers: 0,
        warnings: [],
        decisions: [{ taskId: "new-event:main", eventIds: events.map((event: any) => event.id), assetId: "bite-asset", reason: "咬合冲击匹配", basis: "audio-context" }],
        audio: [{ assetId: "bite-asset", summary: "低沉咬合冲击", tags: ["bite"], energy: .8, hasMusic: false, hasSpeech: false }]
      };
    }
  };
  let renders = 0;
  const renderer = { renderPreview: async (run: any, outputDir: string) => {
    renders++;
    const videoOut = path.join(outputDir, "preview.mp4");
    const audioOut = path.join(outputDir, "preview.wav");
    await fs.copyFile(video, videoOut);
    await fs.copyFile(audio, audioOut);
    return { video: videoOut, audio: audioOut, revision: run.revision };
  }};
  const service = new SfxService(path.join(root, "output"), () => fakeSelector as any, () => fakeTimingProvider as any, () => fakeMedia as any, () => renderer);
  const source = await service.store.createRun({ videoPath: video, libraryPath: root, name: "described fixture" });
  Object.assign(source, {
    status: "ready",
    duration: 4,
    assets: [makeAsset(audio)],
    scenes: [{ start: 0, end: 4 }],
    events: [existingEvent],
    placements: [existingPlacement],
    render: { video, audio, revision: 0 }
  });
  if (scenario) Object.assign(source, {videoDescription:"只要吼叫", soundRequirements:"叫声轻一点", audioOutputMode:scenario === "filtered" ? "music" : "sfx", descriptionConstraints:{exclusive:true,restrictions:["只要吼叫"],requirements:[],conflicts:[]}});
  await service.store.save(source);
  const parent = await service.readRun(source.id);
  const parentEvent = structuredClone(parent.events[0]);
  const parentPlacement = structuredClone(parent.placements[0]);

  const server = http.createServer((req, res) => { void handleSfxRequest(req, res, new URL(req.url!, "http://localhost"), service); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    if(simulateLongWait)mock.timers.enable({apis:["Date","setTimeout","setInterval"]});
    const response = await fetch(`${base}/api/sfx/runs/${parent.id}/add-described-event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: parent.revision, description: "猩猩啃咬角色" })
    });
    assert.equal(response.status, 202, await response.clone().text());
    const result = await response.json() as { runId: string };
    assert.notEqual(result.runId, parent.id);
    const child = await service.waitForIdle(result.runId);
    if (scenario === "missing" || scenario === "filtered") {
      assert.equal(child.status, "failed", "empty or output-filtered supplement must not report success");
      assert.match(child.error || "", /未.*(?:音效|贴片|声音)|生成内容/);
      assert.equal(renders, 0, "do not render an unchanged preview and label it supplemented");
      assert.equal(child.render, undefined);
      assert.deepEqual(child.placements.filter(p=>p.id===existingPlacement.id), [parentPlacement]);
      return;
    }
    assert.equal(child.status, "ready", child.error);
    assert.equal(child.parentRunId, parent.id);
    assert.equal(child.events.length, 2);
    const bite = child.events.find(event => event.description.includes("啃咬"));
    assert.ok(bite);
    assert.equal(bite.start, 1.25);
    assert.equal(bite.end, 1.75);
    assert.equal(bite.source, "vision");
    assert.equal(bite.query, "gorilla bite jaw attack");
    assert.ok(child.placements.some(placement => placement.eventId === bite.id && placement.assetId === "bite-asset"));
    assert.deepEqual(child.events.find(event => event.id === existingEvent.id), parentEvent);
    assert.deepEqual(child.placements.find(placement => placement.id === existingPlacement.id), parentPlacement);
    assert.ok(child.render?.video);
    assert.match(child.progress, /1 个.*贴片/);
    const usage = JSON.parse(await fs.readFile(path.join(service.store.directory(child.id), "usage-report.json"), "utf8"));
    assert.equal(usage.operation, "add-described-event");
  } finally {
    if(simulateLongWait)mock.timers.reset();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
}

export async function testAddDescribedEventRejectsStaleRevision() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfx-described-stale-"));
  const video = path.join(root, "source.mp4");
  await fs.writeFile(video, "video fixture");
  const service = new SfxService(path.join(root, "output"));
  const source = await service.store.createRun({ videoPath: video, libraryPath: root, name: "stale fixture" });
  try {
    await assert.rejects(() => service.addDescribedEvent(source.id, { revision: 99, description: "猩猩啃咬角色" }), /任务已更新/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

export function testDescribedEventMixProtectsParentPlacements() {
  const asset = makeAsset("fixture.wav");
  const oldEvent = EventSchema.parse({ id: "old", start: .2, end: .8, type: "boss_roar", description: "旧咆哮", query: "roar", category: "other", confidence: .9, source: "vision", candidates: [], requiresHumanReview: false, importance: "key" });
  const newEvent = EventSchema.parse({ id: "new", start: 1, end: 1.6, type: "monster_bite", description: "啃咬", query: "gorilla bite", category: "impact", confidence: .9, source: "vision", candidates: [], requiresHumanReview: false, importance: "key", distance: { range: "far", confidence: .9, evidence: "远处" } });
  const oldPlacement = PlacementSchema.parse({ id: "old-placement", eventId: "old", assetId: asset.id, start: .2, duration: .6, sourceOffset: 0, gainDb: -20, fadeIn: .01, fadeOut: .08, category: "other", enabled: true, sourceEdit: { assetId: asset.id, sourceOffset: 0, duration: .6, basis: "manual", reason: "保留" } });
  const newPlacement = PlacementSchema.parse({ id: "new-placement", eventId: "new", assetId: asset.id, start: 1, duration: .6, sourceOffset: 0, gainDb: -6, fadeIn: .01, fadeOut: .08, category: "impact", enabled: true });
  const result = planAutoMix({ duration: 4, events: [oldEvent, newEvent], assets: [asset], placements: [oldPlacement, newPlacement], musicEnabled: true }, { preserveSourceEdits: true, preserveLevels: false, preservePlacementIds: new Set([oldPlacement.id]) });
  assert.equal(result.placements.find(p => p.id === oldPlacement.id)?.gainDb, oldPlacement.gainDb);
  assert.notEqual(result.placements.find(p => p.id === newPlacement.id)?.gainDb, newPlacement.gainDb);
}
