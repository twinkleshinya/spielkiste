import { appResource } from "./RuntimePaths.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runFfmpeg } from "./FfmpegBinaries.js";
import { execa } from "execa";
import { Scene, round } from "./models.js";

export interface MediaInspection { duration: number; hasAudio: boolean }
export type FrameRegion = { x:number;y:number;width:number;height:number };
export function frameTimesFromLog(log:string,start:number,count:number):number[]{
  const times=[...log.matchAll(/\bn:\s*\d+\s+pts:\s*[-\d]+\s+pts_time:([-\d.e+]+)/g)].map(m=>Number(m[1])+start);
  if(times.length!==count||times.some(t=>!Number.isFinite(t)))throw new Error('抽帧时间记录不完整，无法为画面标注真实时间');
  return times.map(round);
}
export interface MediaSource {
  inspect(file: string): Promise<MediaInspection>;
  scenes(file: string): Promise<number[]>;
  thumbnail(file: string, time: number, output: string): Promise<string | undefined>;
  sampleFrames?(file: string, start: number, end: number, fps: number, outputDir: string, signal?: AbortSignal, width?: number): Promise<Scene[]>;
  sampleRegionFrames?(file:string,start:number,end:number,fps:number,outputDir:string,region:FrameRegion,signal?:AbortSignal):Promise<Scene[]>;
}
export class MediaTools implements MediaSource {
  async sampleRegionFrames(file:string,start:number,end:number,fps:number,outputDir:string,region:FrameRegion,signal?:AbortSignal) {
    return this.sampleFrames(file,start,end,fps,outputDir,signal,768,region);
  }
  async sampleFrames(file: string, start: number, end: number, fps: number, outputDir: string, signal?: AbortSignal, width = 512,region?:FrameRegion): Promise<Scene[]> {
    signal?.throwIfAborted(); await fs.mkdir(outputDir, { recursive: true });
    for(const file of await fs.readdir(outputDir))if(/^(?:raw-\d+|stamp-\d+)\.jpg$/.test(file))await fs.unlink(path.join(outputDir,file));
    if(region&&(![region.x,region.y,region.width,region.height].every(Number.isFinite)||region.x<0||region.y<0||region.width<=0||region.height<=0||region.x+region.width>1.001||region.y+region.height>1.001))throw new Error('无效局部画面区域');
    const crop=region?`crop=iw*${region.width}:ih*${region.height}:iw*${region.x}:ih*${region.y},`:'';
    const decoded=await runFfmpeg(["-hide_banner", "-loglevel", "info", "-y", "-ss", String(start), "-i", file, "-an", "-vf", `trim=duration=${end-start},select='isnan(prev_selected_t)+gt(floor((t+0.000001)*${fps}),floor((prev_selected_t+0.000001)*${fps}))',${crop}scale=${width}:-2,showinfo`,"-fps_mode","vfr", path.join(outputDir, "raw-%05d.jpg")], { cancelSignal: signal,maxBuffer:32*1024*1024 });
    const files = (await fs.readdir(outputDir)).filter(f => /^raw-\d+\.jpg$/.test(f)).sort();
    const times=frameTimesFromLog(decoded.stderr,start,files.length);
    const frames = files.map((file, i) => ({ start: times[i], end: round(Math.min(end,times[i+1]??times[i]+1/fps)), thumbnail: path.join(outputDir, `stamp-${String(i).padStart(5, "0")}.jpg`) }));
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
