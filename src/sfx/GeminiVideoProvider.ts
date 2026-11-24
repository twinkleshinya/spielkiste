import { promises as fs } from "node:fs";
import path from "node:path";
import { VisionEventSchema, VideoUnderstandingProvider } from "./SfxVideoAnalyzer.js";
import { Scene } from "./models.js";
import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { generationFetch, modelJson } from "./ModelUsage.js";

type GeminiFile = { name: string; uri: string; mimeType?: string; state?: string | { name?: string } };

/**
 * Full-video Gemini adapter. The video is uploaded only for analysis; local audio
 * library files never leave the machine and are matched by SfxService afterwards.
 */
export class GeminiVideoProvider implements VideoUnderstandingProvider {
  readonly kind = "gemini" as const;
  private readonly apiKey = process.env.GEMINI_API_KEY?.trim();
  private readonly model = process.env.SFX_GEMINI_MODEL?.trim() || "gemini-2.5-flash";
  private readonly base = "https://generativelanguage.googleapis.com";

  async describe(scenes: Scene[]): Promise<unknown[]> {
    throw new Error("Gemini 需要完整视频输入；未提供视频路径");
  }

  async describeVideo(video: string, scenes: Scene[], signal?: AbortSignal): Promise<unknown[]> {
    if (!this.apiKey) throw new Error("未配置 GEMINI_API_KEY");
    if (!/^gemini(?:-|$)/i.test(this.model)) throw new Error("自动点位分析必须使用 Gemini，请检查工具专用 SFX_GEMINI_MODEL 配置。");
    const stat = await fs.stat(video);
    if (!stat.isFile()) throw new Error("视频文件不存在");
    const mimeType = mimeFor(video);
    let uploaded: GeminiFile | undefined;
    try {
      uploaded = await this.upload(video, mimeType, stat.size, signal);
      await this.waitUntilActive(uploaded, signal);
      const text = await this.generate(uploaded, scenes, signal);
      const parsed = JSON.parse(stripJsonFence(text));
      return z.object({ events: z.array(VisionEventSchema).max(120) }).parse(parsed).events;
    } finally {
      if (uploaded?.name) {
        await generationFetch(`${this.base}/v1beta/${uploaded.name}?key=${encodeURIComponent(this.apiKey)}`, { method: "DELETE" }).catch(() => undefined);
      }
    }
  }

  private async upload(video: string, mimeType: string, size: number, signal?: AbortSignal): Promise<GeminiFile> {
    const start = await generationFetch(`${this.base}/upload/v1beta/files?key=${encodeURIComponent(this.apiKey!)}`, {
      method: "POST", signal,
      headers: {
        "content-type": "application/json",
        "x-goog-upload-protocol": "resumable",
        "x-goog-upload-command": "start",
        "x-goog-upload-header-content-length": String(size),
        "x-goog-upload-header-content-type": mimeType
      },
      body: JSON.stringify({ file: { display_name: path.basename(video) } })
    });
    if (!start.ok) throw new Error(`Gemini 文件上传初始化失败（HTTP ${start.status}）：${await start.text()}`);
    const uploadUrl = start.headers.get("x-goog-upload-url");
    if (!uploadUrl) throw new Error("Gemini 没有返回上传地址");
    const body = await fs.readFile(video);
    const uploaded = await generationFetch(uploadUrl, {
      method: "POST",
      headers: { "content-length": String(body.length), "x-goog-upload-offset": "0", "x-goog-upload-command": "upload, finalize" },
      body,
      signal
    });
    if (!uploaded.ok) throw new Error(`Gemini 视频上传失败（HTTP ${uploaded.status}）：${await uploaded.text()}`);
    const data = await uploaded.json() as { file?: GeminiFile };
    if (!data.file?.name || !data.file.uri) throw new Error("Gemini 上传响应缺少文件引用");
    return data.file;
  }

  private async waitUntilActive(file: GeminiFile, signal?: AbortSignal) {
    let current = file;
    for (;;) {
      signal?.throwIfAborted();
      const state = typeof current.state === "string" ? current.state : current.state?.name;
      if (!state || state === "ACTIVE") return;
      if (state === "FAILED") throw new Error("Gemini 视频处理失败");
      await delay(2000, undefined, {signal});
      const response = await generationFetch(`${this.base}/v1beta/${current.name}?key=${encodeURIComponent(this.apiKey!)}`, { signal });
      if (!response.ok) throw new Error(`Gemini 文件状态查询失败（HTTP ${response.status}）`);
      current = await response.json() as GeminiFile;
    }
  }

  private async generate(file: GeminiFile, scenes: Scene[], signal?: AbortSignal): Promise<string> {
    const prompt = `你是专业视频音效编辑器。请完整观看这段视频（包括画面和原始音频），识别所有值得添加音效的动作和声音事件，并给出准确的时间点。

要求：
1. 只返回 JSON，不要 Markdown，不要解释。格式：{"events":[{"start":0.0,"end":0.4,"type":"sword_swing","description":"人物挥动长剑","query":"sword swing whoosh","category":"whoosh","confidence":0.92}]}
2. start/end 使用视频开头起算的秒数，精确到 0.01 秒；start 是动作或声音开始，end 是动作或声音结束。
3. 对每一个可见动作都建立事件，不能只挑少数高置信度事件。每个动作按需要拆成 preparation（准备/蓄力）、motion（挥动/移动/飞行）、contact（命中/落地/砸地）和 aftermath（余波/燃烧/碎屑）阶段；这些阶段必须分别给出时间范围。
4. 对冲击、命中、落地、爆炸、拔刀、挥砍、蓄力、移动、跳跃、闪避、投掷、UI 操作、门窗、脚步、布料、金属、木头、石头、水火等都分别建立事件。不要因为镜头切换本身添加声音。
5. query 必须是适合搜索本地音效文件名的简短英文关键词；description 用中文。
6. category 只能是 foley、impact、whoosh、ambience、other。最多 180 个事件。即使置信度较低但动作可见，也必须保留事件并降低 confidence。
7. 时间必须落在视频范围内。视频镜头范围参考：${JSON.stringify(scenes.map(s => ({ start: s.start, end: s.end })))}。`;
    const { response, body: data } = await modelJson(`${this.base}/v1beta/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey!)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal,
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }, { file_data: { mime_type: file.mimeType || "video/mp4", file_uri: file.uri } }] }],
        generationConfig: { temperature: 0.1, responseMimeType: "application/json" }
      })
    }, "video-timing", this.model);
    if (!response.ok) throw new Error(`Gemini 视频分析失败（HTTP ${response.status}）`);
    const text = data?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || "").join("").trim();
    if (!text) throw new Error("Gemini 没有返回视频分析结果");
    return text;
  }
}

function mimeFor(file: string): string {
  switch (path.extname(file).toLowerCase()) {
    case ".webm": return "video/webm";
    case ".mov": return "video/quicktime";
    case ".mkv": return "video/x-matroska";
    case ".avi": return "video/x-msvideo";
    default: return "video/mp4";
  }
}

function stripJsonFence(value: string): string {
  return value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}
