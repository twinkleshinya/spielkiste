import assert from "node:assert/strict";
import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { modelJson, withModelUsage } from "../src/sfx/ModelUsage.js";

export async function testSfxUsageIsolation() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfx-usage-"));
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.setHeader("x-request-id", "request-fixture");
    res.end(JSON.stringify(req.url === "/known" ? { model: "gemini-fixture", usage: { prompt_tokens: 100, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 40 } } } : { choices: [] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await Promise.all([
      withModelUsage("first", path.join(root, "first"), "analysis", async () => { await modelJson(base + "/known", { headers: { authorization: "secret-must-never-be-recorded" } }, "video-timing", "gemini-fixture"); }),
      withModelUsage("second", path.join(root, "second"), "selection", async () => { await modelJson(base + "/missing", {}, "audio-choose", "gemini-fixture"); })
    ]);
    const firstText = await fs.readFile(path.join(root, "first", "usage-report.json"), "utf8");
    const first = JSON.parse(firstText), second = JSON.parse(await fs.readFile(path.join(root, "second", "usage-report.json"), "utf8"));
    assert.equal(first.totals.requests, 1);
    assert.equal(first.totals.inputTokens, 100);
    assert.equal(first.totals.outputTokens, 12);
    assert.equal(first.totals.cachedInputTokens, 40);
    assert.equal(first.requests[0].requestId, "request-fixture");
    assert.equal(first.totals.requestsMissingUsage, 0);
    assert.equal(second.totals.requestsMissingUsage, 1, "missing usage must not be presented as a measured zero-token request");
    assert.equal(second.requests[0].inputTokens, null);
    assert.equal(second.requests[0].phase, "audio-choose");
    assert.equal(firstText.includes("secret-must-never-be-recorded"), false);
    await withModelUsage("first", path.join(root, "first"), "render", async () => {});
    assert.equal((await fs.readdir(path.join(root, "first", "usage-history"))).length, 2, "rerendering must keep the original model usage history");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }); }
}
import { generationFetch } from "../src/sfx/ModelUsage.js";
export async function testGenerationHttpKeepsCallerCancellation() {
  const server=http.createServer((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.write('{');});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const controller=new AbortController();
    const response=await generationFetch(`http://127.0.0.1:${(server.address() as {port:number}).port}`,{signal:controller.signal});
    const body=response.text();
    controller.abort(new Error('user cancelled'));
    await assert.rejects(body);
  } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
