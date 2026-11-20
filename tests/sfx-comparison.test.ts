import assert from "node:assert/strict";
import { compareRuns, describeSelection } from "../src/sfx/SfxComparison.js";
import type { SfxRun } from "../src/sfx/models.js";

function run(overrides: Partial<SfxRun> = {}): SfxRun {
  return {
    version: 1,
    id: "00000000-0000-4000-8000-000000000001",
    name: "test",
    createdAt: "2026-11-15T00:00:00.000Z",
    revision: 0,
    status: "ready",
    progress: "完成",
    videoPath: "C:\\video.mp4",
    libraryPath: "E:\\M98\\整理版",
    duration: 2,
    originalGainDb: 0,
    analysisMode: "ccswitch",
    warnings: [],
    scenes: [],
    assets: [{ id: "a", path: "C:\\a.wav", relativePath: "a.wav", fileName: "a.wav", size: 10, mtimeMs: 1, tags: [], duration: 1, usable: true }],
    events: [{ id: "e", start: 0, end: 1, type: "hit", description: "命中", query: "hit", category: "impact", confidence: .9, source: "vision", candidates: [{ assetId: "a", score: 1, reason: "rule" }], requiresHumanReview: true, layers: [{ id: "l", role: "impact", query: "hit", offset: 0, candidates: [{ assetId: "a", score: 1, reason: "rule" }] }] }],
    placements: [{ id: "p", eventId: "e", layerId: "l", role: "impact", assetId: "a", start: 0, duration: .5, sourceOffset: 0, gainDb: -6, fadeIn: 0, fadeOut: .05, category: "impact", enabled: true }],
    ...overrides
  };
}

export function testSfxComparison() {
  const local = run();
  const gemini = run({ id: "00000000-0000-4000-8000-000000000002", selectionReport: { model: "gemini-4-argon", status: "complete", analyzedAssets: 1, cachedAssets: 0, selectedLayers: 1, rejectedLayers: 0, fallbackLayers: 0, warnings: [], decisions: [{ taskId: "e:l", eventIds: ["e"], assetId: "a", reason: "声学瞬态匹配", basis: "audio-context" }], audio: [] } });
  assert.equal(describeSelection(local).kind, "local-rule");
  assert.equal(describeSelection(gemini).kind, "gemini");
  const comparison = compareRuns(local, gemini);
  assert.equal(comparison.source.sameEventTimeline, true);
  assert.equal(comparison.stats.unchangedSelections, 1);
  assert.equal(comparison.stats.changedSelections, 0);
  assert.match(comparison.evaluation.recommended, /本地规则/);
}
