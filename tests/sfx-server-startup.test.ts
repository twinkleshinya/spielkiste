import assert from "node:assert/strict";
import http from "node:http";
import { SFX_API_VERSION, SFX_REQUIRED_CAPABILITIES, isCurrentSfxHealth } from "../src/ui/SfxServerCompatibility.js";
import { handleSfxRequest } from "../src/ui/sfx-routes.js";

export function testSfxHealthCompatibilityMarker() {
  assert.ok(SFX_API_VERSION.length > 0);
  assert.ok(SFX_REQUIRED_CAPABILITIES.includes("add-described-event"));
  const current = { ok: true, standard: { workflow: "reference-v6" }, apiVersion: SFX_API_VERSION, capabilities: SFX_REQUIRED_CAPABILITIES };
  assert.equal(isCurrentSfxHealth(current), true);
  assert.equal(isCurrentSfxHealth({ ...current, apiVersion: "old" }), false);
  assert.equal(isCurrentSfxHealth({ ...current, capabilities: ["quick-edit"] }), false);
  assert.equal(isCurrentSfxHealth({}), false);
}

export async function testSfxHealthRouteAdvertisesCompatibility() {
  const server = http.createServer((req, res) => {
    void handleSfxRequest(req, res, new URL(req.url!, "http://localhost"), {} as never);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/sfx/health`);
    assert.equal(response.status, 200);
    assert.equal(isCurrentSfxHealth(await response.json()), true);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
