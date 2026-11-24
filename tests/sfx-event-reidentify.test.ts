import {mock} from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { SfxService } from "../src/sfx/SfxService.js";
import { EventSchema, PlacementSchema } from "../src/sfx/models.js";
import { handleSfxRequest } from "../src/ui/sfx-routes.js";
import { applyEventTiming } from "../src/sfx/EventTiming.js";

const makeEvent = () => EventSchema.parse({
  id: "event",
  start: .2,
  end: .8,
  type: "impact",
  description: "原始动作",
  query: "impact",
  category: "impact",
  confidence: .6,
  source: "vision",
  candidates: [],
  requiresHumanReview: true,
  evidence: "旧证据",
  timingPrecision: .2
});

const makePlacement = () => PlacementSchema.parse({
  id: "clip",
  eventId: "event",
  layerId: "main",
  role: "impact",
  assetId: "asset",
  start: .2,
  duration: .6,
  sourceOffset: .13,
  gainDb: -8,
  fadeIn: .01,
  fadeOut: .08,
  category: "impact",
  enabled: true,
  sourceEdit: { assetId: "asset", sourceOffset: .13, duration: .6, basis: "manual", reason: "保留原段落" },
  perspective: { version: 1, range: "far", importance: "key", basis: "visual", distanceGainDb: -10 }
});

export function testApplyEventTimingPreservesPlacementSettings() {
  const event = makeEvent();
  const placement = makePlacement();
  const result = applyEventTiming(event, [placement], {
    start: 1.4,
    end: 2.1,
    confidence: .94,
    evidence: "动作在 1.4 秒开始，2.1 秒结束",
    timingPrecision: .033
  }, 4);
  assert.equal(result.event.start, 1.4);
  assert.equal(result.event.end, 2.1);
  assert.equal(result.event.confidence, .94);
  assert.equal(result.event.evidence, "动作在 1.4 秒开始，2.1 秒结束");
  assert.equal(result.event.requiresHumanReview, false);
  assert.equal(result.placements[0].start, 1.4);
  assert.equal(result.placements[0].duration, .6);
  assert.equal(result.placements[0].assetId, "asset");
  assert.equal(result.placements[0].sourceOffset, .13);
  assert.equal(result.placements[0].gainDb, -8);
  assert.equal(result.placements[0].fadeIn, .01);
  assert.equal(result.placements[0].fadeOut, .08);
  assert.deepEqual(result.placements[0].sourceEdit, placement.sourceEdit);
  assert.deepEqual(result.placements[0].perspective, placement.perspective);
}

export async function testLocateEventApiPreservesParentAndUsesOnlyTiming(simulateLongWait = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfx-event-reidentify-"));
  const video = path.join(root, "source.mp4");
  const audio = path.join(root, "tone.wav");
  await fs.writeFile(video, "video fixture");
  await fs.writeFile(audio, "audio fixture");
  const fakeMedia = {
    inspect: async () => ({ duration: 4, hasAudio: false }),
    scenes: async () => [],
    thumbnail: async () => undefined,
    sampleFrames: async (_file: string, start: number, end: number) => [{ start, end, thumbnail: "fixture.jpg" }]
  };
  const fakeTimingProvider = {
    locateEvent: async (_frames:any, _prompt:any, signal?:AbortSignal) => { if(simulateLongWait){mock.timers.tick(65*60000); const aborted=signal?.aborted; mock.timers.reset(); assert.equal(aborted,false,"processing past 65 minutes must remain active");} return ({ start: 1.4, end: 2.1, confidence: .94, evidence: "看到动作实际接触", timingPrecision: .033 });}
  };
  const renderer = { renderPreview: async (run: any, outputDir: string) => {
    const videoOut = path.join(outputDir, "preview.mp4");
    const audioOut = path.join(outputDir, "preview.wav");
    await fs.copyFile(video, videoOut);
    await fs.copyFile(audio, audioOut);
    return { video: videoOut, audio: audioOut, revision: run.revision };
  }};
  const service = new SfxService(path.join(root, "output"), undefined, () => fakeTimingProvider, () => fakeMedia, () => renderer);
  const source = await service.store.createRun({ videoPath: video, libraryPath: root, name: "reidentify fixture" });
  Object.assign(source, {
    status: "ready",
    duration: 4,
    assets: [{ id: "asset", path: audio, fileName: "impact.wav", relativePath: "impact.wav", duration: 4, size: 1, mtimeMs: 1, tags: [], usable: true }],
    events: [makeEvent()],
    placements: [makePlacement()]
  });
  await service.store.save(source);
  const rendered = await service.readRun(source.id);
  const parentEvent = structuredClone(rendered.events[0]);
  const parentPlacement = structuredClone(rendered.placements[0]);

  const server = http.createServer((req, res) => { void handleSfxRequest(req, res, new URL(req.url!, "http://localhost"), service); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    if(simulateLongWait)mock.timers.enable({apis:["Date","setTimeout","setInterval"]});
    const response = await fetch(`${base}/api/sfx/runs/${rendered.id}/locate-event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: rendered.revision, eventId: "event", description: "动作接触", startHint: 1, endHint: 2.4 })
    });
    assert.equal(response.status, 202, await response.clone().text());
    const result = await response.json() as { runId: string };
    assert.notEqual(result.runId, rendered.id);
    const next = await service.waitForIdle(result.runId);
    assert.equal(next.status, "ready", next.error);
    assert.equal(next.parentRunId, rendered.id);
    assert.equal(next.events[0].start, 1.4);
    assert.equal(next.events[0].end, 2.1);
    assert.equal(next.events[0].description, "动作接触");
    assert.equal(next.events[0].requiresHumanReview, false);
    assert.equal(next.placements[0].start, 1.4);
    assert.equal(next.placements[0].assetId, parentPlacement.assetId);
    assert.equal(next.placements[0].sourceOffset, parentPlacement.sourceOffset);
    assert.equal(next.placements[0].gainDb, parentPlacement.gainDb);
    assert.equal(next.placements[0].fadeIn, parentPlacement.fadeIn);
    assert.equal(next.placements[0].fadeOut, parentPlacement.fadeOut);
    assert.deepEqual(next.placements[0].sourceEdit, parentPlacement.sourceEdit);
    assert.deepEqual((await service.readRun(rendered.id)).events[0], parentEvent);
    assert.deepEqual((await service.readRun(rendered.id)).placements[0], parentPlacement);
    const usage = JSON.parse(await fs.readFile(path.join(service.store.directory(next.id), "usage-report.json"), "utf8"));
    assert.equal(usage.operation, "reidentify-event");
    assert.deepEqual(usage.requests, [], "the fake provider must not make an external request in this regression test");

    const stale = await fetch(`${base}/api/sfx/runs/${rendered.id}/locate-event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: 99, eventId: "event", description: "动作接触" })
    });
    assert.equal(stale.status, 409);
  } finally {
    if(simulateLongWait)mock.timers.reset();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
}

export async function testLocateEventLowConfidenceKeepsReviewFlag() {
  const event = makeEvent();
  const placement = makePlacement();
  const result = applyEventTiming(event, [placement], { start: .5, end: .9, confidence: .42, evidence: "画面证据不足" }, 4);
  assert.equal(result.event.requiresHumanReview, true);
}
