import { promises as fs } from "node:fs";
import path from "node:path";
import { Scene } from "./models.js";
import { VideoUnderstandingProvider, VisionEventSchema } from "./SfxVideoAnalyzer.js";
import { z } from "zod";
import { modelJson } from "./ModelUsage.js";
import { DescribedEventsResultSchema, EventTimingResultSchema } from "./EventTiming.js";
import { AiConfigService, readCcSwitchConfigFile, type AiReasoningEffort } from "./SfxAiConfig.js";

export type CcSwitchConfig = { baseUrl: string; model: string; wireApi: "responses" | "chat_completions"; bearer?: string; reasoningEffort?: AiReasoningEffort };

/** Reuses the local CC Switch/Codex OpenAI-compatible gateway without exposing credentials to the browser. */
export class CcSwitchVisionProvider implements VideoUnderstandingProvider {
  readonly kind = "ccswitch" as const;
  constructor(readonly model?: string, readonly reasoningEffort?: AiReasoningEffort) {}

  async analyzeFrames(scenes: Scene[], prompt: string, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const config = await readConfig(undefined,this.model,this.reasoningEffort);
    const available = scenes.filter(s => s.thumbnail);
    if (!available.length || available.length > 48) throw new Error("每次分析需要1–48张带时间的图片，请分段处理。");
    const images = await Promise.all(available.map(async scene => `data:image/jpeg;base64,${(await fs.readFile(scene.thumbnail!)).toString("base64")}`));
    const labels = available.map(s => s.start);
    const text = config.wireApi === "responses" ? await this.responses(config, prompt, images, signal, labels) : await this.chatCompletions(config, prompt, images, signal, labels);
    return JSON.parse(stripJsonFence(text));
  }

  async locateEvent(scenes: Scene[], prompt: string, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const config = await readConfig(undefined, this.model, this.reasoningEffort);
    const available = scenes.filter(s => s.thumbnail);
    if (!available.length || available.length > 48) throw new Error("重新定位需要1–48张带时间的图片。");
    const images = await Promise.all(available.map(async scene => `data:image/jpeg;base64,${(await fs.readFile(scene.thumbnail!)).toString("base64")}`));
    const text = config.wireApi === "responses"
      ? await this.responses(config, prompt, images, signal, available.map(s => s.start))
      : await this.chatCompletions(config, prompt, images, signal, available.map(s => s.start));
    return EventTimingResultSchema.parse(JSON.parse(stripJsonFence(text)));
  }

  async locateEvents(scenes: Scene[], prompt: string, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const config = await readConfig(undefined, this.model, this.reasoningEffort);
    const available = scenes.filter(s => s.thumbnail);
    if (!available.length || available.length > 48) throw new Error("描述式补声需要1–48张带时间的图片。");
    const images = await Promise.all(available.map(async scene => `data:image/jpeg;base64,${(await fs.readFile(scene.thumbnail!)).toString("base64")}`));
    const text = config.wireApi === "responses"
      ? await this.responses(config, prompt, images, signal, available.map(s => s.start))
      : await this.chatCompletions(config, prompt, images, signal, available.map(s => s.start));
    return DescribedEventsResultSchema.parse(JSON.parse(stripJsonFence(text)));
  }

  async describe(scenes: Scene[], signal?: AbortSignal): Promise<unknown[]> {
    const config = await readConfig(undefined,this.model,this.reasoningEffort);
    const available = scenes.filter(scene => scene.thumbnail).slice(0, 48);
    if (!available.length) throw new Error("CC Switch 没有可分析的关键帧");
    const prompt = `你是 Gemini 视频音效分析器。下面是按时间顺序抽取的密集关键帧，每张图片对应一个时间范围：${JSON.stringify(available.map(scene => ({ start: scene.start, end: scene.end })))}。
请识别画面中每一个可见动作和声音事件，给出落在对应时间范围内的时间点。每个动作按需要拆成 preparation（准备/蓄力）、motion（挥动/移动/飞行）、contact（命中/落地/砸地）和 aftermath（余波/碎屑/燃烧）阶段；不要因为镜头切换本身添加声音。
只返回 JSON：{"events":[{"start":0.0,"end":1.0,"type":"sword_swing","description":"人物挥动长剑","query":"sword swing whoosh","category":"whoosh","confidence":0.8}]}。
description 使用中文，query 使用简短英文文件名关键词，category 只能是 foley/impact/whoosh/ambience/other，最多 120 个事件；即使置信度较低但动作可见也要保留，时间精确到 0.01 秒。`;
    const images = await Promise.all(available.map(async scene => `data:image/jpeg;base64,${await fs.readFile(scene.thumbnail!).then(buffer => buffer.toString("base64"))}`));
    const text = config.wireApi === "responses"
      ? await this.responses(config, prompt, images, signal)
      : await this.chatCompletions(config, prompt, images, signal);
    const parsed = z.object({ events: z.array(VisionEventSchema).max(120) }).parse(JSON.parse(stripJsonFence(text)));
    return parsed.events;
  }

  private headers(config: CcSwitchConfig): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (config.bearer && config.bearer !== "PROXY_MANAGED") headers.authorization = `Bearer ${config.bearer}`;
    return headers;
  }

  private async responses(config: CcSwitchConfig, prompt: string, images: string[], signal?: AbortSignal, labels?: number[]): Promise<string> {
    const { response, body } = await modelJson(`${config.baseUrl.replace(/\/$/, "")}/responses`, {
      method: "POST", headers: this.headers(config), signal,
      body: JSON.stringify({ model: config.model, reasoning: { effort: config.reasoningEffort || "high" }, input: [{ role: "user", content: [{ type: "input_text", text: prompt }, ...images.flatMap((image_url, i) => labels ? [{ type: "input_text", text: `ABSOLUTE TIME ${labels[i].toFixed(3)} seconds` }, { type: "input_image", image_url }] : [{ type: "input_image", image_url }])] }], temperature: 0.1 })
    }, "video-timing", config.model);
    if (!response.ok) throw new Error(`CC Switch Responses 请求失败（HTTP ${response.status}），请检查本机网关连接。`);
    return extractText(body);
  }

  private async chatCompletions(config: CcSwitchConfig, prompt: string, images: string[], signal?: AbortSignal, labels?: number[]): Promise<string> {
    const { response, body } = await modelJson(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST", headers: this.headers(config), signal,
      body: JSON.stringify({ model: config.model, reasoning_effort: config.reasoningEffort || "high", temperature: 0.1, messages: [{ role: "user", content: [{ type: "text", text: prompt }, ...images.flatMap((image_url, i) => labels ? [{ type: "text", text: `ABSOLUTE TIME ${labels[i].toFixed(3)} seconds` }, { type: "image_url", image_url: { url: image_url } }] : [{ type: "image_url", image_url: { url: image_url } }])] }] })
    }, "video-timing", config.model);
    if (!response.ok) throw new Error(`CC Switch Chat Completions 请求失败（HTTP ${response.status}），请检查本机网关连接。`);
    return extractText(body);
  }
}

export async function readConfig(file?: string, modelOverride?:string, reasoningOverride?: AiReasoningEffort): Promise<CcSwitchConfig> {
  const resolved = file?.trim()
    ? await readCcSwitchConfigFile(path.resolve(file), modelOverride, "env")
    : await new AiConfigService().resolve(modelOverride, reasoningOverride);
  return { baseUrl: resolved.baseUrl, model: resolved.model, wireApi: resolved.wireApi, reasoningEffort: reasoningOverride || resolved.reasoningEffort || "high", bearer: resolved.bearer };
}

function extractText(body: unknown): string {
  const texts: string[] = [];
  const visit = (value: unknown, fromContent = false) => {
    if (typeof value === "string") return;
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (!value || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    for (const key of ["output_text", "text"]) if (typeof object[key] === "string") texts.push(object[key] as string);
    // `content` can be a string in Chat Completions, or an array of typed parts
    // in Responses. Read it once and avoid traversing the same text twice.
    if (typeof object.content === "string") texts.push(object.content);
    else if (object.content !== undefined) visit(object.content, true);
    for (const key of ["output", "choices", "message", "parts"]) if (object[key] !== undefined) visit(object[key], fromContent);
  };
  visit(body);
  const result = texts.join("\n").trim();
  if (!result) throw new Error("CC Switch 没有返回可解析的视觉分析文本");
  return result;
}

function stripJsonFence(value: string): string {
  return value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}
