import assert from "node:assert/strict";
import path from "node:path";

export async function testDesktopRuntimeResources() {
  const previous=process.env.SPIELKISTE_RESOURCE_ROOT;
  process.env.SPIELKISTE_RESOURCE_ROOT=path.resolve(".output/test-app-resources");
  try {
    const {appResource}=await import("../src/sfx/RuntimePaths.js");
    assert.equal(appResource("src","ui","public"),path.resolve(".output/test-app-resources/src/ui/public"));
    assert.throws(()=>appResource("../credentials"),/资源路径/);
    assert.equal(path.resolve("projects"),path.join(process.cwd(),"projects"),"runtime data remains independent of immutable resources");
  } finally {if(previous===undefined)delete process.env.SPIELKISTE_RESOURCE_ROOT;else process.env.SPIELKISTE_RESOURCE_ROOT=previous;}
}

export async function testDesktopAllowsMultipleInstancesAndIndependentPanels() {
  const fs = await import("node:fs/promises");
  const main = await fs.readFile(path.resolve("desktop/main.cjs"), "utf8");
  const backend = await fs.readFile(path.resolve("desktop/backend.cjs"), "utf8");
  const css = await fs.readFile(path.resolve("src/ui/public/sfx.css"), "utf8");
  assert.doesNotMatch(main, /requestSingleInstanceLock\s*\(/, "desktop EXE must allow multiple windows");
  assert.match(backend, /process\.env\.PORT\s*=\s*['\"]0['\"]/, "each desktop backend must request a random port");
  assert.match(css, /\.events-panel,\.inspector\{height:calc\(100vh - 170px\)/, "event and placement panels need independent desktop heights");
  assert.match(css, /\.event-list\{flex:1;min-height:0;max-height:none;overflow:auto/, "event list needs its own scroll area");
  assert.match(css, /\.inspector-sound-selection\{flex:1 1 45%;min-height:120px;overflow:auto/, "sound selection needs its own scroll area");
  assert.match(css, /\.inspector-placement-scroll\{flex:1 1 35%;min-height:110px;overflow:auto/, "placement editor needs its own scroll area");
}
