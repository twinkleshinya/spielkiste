import "dotenv/config";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runFfmpeg } from "../dist/src/sfx/FfmpegBinaries.js";
import { SfxService } from "../dist/src/sfx/SfxService.js";
const root = path.resolve(".output/sfx-demo"); const library = path.join(root, "library");
await fs.mkdir(library, { recursive: true });
const video = path.join(root, "motion-study.mp4");
await runFfmpeg( ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=duration=4:size=640x360:rate=24", "-c:v", "libx264", "-pix_fmt", "yuv420p", video]);
await runFfmpeg( ["-v", "error", "-y", "-f", "lavfi", "-i", "anoisesrc=d=0.35:c=brown:r=48000", "-af", "afade=t=out:st=0:d=0.35", path.join(library, "impact_soft_noise.wav")]);
await runFfmpeg( ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=0.7", "-af", "afade=t=in:d=0.1,afade=t=out:st=0.3:d=0.4", path.join(library, "whoosh_tone_transition.wav")]);
const service = new SfxService(); const created = await service.create({ name: "合成素材演示 · 人工编排", videoPath: video, libraryPath: library, analysisMode: "scene" });
const run = await service.waitForIdle(created.runId);
if (run.status !== "ready") throw new Error(run.error);
const events = [
  { id: "demo-impact", start: 1, end: 1.35, type: "manual", description: "测试节奏点 · 合成轻冲击", query: "impact", category: "impact", confidence: 1, source: "manual", requiresHumanReview: false, candidates: await service.search(run.id, "impact") },
  { id: "demo-whoosh", start: 2.5, end: 3.2, type: "manual", description: "测试过渡 · 合成音调", query: "whoosh", category: "whoosh", confidence: 1, source: "manual", requiresHumanReview: false, candidates: await service.search(run.id, "whoosh") }
];
const { createPlacements } = await import("../dist/src/sfx/PlacementEngine.js");
await service.update(run.id, { revision: run.revision, originalGainDb: 0, events, placements: createPlacements(events, run.assets, run.duration) });
await service.render(run.id); const rendered = await service.waitForIdle(run.id);
if (rendered.error) throw new Error(rendered.error);
console.log(`演示项目：http://127.0.0.1:4320/sfx?run=${run.id}`);
console.log(`预览视频：${rendered.render.video}`);

