import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { inspectAudioCandidate } from "./PrepareCandidates.js";
import { runFfmpeg } from "./FfmpegBinaries.js";
import type { AudioAsset } from "./models.js";
import type { AudioClipSource, AudioSample } from "./GeminiAudioSelector.js";
import { hasPronouncedPitchSweep } from "./AudioAcoustics.js";
import { measureCandidateAcoustics } from "./CandidateAcoustics.js";
import { SFX_WORKFLOW } from "./WorkflowPolicy.js";

export class AudioCandidateClips implements AudioClipSource {
  inspect(asset: AudioAsset, signal?: AbortSignal) { return inspectAudioCandidate(asset, signal); }
  async sample(asset: AudioAsset, music: boolean, outputDir: string, signal?: AbortSignal): Promise<AudioSample> {
    signal?.throwIfAborted();
    if (!await this.inspect(asset, signal)) throw new Error(asset.warning || "候选音频不可用");
    const duration = asset.duration!;
    const start = Math.min(asset.onset || 0, Math.max(0, duration - .1));
    const half=SFX_WORKFLOW.selection.musicSampleSeconds/2;
    const segments = music && duration > 26 ? [{ start, end: Math.min(duration, start + half) }, { start: Math.max(start + half, duration * .5), end: Math.min(duration, Math.max(start + half, duration * .5) + half) }] : [{ start, end: Math.min(duration, start + (music ? SFX_WORKFLOW.selection.musicSampleSeconds : SFX_WORKFLOW.selection.effectSampleSeconds)) }];
    if (segments.some(s => s.end <= s.start)) throw new Error("音频片段时长无效");
    const dir = path.join(outputDir, "selection-clips"); await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${createHash("sha256").update(asset.id).digest("hex").slice(0, 20)}.wav`);
    const inputs = segments.flatMap(s => ["-ss", String(s.start), "-t", String(s.end - s.start), "-i", asset.path]);
    const filter = segments.map((_, i) => `[${i}:a]aformat=sample_fmts=s16:sample_rates=16000:channel_layouts=mono,asetpts=PTS-STARTPTS[a${i}]`).join(";") + (segments.length > 1 ? `;${segments.map((_, i) => `[a${i}]`).join("")}concat=n=${segments.length}:v=0:a=1[out]` : "");
    await runFfmpeg(["-hide_banner", "-loglevel", "error", "-y", ...inputs, "-filter_complex", filter, "-map", segments.length > 1 ? "[out]" : "[a0]", "-vn", "-c:a", "pcm_s16le", "-ac", "1", "-ar", "16000", file], { timeout: 45000, maxBuffer: 2 * 1024 * 1024, cancelSignal: signal });
    signal?.throwIfAborted();
    const bytes = await fs.readFile(file);
    if (!music && segments.length === 1) asset.acoustics = measureCandidateAcoustics(bytes, start);
    if (!music && /ui_|_ui|界面/i.test(asset.fileName)) asset.pitchSweep = hasPronouncedPitchSweep(bytes);
    if (bytes.length > 1000000) throw new Error("候选片段超过音频输入大小限制");
    return { assetId: asset.id, data: bytes.toString("base64"), format: "wav", segments };
  }
}
