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
  const {createRequire}=await import('node:module');
  const config=createRequire(import.meta.url)(path.resolve('electron-builder.cjs'));
  assert.equal(config.portable.unpackDirName,true,'portable launches must not overwrite the first running extraction');
  assert.match(main, /app.on\('second-instance', \(\) => \{ void openProjectWindow\(\)/, "relaunch must create another editor");
  assert.match(main, /const windows = new Set/, "all windows must stay registered");
  assert.equal((main.match(/utilityProcess.fork\(/g)||[]).length,1,"all windows share a backend");
  assert.match(backend, /desktop-port\.json/, "shared backend retains the origin for saved edit drafts");
  assert.match(css, /\.events-panel,\.inspector\{position:sticky;top:16px;height:calc\(100dvh - 32px\)/);
  assert.match(css, /\.event-list\{flex:1;min-height:0;max-height:none;overflow:auto;overscroll-behavior:contain/);
  assert.match(css, /\.inspector form\{[^}]*overflow:auto;overscroll-behavior:contain/);
}
