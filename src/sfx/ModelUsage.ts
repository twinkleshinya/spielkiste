import { Agent } from "undici";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { writeJson } from "./SfxRunStore.js";
import {taskCheckpoint,taskSignal} from './TaskControl.js';
import {gatewayErrorInfo} from './ModelGatewayError.js';

type RequestUsage = { phase: string; requestedModel: string; reasoningEffort?: string; returnedModel?: string; requestId?: string; startedAt: string; elapsedMs: number; status: number | null; inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null;requestBytes?:number;errorCode?:string };
type JobUsage = { version: number; runId: string; operation: string; startedAt: string; elapsedMs: number; success: boolean; phases: { phase: string; elapsedMs: number }[]; requests: RequestUsage[] };
const context = new AsyncLocalStorage<JobUsage>();
const count = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

// Scoped to generation HTTP calls. Do not change the app's global dispatcher.
// Zero disables header/body waiting limits; caller cancellation still applies.
const generationDispatcher = new Agent({headersTimeout: 0, bodyTimeout: 0});
export async function generationFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
  await taskCheckpoint();
  return fetch(url, {...init, signal:taskSignal(init.signal||undefined), dispatcher: generationDispatcher} as RequestInit);
}

/** Only usage counters, request identifiers and timings are persisted. */
export async function modelJson(url: string, init: RequestInit, phase: string, model: string): Promise<{ response: Response; body: any }> {
  const started = Date.now();
  const entry: RequestUsage = { phase, requestedModel: model, startedAt: new Date(started).toISOString(), elapsedMs: 0, status: null, inputTokens: null, outputTokens: null, cachedInputTokens: null };
  try {
    if(typeof init.body==='string')entry.requestBytes=Buffer.byteLength(init.body);
    const request = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const effort = request?.reasoning?.effort || request?.reasoning_effort;
    if (effort === "high" || effort === "xhigh") entry.reasoningEffort = effort;
  } catch { /* Usage recording must never prevent a model request. */ }
  try {
    const response = await generationFetch(url, init);
    entry.status = response.status;
    const body = await response.json().catch(() => undefined);
    if(!response.ok)entry.errorCode=gatewayErrorInfo(body,response.status).code;
    entry.requestId = response.headers.get("x-request-id") || response.headers.get("request-id") || (typeof body?.id === "string" ? body.id : undefined);
    if (typeof body?.model === "string") entry.returnedModel = body.model;
    const usage = body?.usage || body?.usageMetadata;
    entry.inputTokens = count(usage?.input_tokens ?? usage?.prompt_tokens ?? usage?.promptTokenCount);
    entry.outputTokens = count(usage?.output_tokens ?? usage?.completion_tokens ?? usage?.candidatesTokenCount);
    entry.cachedInputTokens = count(usage?.input_tokens_details?.cached_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? usage?.cachedContentTokenCount);
    await taskCheckpoint();
    return { response, body };
  } finally { entry.elapsedMs = Date.now() - started; context.getStore()?.requests.push(entry); }
}

export async function usagePhase<T>(phase: string, work: () => Promise<T>): Promise<T> {
  await taskCheckpoint();
  const started = Date.now();
  try { const result=await work();await taskCheckpoint();return result; }
  finally { context.getStore()?.phases.push({ phase, elapsedMs: Date.now() - started }); }
}

export async function withModelUsage(runId: string, outputDir: string, operation: string, work: () => Promise<void>) {
  const started = Date.now();
  const report: JobUsage = { version: 1, runId, operation, startedAt: new Date(started).toISOString(), elapsedMs: 0, success: false, phases: [], requests: [] };
  await context.run(report, async () => {
    try { await work(); report.success = true; }
    finally {
      report.elapsedMs = Date.now() - started;
      const known = report.requests.filter(r => r.inputTokens !== null && r.outputTokens !== null);
      const summary = { ...report, completedAt: new Date().toISOString(), totals: {
        requests: report.requests.length, requestsWithUsage: known.length, requestsMissingUsage: report.requests.length - known.length,
        inputTokens: known.reduce((sum, r) => sum + r.inputTokens!, 0), outputTokens: known.reduce((sum, r) => sum + r.outputTokens!, 0),
        cachedInputTokens: report.requests.reduce((sum, r) => sum + (r.cachedInputTokens ?? 0), 0)
      }, note: "Token来自本任务API响应；未返回usage的请求明确标缺失，不估算为零。缓存token包含在输入token口径中；不代表公司账单。复用点位及音频缓存不会重复计入旧请求。" };
      await writeJson(path.join(outputDir, "usage-history", `${report.startedAt.replace(/[:.]/g, "-")}-${randomUUID()}.json`), summary);
      await writeJson(path.join(outputDir, "usage-report.json"), summary);
    }
  });
}
