import assert from "node:assert/strict";
import { promises as fs } from "node:fs";

export async function testWebStartupUsesSharedGitWatcher() {
  const launcher = await fs.readFile("scripts/start-web.mjs", "utf8");
  const sfx = await fs.readFile("scripts/start-sfx.mjs", "utf8");
  const batch = await fs.readFile("start-ui.bat", "utf8");
  const packager = await fs.readFile("scripts/package-spielkiste.ps1", "utf8");
  assert.match(launcher, /startToolWatcher\(process\.cwd\(\)\)/);
  assert.match(launcher, /stopStaleServer\(\)/);
  assert.match(batch, /node scripts\/start-web\.mjs/);
  assert.match(batch, /webEntry/);
  assert.match(batch, /SPIELKISTE_DISABLE_TOOL_WATCHER/);
  assert.match(sfx, /SPIELKISTE_DISABLE_TOOL_WATCHER/);
  assert.match(packager, /start-web\.mjs/);
  assert.match(packager, /tool-git\.mjs/);
  assert.match(packager, /tool-git\.json/);
}
