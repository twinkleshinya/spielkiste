import { promises as fs } from "node:fs";
import { Scene } from "./models.js";
import { VideoUnderstandingProvider, VisionEventSchema } from "./SfxVideoAnalyzer.js";
import { z } from "zod";

export class OllamaVisionProvider implements VideoUnderstandingProvider {
  readonly kind = "ollama" as const;
  async describe(scenes: Scene[]): Promise<unknown[]> {
    const endpoint = new URL(process.env.SFX_OLLAMA_URL || "http://127.0.0.1:11434");
    if (!["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) throw new Error("第一版视觉分析仅允许本机 Ollama 服务");
    const available = scenes.filter(s => s.thumbnail);
    if (!available.length) throw new Error("没有可分析的关键帧");
    const result: unknown[] = [];
    for (let i = 0; i < available.length; i += 6) {
      const batch = available.slice(i, i + 6);
      const images = await Promise.all(batch.map(s => fs.readFile(s.thumbnail!).then(b => b.toString("base64"))));
      const response = await fetch(new URL("/api/chat", endpoint), {
        method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(180000),
        body: JSON.stringify({ model: process.env.SFX_OLLAMA_MODEL || "qwen2.5vl:7b", stream: false, format: "json", options: { temperature: 0.1 }, messages: [{ role: "user", images,
          content: `你是视频音效编辑助手。下面图片依次对应镜头时间范围（秒）：${JSON.stringify(batch.map(s => ({ start: s.start, end: s.end })))}。仅描述画面可支持的动作或环境，避免编造连续动作；静态帧无法确定的事件降低 confidence。不要给每次切镜添加音效。最多给出 30 个值得配音效的事件。description 使用中文，query 使用适合本地文件名检索的英文关键词。只返回 JSON：{"events":[{"start":0,"end":1,"type":"door_open","description":"木门打开","query":"wood door open","category":"foley","confidence":0.6}]}。category 必须为 foley/impact/whoosh/ambience/other；时间不得超出对应镜头。` }] })
      });
      if (!response.ok) throw new Error(`Ollama HTTP ${response.status}，请检查模型已下载且支持图片`);
      const body = await response.json() as { message?: { content?: string } };
      const raw = JSON.parse((body.message?.content || "").replace(/^```(?:json)?\s*|\s*```$/g, ""));
      const parsed = z.object({ events: z.array(VisionEventSchema).max(60) }).parse(raw);
      for (const event of parsed.events) {
        if (!batch.some(s => event.start >= s.start && event.end <= s.end + 0.001)) continue;
        result.push(event);
      }
    }
    return result;
  }
}
