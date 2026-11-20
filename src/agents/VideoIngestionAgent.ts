import path from "node:path";
import { FfmpegAdapter, VideoMetadata } from "../adapters/FfmpegAdapter.js";
import { BaseAgent, AgentContext } from "./BaseAgent.js";
import {
  VideoIngestionInput,
  VideoIngestionInputSchema,
  VideoManifest,
  VideoManifestSchema
} from "../schemas/index.js";
import { stableId } from "../utils/ids.js";

export class VideoIngestionAgent extends BaseAgent<VideoIngestionInput, VideoManifest> {
  readonly name = "VideoIngestionAgent" as const;

  async run(input: VideoIngestionInput, context: AgentContext): Promise<VideoManifest> {
    const parsed = VideoIngestionInputSchema.parse(input);
    const ffmpeg = new FfmpegAdapter(context.fileAdapter);
    const videos = await context.fileAdapter.listVideoFiles(parsed.inputDir);
    const availability = await ffmpeg.checkAvailability();
    const thumbnailRoot = path.join(context.runDir, "thumbnails");

    const manifestItems = [];
    for (const filePath of videos) {
      const stat = await context.fileAdapter.stat(filePath);
      const fileName = path.basename(filePath);
      const inferred = inferVideoType(fileName);
      let metadata: VideoMetadata = {
        duration: undefined as number | undefined,
        fps: undefined as number | undefined,
        resolution: {},
        audioTrackInfo: [] as Array<{ codec?: string; channels?: number; sampleRate?: number; duration?: number }>
      };
      const notes: string[] = [];
      if (availability.ffprobe) {
        try {
          metadata = await ffmpeg.getVideoMetadata(filePath);
        } catch (error) {
          notes.push(`ffprobe 读取失败：${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        notes.push("未检测到 ffprobe，metadata 需要人工补充。");
      }
      const videoId = stableId([parsed.projectName, fileName]) || stableId([fileName]);
      const thumbnails = availability.ffmpeg
        ? await ffmpeg.extractThumbnails(filePath, path.join(thumbnailRoot, videoId), metadata.duration)
        : [];
      if (!availability.ffmpeg) notes.push("未检测到 ffmpeg，未抽取缩略图。");
      manifestItems.push({
        videoId,
        fileName,
        filePath,
        sizeBytes: stat.size,
        duration: metadata.duration,
        fps: metadata.fps,
        resolution: metadata.resolution,
        audioTrackInfo: metadata.audioTrackInfo,
        thumbnailPaths: thumbnails,
        inferredType: inferred.type,
        confidence: inferred.confidence,
        notes
      });
    }

    return VideoManifestSchema.parse({
      videos: manifestItems,
      generatedAt: new Date().toISOString(),
      source: context.fileAdapter.resolvePath(parsed.inputDir)
    });
  }
}

function inferVideoType(fileName: string): { type: "skill" | "pv" | "ui" | "cutscene" | "boss" | "unknown"; confidence: number } {
  const lower = fileName.toLowerCase();
  const rules: Array<[RegExp, "skill" | "pv" | "ui" | "cutscene" | "boss", number]> = [
    [/(boss|首领|怪物|大招)/, "boss", 0.75],
    [/(skill|ability|cast|技能|招式)/, "skill", 0.75],
    [/(pv|trailer|promo|宣传|角色pv)/, "pv", 0.75],
    [/(ui|button|menu|界面|按钮)/, "ui", 0.75],
    [/(cutscene|cinematic|story|过场|剧情)/, "cutscene", 0.72]
  ];
  for (const [pattern, type, confidence] of rules) {
    if (pattern.test(lower)) return { type, confidence };
  }
  return { type: "unknown", confidence: 0.25 };
}
