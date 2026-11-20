import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AiConfigService, type AiConfigInput } from "../src/sfx/SfxAiConfig.js";
import { CcSwitchAudioProvider } from "../src/sfx/CcSwitchAudioProvider.js";
import { CcSwitchVisionProvider } from "../src/sfx/CcSwitchVisionProvider.js";
import { ReaperExporter } from "../src/sfx/ReaperExporter.js";
import { fixtureRun, writeReaperFixtures } from "./sfx-reaper-export.test.js";

async function isolated(check: (service: AiConfigService, root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "spielkiste-first-use-"));
  const overrides: Record<string, string | undefined> = {
    USERPROFILE: root, LOCALAPPDATA: path.join(root, "local"), CODEX_HOME: path.join(root, ".codex"),
    SFX_AI_CONFIG_PATH: path.join(root, "local", "ai-config.json"), SFX_USE_CCSWITCH: undefined,
    SFX_CCSWITCH_CONFIG: undefined, SFX_CCSWITCH_BASE_URL: undefined, SFX_CCSWITCH_BEARER: undefined,
    SFX_CCSWITCH_MODEL: undefined, SFX_CCSWITCH_WIRE_API: undefined, SFX_CCSWITCH_REASONING_EFFORT: undefined
  };
  const before = new Map(Object.keys(overrides).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(overrides)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  try { await check(new AiConfigService(), root); }
  finally {
    for (const [key, value] of before) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(root, { recursive: true, force: true });
  }
}

const manual: AiConfigInput = { baseUrl: "https://gateway.example/v1", model: "gemini-team", bearer: "test-only-secret", wireApi: "chat_completions" };

export async function testOnboardingModelDefaultDoesNotOverrideSavedGateway() {
  await isolated(async service => {
    await service.save(manual);
    process.env.SFX_CCSWITCH_MODEL = "gemini-4-argon";
    const restarted = await new AiConfigService().resolve();
    assert.equal(restarted.baseUrl, "https://gateway.example/v1", "copying .env.example must not discard the manually saved gateway");
    assert.equal(restarted.model, "gemini-team");
  });
}

export async function testOnboardingChangingGatewayNeverReusesOldAuthorization() {
  await isolated(async service => {
    await service.save(manual);
    await service.save({ ...manual, baseUrl: "https://other.example/v1", bearer: undefined });
    assert.equal((await service.resolve()).bearer, undefined, "an old gateway credential must never be forwarded to a new gateway");
  });
}

export async function testOnboardingAutomaticDiscoveryUsesActiveProvider() {
  await isolated(async (service, root) => {
    await fs.mkdir(path.join(root, ".codex"));
    await fs.writeFile(path.join(root, ".codex", "config.toml"), 'model_provider = "company" # active\nmodel = "gpt-chat"\n[model_providers.custom]\nbase_url = "https://inactive.example/v1"\n[model_providers.company]\nbase_url = "https://active.example/v1" # gateway\nwire_api = "responses"\nexperimental_bearer_token = "file-test-secret"\n');
    await service.save({ model: "gemini-team" });
    const active = await service.resolve();
    assert.equal(active.baseUrl, "https://active.example/v1");
    assert.equal(active.bearer, "file-test-secret");
    assert.equal(active.model, "gemini-team", "the global chat model must not replace this tool's Gemini model");
  });
}

export async function testOnboardingManualUrlSurvivesDialogReopen() {
  await isolated(async service => {
    await service.save({ ...manual, configPath: "C:/stale/config.toml" });
    const snapshot = await new AiConfigService().snapshot();
    assert.equal(snapshot.configPath, undefined, "manual URL takes precedence and must remain editable after reopening");
    assert.equal(snapshot.baseUrl, "https://gateway.example/v1");
  });
}

export async function testOnboardingReadinessBelongsToTestedConfiguration() {
  await isolated(async service => {
    await service.save(manual);
    assert.equal((await service.snapshot()).ready, false, "saving untested credentials cannot claim an active connection");
    const result = await service.testConnection(undefined, async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const content = body.messages?.[0]?.content || body.input?.[0]?.content;
      const hasAudio = content.some((part: any) => part.type === "input_audio");
      return Response.json({ model: "gemini-team", choices: [{ message: { content: JSON.stringify(hasAudio ? { kind: "tone" } : { color: "green" }) } }] });
    });
    assert.equal(result.ok, true);
    await service.recordTest(result);
    assert.equal((await new AiConfigService().snapshot()).ready, true, "a restart preserves the successful test for exactly this configuration");
    await service.recordTest({ ok: false, elapsedMs: 1 }, { ...manual, baseUrl: "https://unsaved.example/v1" });
    assert.equal((await service.snapshot()).lastTestOk, true, "testing an unsaved gateway must not claim the saved gateway failed");
    await service.save({ ...manual, bearer: "new-test-secret" });
    assert.equal((await service.snapshot()).ready, false, "changing authorization invalidates an earlier successful test");
  });
}

export async function testOnboardingConnectionExercisesImageAndAudio() {
  await isolated(async service => {
    let images = 0, audio = 0;
    const result = await service.testConnection(manual, async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const content = body.messages?.[0]?.content || body.input?.[0]?.content;
      const imagePart = content.find((part: any) => ["input_image", "image_url"].includes(part.type));
      const audioPart = content.find((part: any) => part.type === "input_audio");
      if (imagePart) images++;
      if (audioPart) {
        audio++;
        assert.equal(Buffer.from(audioPart.input_audio.data, "base64").subarray(0, 4).toString(), "RIFF");
        return Response.json({ error: { message: "audio unsupported" } }, { status: 400 });
      }
      return Response.json({ model: "gemini-team", choices: [{ message: { content: imagePart ? '{"color":"green"}' : "OK" } }] });
    });
    assert.equal(result.ok, false, "text or image success alone cannot certify the sound-selection connection");
    assert.equal(images, 1);
    assert.equal(audio, 1);
    assert.match(result.error || "", /音频/);
    const malformed = await service.testConnection(manual, async () => Response.json({ model: "gemini-team" }));
    assert.equal(malformed.ok, false, "HTTP 200 with no model output is not a successful connection");
  });
}

export async function testOnboardingProvidersUseSavedModel() {
  await isolated(async (service, root) => {
    const previousFetch = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)); seen.push(body.model);
      return Response.json({ model: "gemini-team", choices: [{ message: { content: "{}" } }] });
    };
    try {
      const thumbnail = path.join(root, "image.jpg"); await fs.writeFile(thumbnail, "fixture");
      for (const model of ["gemini-4-argon", "gemini-4-hydrogen"]) {
        await service.save({ ...manual, model });
        await new CcSwitchAudioProvider().choose([]);
        await new CcSwitchVisionProvider().analyzeFrames([{ start: 0, end: 1, thumbnail }], "fixture");
      }
      assert.deepEqual(seen, ["gemini-4-argon", "gemini-4-argon", "gemini-4-hydrogen", "gemini-4-hydrogen"], "timing and audio selection must both follow each selected model");
    } finally { globalThis.fetch = previousFetch; }
  });
}

export async function testOnboardingModelsHaveSeparateReadiness() {
  await isolated(async service => {
    const passed = { ok: true, elapsedMs: 1, capabilities: { vision: true, audio: true } };
    await service.save({ ...manual, model: "gemini-4-argon" });
    await service.recordTest(passed);
    assert.equal((await service.snapshot()).ready, true);
    await service.save({ baseUrl: manual.baseUrl, model: "gemini-4-hydrogen" });
    assert.equal((await service.resolve()).bearer, manual.bearer, "changing models on the same gateway keeps authorization");
    assert.equal((await service.snapshot()).ready, false, "Argon success must not certify Hydrogen media input");
    await service.recordTest(passed);
    assert.equal((await service.snapshot()).ready, true);
    await service.save({ baseUrl: manual.baseUrl, model: "gemini-4-argon" });
    assert.equal((await service.snapshot()).ready, true, "switching back keeps the matching model's successful test");
  });
}

export async function testOnboardingReasoningLevelsReachEveryMediaRequest() {
  await isolated(async (service, root) => {
    const previousFetch = globalThis.fetch;
    const thumbnail = path.join(root, "image.jpg"); await fs.writeFile(thumbnail, "fixture");
    let expected = "high";
    const observed: string[] = [];
    const fakeFetch: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.reasoning?.effort || body.reasoning_effort, expected, "every image/audio request must carry the selected effort");
      observed.push(body.model);
      const content = body.input?.[0]?.content || body.messages?.[0]?.content;
      const result = content.some((p: any) => p.type === "input_audio") ? {kind:"tone"} : {color:"green"};
      return Response.json({model:body.model,choices:[{message:{content:JSON.stringify(result)}}]});
    };
    globalThis.fetch = fakeFetch;
    try {
      for (const model of ["gemini-4-argon", "gemini-4-hydrogen"]) {
        for (const reasoningEffort of ["high", "xhigh"] as const) {
          expected = reasoningEffort;
          await service.save({...manual, model, reasoningEffort} as AiConfigInput);
          assert.equal((await new AiConfigService().snapshot() as any).reasoningEffort, reasoningEffort);
          assert.equal((await service.snapshot()).ready, false, "each model/effort requires its own media test");
          const result = await service.testConnection(undefined, fakeFetch);
          assert.equal(result.ok, true, result.error);
          await service.recordTest(result);
          assert.equal((await service.snapshot()).ready, true);
          const audio = new CcSwitchAudioProvider(); await audio.initialize();
          await service.save({...manual, model, reasoningEffort:reasoningEffort === "high" ? "xhigh" : "high"} as AiConfigInput);
          await audio.choose([]); // Initialization freezes the selected effort during a job.
          await service.save({...manual, model, reasoningEffort, wireApi:"responses"} as AiConfigInput);
          await new CcSwitchVisionProvider().analyzeFrames([{start:0,end:1,thumbnail}], "fixture");
        }
      }
      assert.equal(observed.length, 16);
      await assert.rejects(service.save({...manual, reasoningEffort:"invalid"} as unknown as AiConfigInput), /推理/);
    } finally { globalThis.fetch = previousFetch; }
  });
}

export async function testOnboardingReaperExportNeedsNoPersonalTemplate() {
  await isolated(async (_service, root) => {
    const run = fixtureRun(root); await writeReaperFixtures(run);
    const result = await new ReaperExporter(undefined, path.join(root, "metadata")).exportRun(run, { outputPath: path.join(root, "portable", "team.rpp") });
    const rpp = await fs.readFile(result.outputPath, "utf8");
    assert.equal(result.manifest.templatePath.includes("AI音效测试"), false, "team exports must use the bundled template rather than this developer's personal project");
    assert.equal(rpp.includes("E:\\Reaper"), false);
    assert.equal(result.placementTrackCount, 4);
    assert.ok(result.manifest.media.every(file => !path.isAbsolute(file.relativePath)));
  });
}
