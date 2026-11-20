import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AiConfigService,
  aiConfigFilePath,
  getDefaultAiConfigPath,
  redactBaseUrl,
  type AiConfigInput,
  type AiConfigSnapshot
} from "../src/sfx/SfxAiConfig.js";

function envWith(overrides: Record<string, string | undefined>) {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  };
}

export async function testAiConfigDiscoveryAndPrecedence() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfx-ai-config-"));
  const userProfile = path.join(root, "user");
  const localAppData = path.join(root, "local");
  const codexHome = path.join(userProfile, ".codex");
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(path.join(codexHome, "config.toml"), '[model_providers.custom]\nbase_url = "http://127.0.0.1:15721/v1"\nwire_api = "responses"\nexperimental_bearer_token = "secret-token"\n');
  const restore = envWith({
    USERPROFILE: userProfile,
    HOMEDRIVE: undefined,
    HOMEPATH: undefined,
    LOCALAPPDATA: localAppData,
    CODEX_HOME: codexHome,
    SFX_AI_CONFIG_PATH: undefined,
    SFX_CCSWITCH_CONFIG: undefined,
    SFX_CCSWITCH_BASE_URL: undefined,
    SFX_CCSWITCH_BEARER: undefined,
    SFX_CCSWITCH_MODEL: undefined,
    SFX_USE_CCSWITCH: undefined
  });
  try {
    const service = new AiConfigService();
    const discovered = await service.snapshot("gemini-4-argon");
    assert.equal(discovered.source, "discovered");
    assert.equal(discovered.ready, false, "automatic discovery still requires a media connection test");
    assert.equal(discovered.baseUrl, "http://127.0.0.1:15721/v1");
    assert.equal(discovered.wireApi, "responses");
    assert.equal(discovered.hasBearer, true);
    assert.equal(JSON.stringify(discovered).includes("secret-token"), false);

    await service.save({ model: "gemini-user", baseUrl: "https://gateway.example/v1", bearer: "stored-secret" });
    const stored = await service.snapshot();
    assert.equal(stored.source, "user");
    assert.equal(stored.model, "gemini-user");
    assert.equal(stored.baseUrl, "https://gateway.example/v1");
    assert.equal(stored.hasBearer, true);
    assert.equal(JSON.stringify(stored).includes("stored-secret"), false);
    assert.equal(getDefaultAiConfigPath(), path.join(localAppData, "Spielkiste", "ai-config.json"));
    assert.equal(aiConfigFilePath(), getDefaultAiConfigPath());
  } finally {
    restore();
    await fs.rm(root, { recursive: true, force: true });
  }
}

export async function testAiConfigValidationAndSafePersistence() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfx-ai-config-validation-"));
  const configPath = path.join(root, "ai-config.json");
  const restore = envWith({ SFX_AI_CONFIG_PATH: configPath, SFX_USE_CCSWITCH: undefined });
  try {
    const service = new AiConfigService();
    await assert.rejects(service.save({ model: "gpt-6.1-sol", baseUrl: "https://gateway.example/v1" }), /Gemini/);
    await assert.rejects(service.save({ model: "gemini-test", baseUrl: "ftp://gateway.example/v1" }), /URL/);
    await assert.rejects(service.save({ model: "gemini-test", configPath: path.join(root, "missing.toml") }), /配置/);
    await service.save({ model: "gemini-test", baseUrl: "https://gateway.example/v1", bearer: "do-not-return" });
    const raw = await fs.readFile(configPath, "utf8");
    assert.match(raw, /do-not-return/);
    const snapshot = await service.snapshot();
    assert.equal(snapshot.ready, false);
    assert.equal(snapshot.bearer, undefined);
    assert.equal(JSON.stringify(snapshot).includes("do-not-return"), false);
    assert.equal(redactBaseUrl("https://user:pass@gateway.example/v1?token=secret"), "https://gateway.example/v1");
    await service.save({ model: "gemini-test", baseUrl: "https://gateway.example/v1" });
    assert.equal((await service.snapshot()).hasBearer, true, "editing non-secret settings must retain the existing local bearer");
  } finally {
    restore();
    await fs.rm(root, { recursive: true, force: true });
  }
}

export async function testAiConfigConnectionTest() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfx-ai-config-test-"));
  const configPath = path.join(root, "ai-config.json");
  const restore = envWith({ SFX_AI_CONFIG_PATH: configPath, SFX_USE_CCSWITCH: undefined });
  try {
    const service = new AiConfigService();
    const input: AiConfigInput = { model: "gemini-test", baseUrl: "http://gateway.test/v1", bearer: "secret" };
    const success = await service.testConnection(input, async (_url: string | URL, init?: RequestInit) => {
      assert.match(String(init?.body), /gemini-test/);
      assert.equal((init?.headers as Record<string, string>).authorization, "Bearer secret");
      const body = JSON.parse(String(init?.body));
      const audio = body.messages?.[0]?.content.some((part: any) => part.type === "input_audio");
      return Response.json({ id: "ok", model: "gemini-test", output: [{ content: [{ text: JSON.stringify(audio ? { kind: "tone" } : { color: "green" }) }] }] });
    });
    assert.equal(success.ok, true);
    assert.equal(success.model, "gemini-test");
    assert.equal(success.returnedModel, "gemini-test");

    await service.save(input);
    const savedTest=await service.testConnection({},async(_url,init)=>{
      const body=JSON.parse(String(init?.body));assert.equal(body.model,'gemini-test','empty test input must use the saved model');
      assert.equal((init?.headers as Record<string,string>).authorization,'Bearer secret');
      const audio=body.messages?.[0]?.content.some((part:any)=>part.type==='input_audio');
      return Response.json({model:'gemini-test',choices:[{message:{content:JSON.stringify(audio?{kind:'tone'}:{color:'green'})}}]});
    });
    assert.equal(savedTest.ok,true);await service.recordTest(savedTest,{});assert.equal((await service.snapshot()).ready,true);
    const retained = await service.testConnection({ model: "gemini-test", baseUrl: "http://gateway.test/v1" }, async (_url: string | URL, init?: RequestInit) => {
      assert.equal((init?.headers as Record<string, string>).authorization, "Bearer secret", "saved local authorization is reused without returning it to the browser");
      const body = JSON.parse(String(init?.body));
      const audio = body.messages?.[0]?.content.some((part: any) => part.type === "input_audio");
      return Response.json({ model: "gemini-test", choices: [{ message: { content: JSON.stringify(audio ? { kind: "tone" } : { color: "green" }) } }] });
    });
    assert.equal(retained.ok, true);

    const failure = await service.testConnection(input, async () => new Response("bad", { status: 401 }));
    assert.equal(failure.ok, false);
    assert.equal(failure.status, 401);
    assert.equal(failure.error?.includes("secret"), false);

    const invalidJson = await service.testConnection(input, async () => new Response("not-json", { status: 200 }));
    assert.equal(invalidJson.ok, false);
    assert.match(invalidJson.error || "", /JSON/);
  } finally {
    restore();
    await fs.rm(root, { recursive: true, force: true });
  }
}

export async function testAiConfigDisabledSnapshot() {
  const restore = envWith({ SFX_USE_CCSWITCH: "0", SFX_AI_CONFIG_PATH: undefined });
  try {
    const snapshot: AiConfigSnapshot = await new AiConfigService().snapshot("gemini-4-argon");
    assert.equal(snapshot.ready, false);
    assert.equal(snapshot.source, "disabled");
    assert.match(snapshot.error || "", /关闭/);
  } finally { restore(); }
}

export async function testAiConfigFailedTestBlocksGenerationReadiness() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfx-ai-config-last-test-"));
  const configPath = path.join(root, "ai-config.json");
  const discoveredPath = path.join(root, "ccswitch.toml");
  await fs.writeFile(discoveredPath, '[model_providers.custom]\nbase_url = "http://gateway.test/v1"\n');
  const restore = envWith({ SFX_AI_CONFIG_PATH: configPath, SFX_USE_CCSWITCH: undefined });
  try {
    const service = new AiConfigService();
    await service.recordTest({ ok: false, status: 401, elapsedMs: 1, error: "网关请求失败" }, { configPath: discoveredPath, model: "gemini-4-argon" });
    const blocked = await service.snapshot();
    // The saved test state only blocks the matching discovered configuration.
    const matching = new AiConfigService(configPath);
    await matching.save({ configPath: discoveredPath, model: "gemini-4-argon" });
    const blockedMatching = await matching.snapshot();
    assert.equal(blockedMatching.ready, false);
    assert.equal(blockedMatching.lastTestOk, false);
    assert.match(blockedMatching.error || "", /上次连接测试失败/);
  } finally {
    restore();
    await fs.rm(root, { recursive: true, force: true });
  }
}
