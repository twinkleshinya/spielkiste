import assert from "node:assert/strict";
import path from "node:path";
import { importedLibraryPath, importedVideoPath } from "../src/sfx/SfxImport.js";

export function testSfxImportPaths() {
  const root = path.resolve(".output", "sfx", "imports", "test");
  assert.equal(importedLibraryPath(root), path.join(root, "audio_references"));
  assert.equal(importedVideoPath(root, "clip.mp4"), path.join(root, "videos", "clip.mp4"));
  assert.throws(() => importedVideoPath(root, "..\\outside.mp4"), /非法/);
}
