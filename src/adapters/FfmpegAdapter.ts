import path from "node:path";
import { execa } from "execa";
import { FileAdapter } from "./FileAdapter.js";
import { AudioTrackInfoSchema } from "../schemas/index.js";

export interface VideoMetadata {
  duration?: number;
  fps?: number;
  resolution: { width?: number; height?: number };
  audioTrackInfo: Array<{ codec?: string; channels?: number; sampleRate?: number; duration?: number }>;
}

export class FfmpegAdapter {
  constructor(private readonly fileAdapter: FileAdapter) {}

  async checkAvailability(): Promise<{ ffprobe: boolean; ffmpeg: boolean }> {
    const finder = process.platform === "win32" ? "where.exe" : "which";
    const [ffprobe, ffmpeg] = await Promise.all([
      execa(finder, ["ffprobe"], { reject: false }),
      execa(finder, ["ffmpeg"], { reject: false })
    ]);
    return { ffprobe: ffprobe.exitCode === 0, ffmpeg: ffmpeg.exitCode === 0 };
  }

  async getVideoMetadata(filePath: string): Promise<VideoMetadata> {
    const { stdout } = await execa("ffprobe", [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      filePath
    ]);
    const parsed = JSON.parse(stdout) as {
      format?: { duration?: string };
      streams?: Array<Record<string, unknown>>;
    };
    const videoStream = parsed.streams?.find((stream) => stream.codec_type === "video");
    const audioStreams = parsed.streams?.filter((stream) => stream.codec_type === "audio") ?? [];
    const duration = Number(videoStream?.duration ?? parsed.format?.duration);
    return {
      duration: Number.isFinite(duration) ? duration : undefined,
      fps: parseFps(String(videoStream?.avg_frame_rate ?? videoStream?.r_frame_rate ?? "")),
      resolution: {
        width: numberOrUndefined(videoStream?.width),
        height: numberOrUndefined(videoStream?.height)
      },
      audioTrackInfo: audioStreams.map((stream) =>
        AudioTrackInfoSchema.parse({
          codec: stringOrUndefined(stream.codec_name),
          channels: numberOrUndefined(stream.channels),
          sampleRate: numberOrUndefined(stream.sample_rate),
          duration: numberOrUndefined(stream.duration)
        })
      )
    };
  }

  async extractThumbnails(filePath: string, outputDir: string, duration?: number): Promise<string[]> {
    const availability = await this.checkAvailability();
    if (!availability.ffmpeg) {
      return [];
    }
    await this.fileAdapter.ensureDir(outputDir);
    const stem = path.basename(filePath).replace(/\.[^.]+$/, "");
    const points = getThumbnailPoints(duration);
    const outputs: string[] = [];
    for (const [index, seconds] of points.entries()) {
      const output = path.join(outputDir, `${stem}_${String(index + 1).padStart(2, "0")}.jpg`);
      const result = await execa(
        "ffmpeg",
        ["-y", "-ss", String(seconds), "-i", filePath, "-frames:v", "1", "-q:v", "3", output],
        { reject: false }
      );
      if (result.exitCode === 0) {
        outputs.push(output);
      }
    }
    return outputs;
  }

  async extractAudioWaveformMetadata(filePath: string): Promise<{ hasAudio: boolean; notes: string[] }> {
    const metadata = await this.getVideoMetadata(filePath);
    return {
      hasAudio: metadata.audioTrackInfo.length > 0,
      notes:
        metadata.audioTrackInfo.length > 0
          ? metadata.audioTrackInfo.map((track, index) => `audio_${index + 1}: ${track.codec ?? "unknown"}, ${track.channels ?? "?"}ch`)
          : ["未检测到音轨"]
    };
  }
}

function parseFps(value: string): number | undefined {
  if (!value || value === "0/0") return undefined;
  if (value.includes("/")) {
    const [a, b] = value.split("/").map(Number);
    return b ? Number((a / b).toFixed(3)) : undefined;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getThumbnailPoints(duration?: number): number[] {
  if (!duration || duration <= 1) return [0];
  const points = [duration * 0.15, duration * 0.5, duration * 0.85].map((point) => Math.max(0, Math.floor(point)));
  return [...new Set(points)];
}
