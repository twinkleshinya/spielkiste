import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { editorHarness } from "./sfx-edit-preview-ui.test.js";

export async function testSfxStartupDefaultsToNewProject() {
  const html = await fs.readFile(path.resolve("src/ui/public/sfx.html"), "utf8");
  const source = await fs.readFile(path.resolve("src/ui/public/sfx.js"), "utf8");

  assert.doesNotMatch(html, /id="name"[^>]*value="[^"]+"/, "a new project must not show a pre-filled project name");

  assert.match(source, /function resetToNewProject\(/, "the UI needs one reset path for a blank project");
  assert.match(source, /if\s*\(initialId\)\s*\{/, "only an explicit run query may open a saved run on startup");
  assert.doesNotMatch(source, /initialParams\.get\("new"\)!=="1"/, "the absence of ?new=1 must not restore the last project");
  assert.doesNotMatch(source, /const id=initialId\|\|\(await api\("\/api\/sfx\/workspace"\)\.runId\)/, "startup must not ask the server for the last opened project");
  assert.doesNotMatch(source, /preserveLibraryInputs/, "all new-project entrances must clear historical inputs");
  assert.match(source, /\$\("name"\)\.value\s*=\s*""/, "resetting to a new project must clear the project name");

  const remembered = {libraryPath:"D:\\PreviousLibrary",musicLibraryPath:"D:\\Music",libraryPreferences:[{path:"D:\\Preferred",weight:3}],keywordPreferences:[{keyword:"metal",weight:3,scope:"all"}],excludedLibraryPaths:["D:\\Excluded"],excludedKeywords:["start"],referenceWorks:["参考作品"],videoDescription:"旧说明",soundRequirements:"旧声音要求"};
  const ui = await editorHarness(new Map([["sfx-last-input", JSON.stringify(remembered)]]));
  const saved={...ui.getRun(),...remembered};ui.context.saved=saved;
  for(const entrance of ['resetToNewProject()', '$("open-new-project").onclick({preventDefault(){}})', '$("new-project").onclick({preventDefault(){}})']) {
    ui.exec('run=structuredClone(saved);loadProjectInputs()');
    assert.equal(ui.$("library-path").value,saved.libraryPath,"explicitly opening a project restores its own settings");
    assert.equal(ui.exec('libraryPreferences.read()[0].path'),remembered.libraryPreferences[0].path);
    assert.equal(ui.exec('keywordPreferences.read()[0].keyword'),'metal');
    await ui.exec(entrance);
    for(const id of ["name","video-path","library-path","music-library-path","reference-works","video-description","sound-requirements","sound-style","custom-style"]) assert.equal(ui.$(id).value,"",`${entrance} must clear ${id}`);
    for(const code of ['libraryPreferences.read()','keywordPreferences.read()','exclusionSettings().excludedLibraryPaths','exclusionSettings().excludedKeywords']) assert.equal(ui.exec(`${code}.length`),0,`${entrance} must clear ${code}`);
    assert.equal(ui.storage.get('sfx-last-input'),JSON.stringify(remembered),'new-project reset does not modify saved settings or project drafts');
  }
}
