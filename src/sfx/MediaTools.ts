import { appResource } from "./RuntimePaths.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runFfmpeg } from "./FfmpegBinaries.js";
import { execa } from "execa";
import { Scene, round } from "./models.js";

export interface MediaInspection { duration: number; hasAudio: boolean }
export interface MediaSource {
  inspect(file: string): Promise<MediaInspection>;
  scenes(file: string): Promise<number[]>;
  thumbnail(file: string, time: number, output: string): Promise<string | undefined>;
  sampleFrames?(file: string, start: number, end: number, fps: number, outputDir: string, signal?: AbortSignal, width?: number): Promise<Scene[]>;
}
export class MediaTools implements MediaSource {
  async sampleFrames(file: string, start: number, end: number, fps: number, outputDir: string, signal?: AbortSignal, width = 512): Promise<Scene[]> {
    signal?.throwIfAborted(); await fs.mkdir(outputDir, { recursive: true });
    await runFfmpeg(["-hide_banner", "-loglevel", "error", "-y", "-ss", String(start), "-i", file, "-t", String(end - start), "-vf", `fps=${fps},scale=${width}:-2`, path.join(outputDir, "raw-%05d.jpg")], { cancelSignal: signal });
    const files = (await fs.readdir(outputDir)).filter(f => /^raw-\d+\.jpg$/.test(f)).sort();
    const frames = files.map((file, i) => ({ start: round(start + i / fps), end: round(Math.min(end, start + (i + 1) / fps)), thumbnail: path.join(outputDir, `stamp-${String(i).padStart(5, "0")}.jpg`) }));
    const manifest = path.join(outputDir, "labels.json");
    await fs.writeFile(manifest, JSON.stringify(frames.map((f, i) => ({ input: path.join(outputDir, files[i]), output: f.thumbnail, label: `ABSOLUTE TIME ${f.start.toFixed(3)}s` }))));
    await execa("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", appResource("scripts/stamp-sfx-frames.ps1"), "-Manifest", manifest], { windowsHide: true, cancelSignal: signal });
    signal?.throwIfAborted(); return frames.filter(f => f.start < f.end);
  }
  async inspect(file: string): Promise<MediaInspection> {
    try {
      const { stdout } = await runFfmpeg(["__ffprobe__", "-v", "error", "-show_format", "-show_streams", "-of", "json", file], { });
      const data = JSON.parse(stdout);
      if (!data.streams?.some((s: { codec_type: string }) => s.codec_type === "video")) throw new Error("文件不包含视频画面");
      const duration = Number(data.format?.duration);
      if (!Number.isFinite(duration) || duration <= 0) throw new Error("无法读取有效视频时长");
      return { duration, hasAudio: data.streams.some((s: { codec_type: string }) => s.codec_type === "audio") };
    } catch (e) {
      const message = String(e instanceof Error ? e.message : e);
            if (/\bEPERM\b/i.test(message)) {
                throw new Error(`FFprobe 启动被 Windows 拒绝（EPERM），不是视频内容错误。程序已尝试直接启动及 Windows 回退方式；请关闭旧服务后用普通 Windows 桌面启动 Spielkiste.bat，再重试。也可设置 FFPROBE_PATH 指向可执行的 ffprobe.exe。原始错误：${message.slice(0, 260)}`);
      }
      throw new Error(`视频读取失败，请确认 FFprobe 已安装且文件可播放：${message.slice(0, 350)}`);
    }
  }
  async scenes(file: string): Promise<number[]> {
    const { stderr } = await runFfmpeg(["-hide_banner", "-i", file, "-vf", "scale=320:-2,select='gt(scene,0.30)',showinfo", "-an", "-f", "null", "-"], { maxBuffer: 16 * 1024 * 1024 });
    return [...stderr.matchAll(/pts_time:([\d.]+)/g)].map(m => Number(m[1]));
  }
  async thumbnail(file: string, time: number, output: string) {
    await fs.mkdir(path.dirname(output), { recursive: true });
    await runFfmpeg(["-hide_banner", "-loglevel", "error", "-y", "-ss", String(time), "-i", file, "-frames:v", "1", "-vf", "scale=768:-2", output], { });
    return output;
  }
}
