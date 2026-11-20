import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

const root = path.resolve(".");

export async function testDescribedEventUiIsAnAddEventMode() {
  const html = await fs.readFile(path.join(root, "src/ui/public/sfx.html"), "utf8");
  const js = await fs.readFile(path.join(root, "src/ui/public/sfx.js"), "utf8");
  assert.match(html, /id="described-event-box"/);
  assert.match(html, /id="add-event"[^>]*aria-controls="described-event-box"/);
  assert.match(html, /id="add-event"[^>]*aria-expanded="false"/);
  assert.match(html, /id="add-manual-event"/);
  assert.match(html, /描述补声/);
  assert.match(js, /openAddEventMode/);
  assert.match(js, /setAttribute\("aria-expanded", "true"\)/);
  assert.match(js, /setAttribute\("aria-expanded", "false"\)/);
  assert.match(js, /addedEvents/);
  assert.match(js, /selectEvent\(addedEvents\[0\]\.id/);
}
