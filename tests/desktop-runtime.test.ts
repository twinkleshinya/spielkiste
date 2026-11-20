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
