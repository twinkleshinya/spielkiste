import assert from "node:assert/strict";
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleSfxRequest } from "../src/ui/sfx-routes.js";
import { SfxService } from "../src/sfx/SfxService.js";
import { isCurrentSfxHealth } from "../src/ui/SfxServerCompatibility.js";

async function withServer(handler: http.RequestListener): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise(resolve => server.close(() => resolve())) };
}

export async function testAiConfigApi() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfx-ai-config-api-"));
  const configPath = path.join(root, "ai-config.json");
  const previous = new Map<string, string | undefined>([
    ["SFX_AI_CONFIG_PATH", process.env.SFX_AI_CONFIG_PATH],
    ["SFX_USE_CCSWITCH", process.env.SFX_USE_CCSWITCH],
    ["SFX_USE_GEMINI", process.env.SFX_USE_GEMINI],
    ["GEMINI_API_KEY", process.env.GEMINI_API_KEY],
    ["SFX_CCSWITCH_CONFIG", process.env.SFX_CCSWITCH_CONFIG],
    ["SFX_CCSWITCH_MODEL", process.env.SFX_CCSWITCH_MODEL]
  ]);
  process.env.SFX_AI_CONFIG_PATH = configPath;
  process.env.SFX_USE_CCSWITCH = "0";
  delete process.env.SFX_CCSWITCH_CONFIG;
  delete process.env.SFX_CCSWITCH_MODEL;
  const service = new SfxService(path.join(root, "output"));
  const app = await withServer((req, res) => { void handleSfxRequest(req, res, new URL(req.url!, `http://${req.headers.host}`), service); });
  const gateway = await withServer((req, res) => {
    if (req.url?.endsWith("/chat/completions")) {
      const chunks: Buffer[] = [];
      req.on("data", chunk => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const audio = body.messages[0].content.some((part: any) => part.type === "input_audio");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: "gemini-test", choices: [{ message: { content: JSON.stringify(audio ? { kind: "tone" } : { color: "green" }) } }] }));
      });
    } else { res.writeHead(404); res.end("missing"); }
  });
  const post = (url: string, body: unknown) => fetch(app.base + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const initial = await fetch(app.base + "/api/sfx/ai-config");
    assert.equal(initial.status, 200);
    const initialBody = await initial.json() as { ready: boolean; hasBearer: boolean; error?: string };
    assert.equal(initialBody.ready, false);
    assert.equal(initialBody.hasBearer, false);

    assert.equal((await post("/api/sfx/runs", {})).status, 400, "invalid input must not be masked by AI readiness");
    const video = path.join(root, "test.mp4"); await fs.writeFile(video, "unread fixture");
    const blockedWithoutAi = await post("/api/sfx/runs", { workflowPreset: "reference-v6", videoPath: video, libraryPath: root });
    assert.equal(blockedWithoutAi.status, 503, "standard generation must fail before scanning when AI is unavailable");
    assert.match((await blockedWithoutAi.json() as { error: string }).error, /Gemini AI/);

    process.env.SFX_USE_GEMINI = "1";
    delete process.env.GEMINI_API_KEY;
    const blockedWithoutDirectKey = await post("/api/sfx/runs", { workflowPreset: "reference-v6", videoPath: video, libraryPath: root });
    assert.equal(blockedWithoutDirectKey.status, 503, "an enabled but empty direct Gemini setting must not bypass CC Switch validation");
    delete process.env.SFX_USE_GEMINI;

    process.env.SFX_USE_CCSWITCH = "1";
    assert.equal((await post("/api/sfx/ai-config", { reasoningEffort: "invalid" })).status, 400);
    const saved = await post("/api/sfx/ai-config", { baseUrl: gateway.base + "/v1", model: "gemini-test", bearer: "api-secret", reasoningEffort:"xhigh" });
    assert.equal(saved.status, 200);
    const savedBody = await saved.json() as { ready: boolean; model: string; baseUrl: string; hasBearer: boolean; bearer?: string };
    assert.equal(savedBody.ready, false);
    assert.equal(savedBody.model, "gemini-test");
    assert.equal((savedBody as any).reasoningEffort, "xhigh");
    assert.equal(savedBody.baseUrl, gateway.base + "/v1");
    assert.equal(savedBody.hasBearer, true);
    assert.equal(savedBody.bearer, undefined);
    assert.equal(JSON.stringify(savedBody).includes("api-secret"), false);

    const tested = await post("/api/sfx/ai-config/test", { baseUrl: gateway.base + "/v1", model: "gemini-test", bearer: "api-secret", reasoningEffort:"xhigh" });
    assert.equal(tested.status, 200);
    assert.equal((await tested.json() as { ok: boolean }).ok, true);
    const reopened = await fetch(app.base + "/api/sfx/ai-config");
    assert.equal((await reopened.json() as { ready: boolean }).ready, true);

    const health = await fetch(app.base + "/api/sfx/health");
    assert.equal(health.status, 200);
    const healthBody = await health.json() as { ai: { ready: boolean }; readyForGeneration: boolean };
    assert.equal(healthBody.ai.ready, true);
    assert.equal(healthBody.readyForGeneration, true);
    assert.equal(isCurrentSfxHealth(healthBody), true);
  } finally {
    await app.close(); await gateway.close();
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(root, { recursive: true, force: true });
  }
}
