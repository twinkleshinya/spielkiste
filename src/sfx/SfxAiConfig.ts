import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export type AiReasoningEffort = "high" | "xhigh";
export type AiWireApi = "responses" | "chat_completions";
export type AiConfigSource = "env" | "user" | "discovered" | "manual" | "disabled" | "missing";

export type AiConfigInput = {
  mode?: "ccswitch";
  configPath?: string;
  model?: string;
  reasoningEffort?: AiReasoningEffort;
  baseUrl?: string;
  bearer?: string;
  wireApi?: AiWireApi;
};

export type RuntimeAiConfig = {
  baseUrl: string;
  model: string;
  reasoningEffort?: AiReasoningEffort;
  wireApi: AiWireApi;
  bearer?: string;
  source: AiConfigSource;
  configPath?: string;
};

export type AiConfigSnapshot = {
  configured: boolean;
  ready: boolean;
  source: AiConfigSource;
  configPath?: string;
  baseUrl?: string;
  model: string;
  reasoningEffort?: AiReasoningEffort;
  wireApi?: AiWireApi;
  hasBearer: boolean;
  error?: string;
  lastTestAt?: string;
  lastTestOk?: boolean;
  capabilities?: { vision: boolean; audio: boolean };
  bearer?: never;
};

export type AiConnectionResult = {
  ok: boolean;
  status?: number;
  elapsedMs: number;
  model?: string;
  reasoningEffort?: AiReasoningEffort;
  returnedModel?: string;
  capabilities?: { vision: boolean; audio: boolean };
  error?: string;
};

type StoredAiConfig = AiConfigInput;
type AiTestState = { fingerprint: string; lastTestAt: string; lastTestOk: boolean; capabilities?: { vision: boolean; audio: boolean } };
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const DEFAULT_MODEL = "gemini-4-argon";
// Tiny synthetic fixtures verify both actual media input paths without sending user media.
const PROBE_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAe0lEQVR4nO3PUQkAIBTAwBfDAPYPYyJD+HEIgwW4zTr764YLGtCCBrSgAS1oQAsa0IIGtKABLWhACxrQgga0oAEtaEALGtCCBrSgAS1oQAsa0IIGtKABLWhACxrQgga0oAEtaEALGtCCBrSgAS1oQAsa0IIGtKABLXjsAkw94PFStS9wAAAAAElFTkSuQmCC";

function probeAudio(): string {
  const samples = 8000, audio = Buffer.alloc(44 + samples * 2);
  audio.write("RIFF"); audio.writeUInt32LE(audio.length - 8, 4); audio.write("WAVEfmt ", 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(32000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write("data", 36); audio.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) audio.writeInt16LE(Math.round(6000 * Math.sin(2 * Math.PI * 440 * i / 16000)), 44 + i * 2);
  return audio.toString("base64");
}

export function getDefaultAiConfigPath(): string {
  const localAppData = process.env.LOCALAPPDATA?.trim();
  const userProfile = process.env.USERPROFILE?.trim() || process.env.HOME?.trim() || os.homedir();
  return localAppData ? path.join(localAppData, "Spielkiste", "ai-config.json") : path.join(userProfile, ".spielkiste", "ai-config.json");
}

export function getDefaultCcSwitchConfigPath(): string {
  const explicit = process.env.SFX_CCSWITCH_CONFIG?.trim();
  if (explicit) return path.resolve(explicit);
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(process.env.USERPROFILE?.trim() || process.env.HOME?.trim() || os.homedir(), ".codex");
  return path.join(codexHome, "config.toml");
}

export function redactBaseUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

export class AiConfigService {
  constructor(private readonly configPath = process.env.SFX_AI_CONFIG_PATH?.trim() || getDefaultAiConfigPath()) {}

  async snapshot(modelOverride?: string): Promise<AiConfigSnapshot> {
    try {
      const config = await this.resolve(modelOverride);
      const states = await this.readTestStates();
      const currentFingerprint = configFingerprint(config);
      const matchingState = states.find(state => state.fingerprint === currentFingerprint);
      const ready = matchingState?.lastTestOk === true && matchingState.capabilities?.vision === true && matchingState.capabilities.audio === true;
      return {
        configured: true,
        ready,
        source: config.source,
        configPath: config.configPath,
        baseUrl: redactBaseUrl(config.baseUrl),
        model: config.model,
        reasoningEffort: config.reasoningEffort || "high",
        wireApi: config.wireApi,
        hasBearer: Boolean(config.bearer),
        error: ready ? undefined : matchingState?.lastTestOk === false ? "上次连接测试失败，请重新测试 Gemini 连接" : "配置已读取，请测试图片与音频连接后开始生成",
        lastTestAt: matchingState?.lastTestAt,
        lastTestOk: matchingState?.lastTestOk,
        capabilities: matchingState?.capabilities
      };
    } catch (error) {
      const stored = await this.readStored();
      const source: AiConfigSource = process.env.SFX_USE_CCSWITCH === "0" ? "disabled" : stored ? "user" : "missing";
      return {
        configured: Boolean(stored),
        ready: false,
        source,
        configPath: stored?.configPath || getDefaultCcSwitchConfigPath(),
        baseUrl: redactBaseUrl(stored?.baseUrl),
        model: stored?.model || process.env.SFX_CCSWITCH_MODEL?.trim() || modelOverride || DEFAULT_MODEL,
        reasoningEffort: stored?.reasoningEffort || "high",
        wireApi: stored?.wireApi,
        hasBearer: Boolean(stored?.bearer),
        error: safeError(error)
      };
    }
  }

  async resolve(modelOverride?: string, reasoningOverride?: AiReasoningEffort): Promise<RuntimeAiConfig> {
    if (process.env.SFX_USE_CCSWITCH === "0") throw new Error("AI 连接被环境变量关闭，请移除 SFX_USE_CCSWITCH=0 并重启工作台。");
    const envConfig = await this.fromEnvironment(modelOverride);
    if (envConfig) return { ...envConfig, reasoningEffort: reasoningOverride || envConfig.reasoningEffort || "high" };
    const stored = await this.readStored();
    if (stored) {
      const userConfig = await this.fromInput(stored, modelOverride, "user");
      if (userConfig) return { ...userConfig, reasoningEffort: reasoningOverride || userConfig.reasoningEffort || "high" };
    }
    const discoveredPath = getDefaultCcSwitchConfigPath();
    return { ...await readCcSwitchConfigFile(discoveredPath, modelOverride || process.env.SFX_CCSWITCH_MODEL?.trim(), "discovered"), reasoningEffort: reasoningOverride || normalizeReasoning(process.env.SFX_CCSWITCH_REASONING_EFFORT) };
  }

  async save(input: AiConfigInput): Promise<AiConfigSnapshot> {
    const normalized = normalizeInput(input);
    const merged = await this.withSavedBearer(normalized);
    await this.fromInput(merged, merged.model, "manual");
    const stored: StoredAiConfig = { ...merged };
    await this.writeStored(stored);
    return this.snapshot();
  }

  async testConnection(input?: AiConfigInput, fetchImpl: FetchLike = fetch): Promise<AiConnectionResult> {
    if(input && Object.values(input).every(value=>value===undefined))input=undefined;
    const started = Date.now();
    let config: RuntimeAiConfig;
    try {
      if (input) {
        const normalized = await this.withSavedBearer(normalizeInput(input));
        config = await this.fromInput(normalized, input.model || DEFAULT_MODEL, "manual");
      } else config = await this.resolve();
    } catch (error) {
      return { ok: false, elapsedMs: Date.now() - started, error: safeError(error) };
    }
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (config.bearer && config.bearer !== "PROXY_MANAGED") headers.authorization = `Bearer ${config.bearer}`;
    const imagePrompt = '判断附件图片占据绝大部分面积的颜色，只回复 JSON {"color":"green"} 或 {"color":"other"}。';
    const imageBody = config.wireApi === "responses"
      ? { model: config.model, reasoning: { effort: config.reasoningEffort || "high" }, input: [{ role: "user", content: [{ type: "input_text", text: imagePrompt }, { type: "input_image", image_url: PROBE_IMAGE }] }], temperature: 0 }
      : { model: config.model, reasoning_effort: config.reasoningEffort || "high", messages: [{ role: "user", content: [{ type: "text", text: imagePrompt }, { type: "image_url", image_url: { url: PROBE_IMAGE } }] }], temperature: 0 };
    const audioBody = { model: config.model, reasoning_effort: config.reasoningEffort || "high", temperature: 0, messages: [{ role: "user", content: [
      { type: "text", text: '判断附件音频是否为固定音高的纯音；纯音回复 JSON {"kind":"tone"}，无声回复 {"kind":"silence"}，其它回复 {"kind":"other"}。只回复 JSON。' },
      { type: "input_audio", input_audio: { data: probeAudio(), format: "wav" } }
    ] }] };
    const capabilities = { vision: false, audio: false };
    let returnedModel: string | undefined, status: number | undefined;
    for (const probe of [
      { name: "图片分析", path: config.wireApi === "responses" ? "responses" : "chat/completions", body: imageBody, capability: "vision" as const, field: "color", expected: "green" },
      { name: "音频判断", path: "chat/completions", body: audioBody, capability: "audio" as const, field: "kind", expected: "tone" }
    ]) {
      try {
        const response = await fetchImpl(`${config.baseUrl}/${probe.path}`, { method: "POST", headers, body: JSON.stringify(probe.body), signal: AbortSignal.timeout(45_000) });
        status = response.status;
        let parsed: any;
        try { parsed = JSON.parse(await response.text()); } catch { throw new Error("网关返回的不是有效 JSON"); }
        if (!response.ok) throw new Error(safeGatewayError(parsed, response.status));
        returnedModel = typeof parsed?.model === "string" ? parsed.model : returnedModel;
        if (returnedModel && !/^gemini(?:-|$)/i.test(returnedModel)) throw new Error("网关返回的模型不是 Gemini");
        const content = responseText(parsed).replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
        let answer: any;
        try { answer = JSON.parse(content); } catch { throw new Error("模型未返回有效的媒体判断结果"); }
        if (String(answer?.[probe.field]).toLowerCase() !== probe.expected) throw new Error("模型未正确识别测试媒体，请确认网关支持该模型的图片及音频输入");
        capabilities[probe.capability] = true;
      } catch (error) {
        return { ok: false, status, elapsedMs: Date.now() - started, model: config.model, reasoningEffort: config.reasoningEffort || "high", returnedModel, capabilities, error: `${probe.name}测试失败：${safeError(error)}` };
      }
    }
    return { ok: true, status, elapsedMs: Date.now() - started, model: config.model, reasoningEffort: config.reasoningEffort || "high", returnedModel, capabilities };
  }

  async recordTest(result: AiConnectionResult, input?: AiConfigInput): Promise<void> {
    if(input && Object.values(input).every(value=>value===undefined))input=undefined;
    // Keep test status in a separate, non-secret user file. Testing an
    // unsaved dialog value must never create a config containing a bearer.
    let config: RuntimeAiConfig;
    try {
      config = input ? await this.fromInput(await this.withSavedBearer(normalizeInput(input)), input.model || DEFAULT_MODEL, "manual") : await this.resolve();
    } catch {
      return;
    }
    const state: AiTestState = { fingerprint: configFingerprint(config), lastTestAt: new Date().toISOString(), lastTestOk: result.ok, capabilities: result.capabilities };
    const states = await this.readTestStates();
    await this.writeUserFile(this.testStatePath(), { version: 2, tests: [...states.filter(s => s.fingerprint !== state.fingerprint), state].slice(-20) });
  }

  private async fromEnvironment(modelOverride?: string): Promise<RuntimeAiConfig | undefined> {
    const configPath = process.env.SFX_CCSWITCH_CONFIG?.trim();
    const baseUrl = process.env.SFX_CCSWITCH_BASE_URL?.trim();
    const bearer = process.env.SFX_CCSWITCH_BEARER?.trim();
    const model = modelOverride || process.env.SFX_CCSWITCH_MODEL?.trim() || DEFAULT_MODEL;
    if (!configPath && !baseUrl && !bearer) return undefined;
    if (configPath && !baseUrl) return { ...await readCcSwitchConfigFile(path.resolve(configPath), model, "env"), reasoningEffort: normalizeReasoning(process.env.SFX_CCSWITCH_REASONING_EFFORT) };
    return this.fromInput({ configPath, baseUrl, bearer, model, reasoningEffort: normalizeReasoning(process.env.SFX_CCSWITCH_REASONING_EFFORT), wireApi: (process.env.SFX_CCSWITCH_WIRE_API as AiWireApi | undefined) || "chat_completions" }, model, "env");
  }

  private async fromInput(input: AiConfigInput, modelOverride: string | undefined, source: AiConfigSource): Promise<RuntimeAiConfig> {
    const model = modelOverride?.trim() || input.model?.trim() || DEFAULT_MODEL;
    assertGemini(model);
    if (input.baseUrl?.trim()) return { baseUrl: normalizeUrl(input.baseUrl), model, reasoningEffort: normalizeReasoning(input.reasoningEffort), wireApi: input.wireApi || "chat_completions", bearer: input.bearer?.trim() || undefined, source };
    const file = input.configPath?.trim() || getDefaultCcSwitchConfigPath();
    return { ...await readCcSwitchConfigFile(path.resolve(file), model, source), reasoningEffort: normalizeReasoning(input.reasoningEffort) };
  }

  private async readStored(): Promise<StoredAiConfig | undefined> {
    try { return JSON.parse(await fs.readFile(this.configPath, "utf8")) as StoredAiConfig; } catch { return undefined; }
  }

  private testStatePath(): string { return path.join(path.dirname(this.configPath), "ai-test-state.json"); }
  private async withSavedBearer(input: AiConfigInput): Promise<AiConfigInput> {
    const stored = await this.readStored();
    return { ...input, bearer: input.bearer || (stored && sameEndpoint(input, stored) ? stored.bearer : undefined) };
  }
  private async readTestStates(): Promise<AiTestState[]> {
    try {
      const value = JSON.parse(await fs.readFile(this.testStatePath(), "utf8"));
      return value?.version === 2 && Array.isArray(value.tests) ? value.tests.filter((s: AiTestState) => typeof s.fingerprint === "string" && typeof s.lastTestOk === "boolean") : [];
    } catch { return []; }
  }
  private async writeStored(stored: StoredAiConfig): Promise<void> {
    await this.writeUserFile(this.configPath, stored);
  }
  private async writeUserFile(file: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
  }
}

export async function readCcSwitchConfigFile(file: string, modelOverride?: string, source: AiConfigSource = "discovered"): Promise<RuntimeAiConfig> {
  let text: string;
  try { text = await fs.readFile(file, "utf8"); } catch { throw new Error(`未找到 CC Switch 配置：${file}`); }
  const rootBlock = text.split(/^\s*\[/m)[0];
  const provider = readTomlString(rootBlock, "model_provider") || "custom";
  const providerName = provider.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const providerBlock = text.match(new RegExp(`^\\s*\\[model_providers\\.(?:${providerName}|"${providerName}"|'${providerName}')\\]([\\s\\S]*?)(?=^\\s*\\[|(?![\\s\\S]))`, "m"))?.[1] || "";
  const baseUrl = readTomlString(providerBlock, "base_url");
  if (!baseUrl) throw new Error(`CC Switch 当前配置缺少 ${provider}.base_url；也可在 AI 连接中手动填写网关`);
  const model = modelOverride?.trim() || readTomlString(providerBlock, "model") || process.env.SFX_CCSWITCH_MODEL?.trim() || DEFAULT_MODEL;
  assertGemini(model);
  const wireApi = readTomlString(providerBlock, "wire_api") === "responses" ? "responses" : "chat_completions";
  const envKey = readTomlString(providerBlock, "env_key");
  let bearer = readTomlString(providerBlock, "experimental_bearer_token") || (envKey ? process.env[envKey]?.trim() : undefined);
  if (!bearer && /^\s*requires_openai_auth\s*=\s*true\b/m.test(providerBlock)) {
    try { bearer = JSON.parse(await fs.readFile(path.join(path.dirname(file), "auth.json"), "utf8")).OPENAI_API_KEY?.trim(); } catch { /* manual authorization remains available */ }
  }
  return { baseUrl: normalizeUrl(baseUrl), model, reasoningEffort: "high", wireApi, bearer, source, configPath: path.resolve(file) };
}

export function aiConfigFilePath(): string {
  return process.env.SFX_AI_CONFIG_PATH?.trim() || getDefaultAiConfigPath();
}

function configFingerprint(config: RuntimeAiConfig): string {
  return createHash("sha256").update(JSON.stringify([config.baseUrl, config.model, config.wireApi, config.bearer || "", config.reasoningEffort || "high"])).digest("hex");
}

function normalizeInput(input: AiConfigInput): AiConfigInput {
  const output: AiConfigInput = {
    mode: "ccswitch",
    configPath: input.configPath?.trim() || undefined,
    model: input.model?.trim() || DEFAULT_MODEL,
    reasoningEffort: normalizeReasoning(input.reasoningEffort),
    baseUrl: input.baseUrl?.trim() || undefined,
    bearer: input.bearer?.trim() || undefined,
    wireApi: input.wireApi || "chat_completions"
  };
  assertGemini(output.model!);
  if (output.baseUrl) { output.baseUrl = normalizeUrl(output.baseUrl); output.configPath = undefined; }
  return output;
}

function sameEndpoint(a: AiConfigInput, b: AiConfigInput): boolean {
  const baseA = a.baseUrl ? normalizeUrl(a.baseUrl) : "";
  const baseB = b.baseUrl ? normalizeUrl(b.baseUrl) : "";
  const pathA = a.configPath ? path.resolve(a.configPath) : "";
  const pathB = b.configPath ? path.resolve(b.configPath) : "";
  return baseA || baseB ? baseA === baseB : pathA === pathB;
}

function normalizeUrl(value: string): string {
  const url = new URL(value.trim());
  if (!/^https?:$/.test(url.protocol)) throw new Error("网关 URL 只支持 http 或 https");
  url.username = ""; url.password = ""; url.search = ""; url.hash = "";
  return url.toString().replace(/\/$/, "").replace(/\/(?:chat\/completions|responses)$/, "");
}

function assertGemini(model: string): void {
  if (!/^gemini(?:-|$)/i.test(model)) throw new Error("Spielkiste AI 配置必须使用 Gemini 模型");
}

function readTomlString(text: string, key: string): string | undefined {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*([\\\"'])(.*?)\\1\\s*(?:#.*)?$`, "m").exec(text);
  return match?.[2]?.trim() || undefined;
}

function responseText(body: any): string {
  if (typeof body?.output_text === "string") return body.output_text;
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  const parts = Array.isArray(content) ? content : (body?.output || []).flatMap((item: any) => item.content || []);
  return parts.map((part: any) => typeof part.text === "string" ? part.text : "").join("\n");
}

function safeGatewayError(body: any, status: number): string {
  // Do not echo arbitrary gateway error text into the browser: proxies may
  // include request headers or credential fragments in their diagnostics.
  if (body?.error?.message || body?.error) return `网关拒绝请求（HTTP ${status}）`;
  return `网关请求失败（HTTP ${status}）`;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+\S+/gi, "Bearer <redacted>").replace(/(token|key|secret|password)\s*[=:]\s*\S+/gi, "$1=<redacted>").slice(0, 500);
}

function normalizeReasoning(value: string | undefined): AiReasoningEffort {
  if (!value) return "high";
  if (value === "high" || value === "xhigh") return value;
  throw new Error("推理强度只支持 high 或 xhigh（Extreme High）");
}
