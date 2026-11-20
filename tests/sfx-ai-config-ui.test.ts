import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import vm from "node:vm";

export async function testAiConfigDialogSavesTestsAndReopens() {
  const js = await fs.readFile(path.resolve("src/ui/public/sfx.js"), "utf8");
  const elements = new Map<string, any>();
  const $ = (id: string): any => {
    if (!elements.has(id)) elements.set(id, { value: "", textContent: "", className: "", dataset: {}, disabled: false, showModal() {}, close() {} });
    return elements.get(id);
  };
  let saved: any = { configured: false, ready: false, source: "missing" };
  const calls: string[] = [];
  const context = vm.createContext({ $, status() {}, aiConfig: null, api: async (url: string, body?: any) => {
    calls.push(body === undefined ? "read" : url.endsWith("/test") ? "test" : "save");
    if (url.endsWith("/test")) {
      saved = { ...saved, ready: true };
      return { ok: true, model: "gemini-team", elapsedMs: 10, capabilities: { vision: true, audio: true } };
    }
    if (body) saved = { ...body, source: "user", configured: true, ready: false, hasBearer: true, bearer: undefined };
    return saved;
  } });
  vm.runInContext(js.slice(js.indexOf("function renderAiConfig("), js.indexOf("async function renderWorkflowReport(")), context);
  $("ai-config-base-url").value = "https://gateway.example/v1";
  $("ai-config-model").value = "gemini-team";
  $("ai-config-bearer").value = "test-only-secret";
  $("ai-config-wire-api").value = "chat_completions";
  await $("ai-config-form").onsubmit({ preventDefault() {} });
  assert.ok(calls.indexOf("test") > calls.indexOf("save"), "the primary button must save and actually test the new configuration");
  assert.equal($("ai-config-bearer").value, "");
  assert.match($("ai-config-status").textContent, /已连接/);
  await $("ai-config-open").onclick();
  assert.equal($("ai-config-base-url").value, "https://gateway.example/v1");
  assert.equal($("ai-config-model").value, "gemini-team");
  $("ai-config-bearer").value = "discarded-secret";
  $("ai-config-close").onclick();
  assert.equal($("ai-config-bearer").value, "", "closing settings clears unsubmitted credentials");
}

export async function testAiConfigUi() {
  const html = await fs.readFile(path.resolve("src/ui/public/sfx.html"), "utf8");
  const js = await fs.readFile(path.resolve("src/ui/public/sfx.js"), "utf8");
  const css = await fs.readFile(path.resolve("src/ui/public/sfx.css"), "utf8");
  assert.match(html, /AI 连接/);
  assert.match(html, /ai-config-dialog/);
  assert.match(html, /ai-config-path/);
  assert.match(html, /ai-config-model/);
  assert.match(html, /test-ai-config/);
  assert.match(js, /\/api\/sfx\/ai-config/);
  assert.match(js, /readyForGeneration|ai-config-status/);
  assert.equal(js.includes("localStorage.setItem(\"ai"), false, "AI credentials must not be saved to browser storage");
  assert.match(css, /ai-config-dialog/);
}

export async function testAiConfigModelSwitchPersistsAndReopens() {
  const html = await fs.readFile(path.resolve("src/ui/public/sfx.html"), "utf8");
  const js = await fs.readFile(path.resolve("src/ui/public/sfx.js"), "utf8");
  assert.match(html, /<select\b[^>]*id="ai-config-model-select"/);
  assert.match(html, /<option\b[^>]*value="gemini-4-argon"/);
  assert.match(html, /<option\b[^>]*value="gemini-4-hydrogen"/);
  assert.match(html, /id="ai-config-reasoning"/);
  assert.match(html, /value="xhigh">Extreme High/);
  const elements = new Map<string, any>();
  const $ = (id: string): any => {
    if (!elements.has(id)) elements.set(id, { value: "", textContent: "", className: "", dataset: {}, disabled: false, hidden: false, showModal() {}, close() {} });
    return elements.get(id);
  };
  let saved: any = { configured: true, ready: true, source: "user", model: "gemini-4-argon", configPath: "C:/team/config.toml", wireApi: "responses" };
  const testedModels: string[] = [];
  const context = vm.createContext({ $, status() {}, aiConfig: saved, api: async (url: string, body?: any) => {
    if (url.endsWith("/test")) {
      testedModels.push(body.model);
      saved = { ...saved, ready: true };
      return { ok: true, model: body.model, elapsedMs: 10 };
    }
    if (body) saved = { ...body, configured: true, ready: false, source: "user", hasBearer: true };
    return saved;
  } });
  vm.runInContext(js.slice(js.indexOf("function renderAiConfig("), js.indexOf("async function renderWorkflowReport(")), context);
  await $("ai-config-open").onclick();
  assert.equal($("ai-config-model-select").value, "gemini-4-argon");
  assert.equal($("ai-config-custom-model").hidden, true);
  $("ai-config-model-select").value = "gemini-4-hydrogen";
  $("ai-config-model-select").onchange();
  $("ai-config-reasoning").value = "xhigh";
  $("ai-config-reasoning").onchange();
  await $("ai-config-form").onsubmit({ preventDefault() {} });
  assert.equal(saved.model, "gemini-4-hydrogen");
  assert.equal(saved.reasoningEffort, "xhigh");
  assert.equal(saved.configPath, "C:/team/config.toml", "model switching must keep the CC Switch configuration");
  await $("ai-config-open").onclick();
  assert.equal($("ai-config-model-select").value, "gemini-4-hydrogen");
  assert.equal($("ai-config-reasoning").value, "xhigh");
  assert.match($("ai-config-status").textContent, /gemini-4-hydrogen/);
  $("ai-config-model-select").value = "gemini-4-argon";
  $("ai-config-model-select").onchange();
  await $("ai-config-form").onsubmit({ preventDefault() {} });
  assert.equal(saved.reasoningEffort, "xhigh", "Argon must retain the user-selected effort rather than silently lowering it");
  assert.deepEqual(testedModels, ["gemini-4-hydrogen", "gemini-4-argon"]);
  saved = { ...saved, model: "gemini-team" };
  await $("ai-config-open").onclick();
  assert.equal($("ai-config-model-select").value, "custom");
  assert.equal($("ai-config-custom-model").hidden, false);
  assert.equal($("ai-config-model").value, "gemini-team", "an existing custom model must remain editable");
}
