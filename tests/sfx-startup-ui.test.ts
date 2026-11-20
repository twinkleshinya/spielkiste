import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

export async function testSfxStartupDefaultsToNewProject() {
  const source = await fs.readFile(path.resolve("src/ui/public/sfx.js"), "utf8");

  assert.match(source, /function resetToNewProject\(/, "the UI needs one reset path for a blank project");
  assert.match(source, /if\s*\(initialId\)\s*\{/, "only an explicit run query may open a saved run on startup");
  assert.doesNotMatch(source, /initialParams\.get\("new"\)!=="1"/, "the absence of ?new=1 must not restore the last project");
  assert.doesNotMatch(source, /const id=initialId\|\|\(await api\("\/api\/sfx\/workspace"\)\.runId\)/, "startup must not ask the server for the last opened project");
  assert.match(source, /resetToNewProject\(\{preserveLibraryInputs:true\}\)/, "a new default project may retain library convenience paths without reopening old media");
}
