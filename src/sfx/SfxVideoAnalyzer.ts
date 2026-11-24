import path from "node:path";
import { randomUUID } from "node:crypto";
import { CategorySchema, EventSchema, Scene, SoundEvent, round } from "./models.js";
import { MediaSource, MediaTools } from "./MediaTools.js";
import { z } from "zod";
import { analyzeTemporal, AnalysisOptions, FrameDirector } from "./TemporalAnalysis.js";

export const VisionEventSchema = z.object({ start: z.number().finite().nonnegative(), end: z.number().finite().positive(), type: z.string(), description: z.string().max(2000), query: z.string().max(2000), category: CategorySchema, confidence: z.number().min(0).max(1) });
export interface VideoUnderstandingProvider {
  readonly kind?: "ollama" | "gemini" | "ccswitch";
  describe(scenes: Scene[], signal?: AbortSignal): Promise<unknown[]>;
  analyzeFrames?: FrameDirector["analyzeFrames"];
  /** Optional full-video path. Providers that support temporal video input should implement this. */
  describeVideo?(video: string, scenes: Scene[], signal?: AbortSignal): Promise<unknown[]>;
}
export class SfxVideoAnalyzer {
  constructor(private media: MediaSource = new MediaTools(), private provider?: VideoUnderstandingProvider) {}
  async analyze(video: string, outputDir: string, options: AnalysisOptions = {}) {
    const metadata = await this.media.inspect(video); const warnings: string[] = [];
    const duration = Math.floor(metadata.duration * 1000) / 1000;
    if (duration < 0.001) throw new Error("视频时长过短");
    if (this.provider?.analyzeFrames && this.media.sampleFrames) {
      const result = await analyzeTemporal(video, duration, outputDir, this.media, this.provider as FrameDirector, options);
      return { duration, scenes: result.scenes, events: result.events, warnings: result.warnings, mode: this.provider.kind ?? "ccswitch", report: result.report };
    }
    let cuts: number[] = [];
    try { cuts = await this.media.scenes(video); } catch (e) { warnings.push(`镜头检测失败，使用整段视频复核：${String(e).slice(0, 250)}`); }
    const boundaries = [0];
    for (const cut of cuts.filter(Number.isFinite).sort((a, b) => a - b)) if (cut - boundaries[boundaries.length - 1] >= 0.25 && cut < duration - 0.25) boundaries.push(round(cut));
    boundaries.push(duration);
    const scenes: Scene[] = boundaries.slice(0, -1).map((start, i) => ({ start, end: boundaries[i + 1] }));
    // CC Switch/Gemini gets dense temporal samples instead of one frame per cut.
    const modelScenes = this.provider?.kind === "ccswitch" ? denseSamples(duration) : scenes;
    const maxModelScenes = this.provider?.kind === "ccswitch" ? 96 : 48;
    const step = Math.max(1, Math.ceil(modelScenes.length / maxModelScenes));
    const sampledScenes = modelScenes.filter((_, i) => i % step === 0).slice(0, maxModelScenes);
    for (let i = 0; i < sampledScenes.length; i++) {
      try { sampledScenes[i].thumbnail = await this.media.thumbnail(video, (sampledScenes[i].start + sampledScenes[i].end) / 2, path.join(outputDir, "frames", `model-${i}.jpg`)); }
      catch { warnings.push(`第 ${i + 1} 个模型时间片缩略图不可用`); }
    }
    if (modelScenes.length > 48) warnings.push("模型时间片超过 48 个：已按时间均匀抽样");
    let events: SoundEvent[] = []; let mode: "scene" | "ollama" | "gemini" | "ccswitch" = "scene";
    if (this.provider) {
      try {
        const proposed = this.provider.describeVideo
          ? await this.provider.describeVideo(video, sampledScenes, options.signal)
          : await this.provider.describe(sampledScenes, options.signal);
        if (!Array.isArray(proposed)) throw new Error("模型未返回事件数组");
        for (const item of proposed.slice(0, 500)) {
          const v = VisionEventSchema.parse(item);
          if (v.start >= duration || v.end <= v.start) { warnings.push("忽略模型返回的无效时间区间"); continue; }
          const start = round(v.start); const end = Math.min(duration, round(v.end));
          if (end <= start) continue;
          events.push(EventSchema.parse({ ...v, id: randomUUID(), start, end, source: "vision", candidates: [], requiresHumanReview: true }));
        }
        mode = this.provider.kind ?? "ollama";
        if (!events.some(event => event.category === "ambience")) {
          events.push(EventSchema.parse({ id: randomUUID(), start: 0, end: duration, type: "environment_ambience", description: "全片环境氛围层：根据场景补充风、空间、地面和远景环境声", query: "ambience environment wind outdoor", category: "ambience", confidence: .45, source: "vision", candidates: [], requiresHumanReview: true }));
        }
      } catch (e) { warnings.push(`视觉模型不可用，切换到镜头复核：${String(e).slice(0, 300)}`); events = []; }
    }
    if (mode === "scene") {
      warnings.push("当前仅检测镜头边界，尚未识别人物动作或声音语义；请填写事件描述和检索词，或启用本地视觉模型。镜头切换不代表必须添加音效。");
      events = scenes.slice(0, 500).map((scene, i) => EventSchema.parse({ id: randomUUID(), start: scene.start, end: scene.end, type: "manual_review", description: `镜头 ${i + 1}：待确认画面动作、材质和环境`, query: "", category: "other", confidence: 0, source: "scene", candidates: [], requiresHumanReview: true }));
    }
    if (!metadata.hasAudio) warnings.push("原视频无音轨，预览将使用静音底轨与贴片混音。");
    return { duration, scenes, events, warnings, mode };
  }
}

function denseSamples(duration: number): Scene[] {
  const step = Number(process.env.SFX_MODEL_SAMPLE_SECONDS || .6);
  const interval = Number.isFinite(step) && step >= .25 ? step : .6;
  const samples: Scene[] = [];
  for (let start = 0; start < duration; start += interval) samples.push({ start: round(start), end: round(Math.min(duration, start + interval)) });
  return samples;
}
