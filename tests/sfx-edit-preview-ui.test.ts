import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { planSourceEdit, edgeFades } from "../src/sfx/ClipEdit.js";
import {assetExclusionReasonResolver} from "../src/sfx/AssetExclusions.js";
import { fixtureRun } from "./sfx-reaper-export.test.js";

// Execute the browser's real handlers; only DOM/media/network boundaries are faked.
export async function editorHarness(storage = new Map<string, string>()) {
  const source = await fs.readFile(path.resolve("src/ui/public/sfx.js"), "utf8");
  const elements = new Map<string, any>();
  const node = () => ({ value: "", textContent: "", hidden: false, disabled: false, checked: false, dataset: {}, style: {}, children: [] as any[], paused: true, currentTime: .7, src: "accepted-preview.mp4", elements: [],
    classList: { toggle() {}, add() {}, remove() {} }, append(...values: any[]) { this.children.push(...values); }, replaceChildren(...values: any[]) { this.children = values; },
    addEventListener() {}, setAttribute() {}, removeAttribute() {}, scrollIntoView() {}, focus() {}, load() {}, showModal() { this.open=true; }, close() { this.open=false; }, open:false, reportValidity: () => true,
    pause() { this.paused = true; }, async play() { this.paused = false; }, add(value: any) { this.children.push(value); }
  });
  const $ = (id: string) => { if (!elements.has(id)) elements.set(id, node()); return elements.get(id); };
  const calls: Array<{ url: string; body?: any }> = [];
  const initial = fixtureRun(path.resolve("fixture-library"));
  initial.render = { video: "accepted-preview.mp4", audio: "accepted-preview.wav", revision: initial.revision };
  let nextRun = structuredClone(initial);
  let failUpdate = false;
  let failRender = false;
  let failSaveVersion=false;
  const keywords = { values: [] as any[], read() { return this.values; }, load(values: any[] = []) { this.values = values; }, setBusy() {} };
  const directories = { values: [] as any[], read() { return this.values; }, load(values: any[] = []) { this.values = values; }, setBusy() {} };
  const exclusions:Record<string,any>={};
  const createExclusions=(container:any,options:any)=>{const key=container===$("excluded-library-paths")?"paths":"keywords";return exclusions[key]={values:[] as string[],read(){return this.values;},load(values:string[]=[]){this.values=values;},setBusy(){},change(values:string[]){this.values=values;options.onChange();}};};
  const context = vm.createContext({
    document: { getElementById: $, createElement: node, querySelector: (s: string) => s.includes("reaper-channel-mode") ? { value: "preserve" } : null },
    window: { addEventListener() {}, confirm: () => true }, localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    location: { href: "http://localhost/sfx", search: "" }, history: { replaceState() {} }, URL, URLSearchParams, structuredClone, crypto,
    Option: function(value: string, id: string) { return { textContent: value, value: id }; }, setTimeout, clearTimeout, planSourceEdit, edgeFades,
    chooseLocalFolder: async () => null, createKeywordPreferences: () => keywords, createLibraryPreferences: () => directories,
    createLibraryExclusions:createExclusions,createKeywordExclusions:createExclusions,assetExclusionReasonResolver,
    fetch: async (url: string, options?: any) => {
      const body = options?.body ? JSON.parse(options.body) : undefined;
      calls.push({ url, body });
      const response = (data: any, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => data });
      if(url.endsWith('/save-version')){
        if(failSaveVersion)return response({error:'test save failure'},false);
        nextRun=JSON.parse(JSON.stringify(vm.runInContext('run',context)));
        nextRun.id='22222222-2222-4222-8222-222222222222';nextRun.name=body.name;nextRun.revision++;
        nextRun.render={...nextRun.render!,revision:nextRun.revision};return response({runId:nextRun.id,projectId:nextRun.projectId});
      }
      if (/\/(edit-preview|quick-edit|render)$/.test(url)) {
        if (failUpdate) return response({ error: "test update failure" }, false);
        const current = vm.runInContext("run", context);
        nextRun = JSON.parse(JSON.stringify(current));
        nextRun.id = "22222222-2222-4222-8222-222222222222";
        nextRun.revision += 1;
        nextRun.render = { video: "updated-preview.mp4", audio: "updated-preview.wav", revision: nextRun.revision };
        if (failRender) { nextRun.status = "failed"; nextRun.error = "新预览未生成：test render failure"; nextRun.render = initial.render; }
        return response({ runId: nextRun.id });
      }
      if (url.endsWith("/status")) return response({ status: nextRun.status, progress: "ready" });
      if (url.endsWith('/search')) return response([]);
      if (url==="/api/sfx/runs") return response({runId:nextRun.id});
      if (url.endsWith("/export/reaper")) return response({ outputPath: body.outputPath, projectDirectory: "folder", placementTrackCount: 1, folderTrackCount: 2, manifest: { media: [] }, settings: body });
      if (/\/runs\/[^/]+$/.test(url)) return response(structuredClone(nextRun));
      if (url.endsWith("/versions") || url === "/api/sfx/projects") return response([]);
      return response({});
    }
  });
  const executable = source.slice(0, source.indexOf("const initialParams=")).replace(/^import[^\r\n]+\r?\n/gm, "");
  vm.runInContext(executable, context);
  context.fixture = structuredClone(initial);
  vm.runInContext('run = fixture; selectedId = "boss-event"; selectedLayerId = "main"; showingPreview = true;', context);
  $("event-filter").value = "all";
  $("reaper-audio-format").value = "preserve";
  $("reaper-sample-rate").value = "0";
  $("reaper-dither").value = "auto";
  vm.runInContext('selectEvent("boss-event");', context);
  return { $, calls, storage, context, exclusions, exec: (code: string) => vm.runInContext(code, context), getRun: () => JSON.parse(JSON.stringify(vm.runInContext("run", context))), isDirty: () => vm.runInContext("dirty", context), failSaveVersion:(value=true)=>{failSaveVersion=value;}, failUpdate: () => { failUpdate = true; }, failRender: () => { failRender = true; }, setNextRun: (value: typeof initial) => { nextRun = structuredClone(value); } };
}

export async function testGenerateRequiresExplicitClick() {
  const ui=await editorHarness();
  let prevented=false;
  await ui.$('create-form').onsubmit({preventDefault(){prevented=true;}});
  assert.equal(prevented,true);
  assert.equal(ui.calls.some(c=>c.url==='/api/sfx/runs'),false,'Enter submit must never start generation');
  assert.equal(typeof ui.$('analyze').onclick,'function');
  ui.$('video-description').value='角色释放剑气';ui.$('sound-requirements').value='重点是蓄力';ui.$('sound-style').value='修仙';ui.$('audio-output-mode').value='music';
  await ui.$('analyze').onclick({preventDefault(){}});
  const sent=ui.calls.find(c=>c.url==='/api/sfx/runs');
  assert.ok(sent);assert.equal(sent.body.videoDescription,'角色释放剑气');assert.equal(sent.body.style,'修仙');assert.equal(sent.body.audioOutputMode,'music','generation mode must be sent explicitly');
}

export async function testFailedGenerationShowsCauseAndAllowsRetry() {
  const ui=await editorHarness();
  ui.exec('run.status="failed";run.error="文件扫描超过 10 分钟";run.render=undefined;');
  ui.context.fetch=async()=>({ok:true,json:async()=>({runStatus:'failed',error:'文件扫描超过 10 分钟',quality:{status:'failed',checks:[]},profile:{name:'标准流程',version:'1.0.7'},effective:{},stages:[]})});
  await ui.exec('renderWorkflowReport()');
  assert.match(ui.$('workflow-run-title').textContent,/生成失败/);
  assert.match(ui.$('workflow-run-note').textContent,/文件扫描超过/);
  ui.exec('renderWorkspace()');
  assert.equal(ui.$('reanalyze-visual').hidden,false);
  assert.equal(ui.$('reanalyze-brief').hidden,false);
}

export async function testSfxExclusionsStageRestoreAndGuard() {
  const storage=new Map<string,string>(),ui=await editorHarness(storage),before=ui.getRun();
  const excludedDirectory=path.dirname(before.assets[0].path);
  assert.ok(ui.exclusions.paths&&ui.exclusions.keywords,"both exclusion inputs must be initialized in the real page script");
  ui.exclusions.paths.change([excludedDirectory]);ui.exclusions.keywords.change(["replacement"]);
  assert.equal(ui.isDirty(),true);assert.equal(ui.calls.filter(c=>c.body&&/edit-preview|render/.test(c.url)).length,0);
  const draft=JSON.parse(storage.get(`sfx-draft:${before.id}`)!);
  assert.deepEqual(draft.edit.excludedLibraryPaths,[excludedDirectory]);assert.deepEqual(draft.edit.excludedKeywords,["replacement"]);
  assert.deepEqual(ui.getRun().placements,before.placements,"changing exclusion settings cannot delete or repick sounds");
  const replacement={...before.assets[0],id:"banned",fileName:"replacement_roar.wav"};ui.context.replacement=replacement;
  await assert.rejects(ui.exec('chooseAsset(replacement, "main")'),/排除|禁用/);
  const refreshed=await editorHarness(storage);await refreshed.exec('poll(run.id, true)');
  assert.deepEqual(Array.from(refreshed.exclusions.paths.read()),[excludedDirectory]);assert.deepEqual(Array.from(refreshed.exclusions.keywords.read()),["replacement"]);
  await refreshed.$("search").onclick({preventDefault(){}});
  const request=refreshed.calls.find(c=>c.url.endsWith("/search"));
  assert.deepEqual(request!.body.excludedLibraryPaths,[excludedDirectory]);assert.deepEqual(request!.body.excludedKeywords,["replacement"]);
  await refreshed.$("render").onclick({preventDefault(){}});
  const submitted=refreshed.calls.find(c=>c.url.endsWith("/edit-preview"))!;
  assert.deepEqual(submitted.body.excludedLibraryPaths,[excludedDirectory]);assert.deepEqual(submitted.body.excludedKeywords,["replacement"]);
  refreshed.exec('resetToNewProject()');assert.deepEqual(Array.from(refreshed.exclusions.paths.read()),[]);assert.deepEqual(Array.from(refreshed.exclusions.keywords.read()),[]);
  const failed=await editorHarness();failed.exclusions.keywords.change(["blocked-word"]);failed.failRender();
  await failed.$("render").onclick({preventDefault(){}});
  assert.equal(failed.isDirty(),true);assert.deepEqual(Array.from(failed.exclusions.keywords.read()),["blocked-word"],"a failed render must retain form rules for retry");
  const failedDraft=JSON.parse(failed.storage.get(`sfx-draft:${failed.getRun().id}`)!);assert.deepEqual(failedDraft.edit.excludedKeywords,["blocked-word"]);
}

export async function testSfxSeparatedGroupsAndBulkMute() {
  const ui=await editorHarness(),before=ui.getRun();
  const ids=(id:string)=>ui.$(id).children.filter((n:any)=>n.dataset.eventId).map((n:any)=>n.dataset.eventId);
  assert.deepEqual(ids('music-event-list'),['music-event']);
  assert.deepEqual(ids('sfx-event-list'),['boss-event','player-event','ui-event','muted-event']);
  await ui.$('mute-sfx-group').onclick({preventDefault(){}});
  assert.ok(ui.getRun().events.filter((e:any)=>e.category!=='music').every((e:any)=>e.muted));
  assert.equal(ui.getRun().events.find((e:any)=>e.id==='music-event').muted,undefined);
  assert.deepEqual(ui.getRun().placements,before.placements,'bulk mute must preserve disabled layers and source edits');
  assert.equal(ui.calls.length,0,'bulk mute waits for explicit preview update');
  const refreshed=await editorHarness(ui.storage);await refreshed.exec('poll(run.id,true)');
  await refreshed.$('render').onclick({preventDefault(){}});
  const submitted=refreshed.calls.find(c=>c.url.endsWith('/edit-preview'))!;
  assert.ok(submitted.body.events.filter((e:any)=>e.category!=='music').every((e:any)=>e.muted));
  const {EventSchema}=await import('../src/sfx/models.js');
  refreshed.context.persisted=JSON.parse(JSON.stringify(refreshed.getRun().events.map((e:any)=>EventSchema.parse(e))));
  refreshed.exec('run.events=persisted; renderEvents()');
  await refreshed.$('mute-sfx-group').onclick({preventDefault(){}});
  assert.equal(refreshed.getRun().events.find((e:any)=>e.id==='boss-event').muted,false);
  assert.equal(refreshed.getRun().events.find((e:any)=>e.id==='muted-event').muted,true,'restore group keeps previously muted events muted');
  assert.equal(refreshed.getRun().placements.find((p:any)=>p.id==='p-off').enabled,false);
  await refreshed.$('mute-music-group').onclick({preventDefault(){}});
  assert.equal(refreshed.getRun().events.find((e:any)=>e.id==='music-event').muted,true);
  assert.equal(refreshed.getRun().events.find((e:any)=>e.id==='boss-event').muted,false);
  refreshed.$('event-filter').value='music';refreshed.$('event-filter').onchange();
  assert.equal(refreshed.$('sfx-event-group').hidden,true);
  assert.equal(refreshed.$('music-event-group').hidden,false);
}

export async function testSfxEditsWaitForExplicitPreviewUpdate() {
  const ui = await editorHarness();
  const originalVideo = ui.$("video").src;
  await ui.exec('quickEdit("event", "boss-event", "mute")');
  assert.equal(ui.getRun().events[0].muted, true);
  await ui.exec('quickEdit("event", "boss-event", "unmute")');
  assert.equal(ui.getRun().events[0].muted, false);
  await ui.exec('quickEdit("placement", "p-boss", "mute")');
  assert.equal(ui.getRun().placements[0].enabled, false);
  await ui.exec('quickEdit("placement", "p-boss", "unmute")');
  ui.$("gain").value = "-16";
  ui.$("gain").oninput();
  const replacement = { ...ui.getRun().assets[0], id: "replacement", fileName: "replacement_roar.wav" };
  ui.context.replacement = replacement;
  await ui.exec('run.assets.push(replacement); chooseAsset(replacement, "main")');
  assert.equal(ui.getRun().placements[0].assetId, "replacement");
  ui.$("event-start").value = "1.4"; ui.$("event-end").value = "2.5";
  await ui.exec("applyManualTiming()");
  await ui.exec('quickEdit("placement", "p-ui", "delete")');
  await ui.exec('quickEdit("event", "player-event", "delete")');
  assert.equal(ui.getRun().events.some((e: any) => e.id === "player-event"), false);
  assert.equal(ui.getRun().placements.some((p: any) => p.eventId === "player-event" || p.id === "p-ui"), false);
  assert.equal(ui.getRun().placements[0].gainDb, -16);
  assert.equal(ui.getRun().id, "11111111-1111-4111-8111-111111111111");
  assert.equal(ui.isDirty(), true);
  assert.equal(ui.calls.length, 0, "manual edits must not call the render or save APIs");
  assert.equal(ui.$("video").src, originalVideo);
  assert.match(ui.$("preview-state").textContent, /更新视频预览/);

  const expected = ui.getRun();
  await ui.$("render").onclick({ preventDefault() {} });
  const submissions = ui.calls.filter(call => call.url.endsWith("/edit-preview"));
  assert.equal(submissions.length, 1, "one explicit update submits all staged changes once");
  assert.deepEqual(submissions[0].body.events, expected.events);
  assert.deepEqual(submissions[0].body.placements, expected.placements);
  assert.equal(ui.isDirty(), false);
  assert.equal(ui.getRun().render.revision, ui.getRun().revision);
  assert.ok(!ui.$("video").src.includes("accepted-preview"));
  assert.equal([...ui.storage.keys()].some(key => key.startsWith("sfx-draft:")), false);
}

export async function testSfxDraftRecoveryAndPreviewFailures() {
  const storage = new Map<string, string>();
  const ui = await editorHarness(storage);
  await ui.exec('quickEdit("placement", "p-boss", "mute")');
  const refreshed = await editorHarness(storage);
  await refreshed.exec('poll(run.id, true)');
  assert.equal(refreshed.getRun().placements[0].enabled, false, "refresh must recover the staged mute");
  assert.equal(refreshed.isDirty(), true);
  assert.equal(refreshed.$("discard-edits").disabled, false, "restored drafts must remain discardable after loading completes");
  assert.equal(refreshed.getRun().render.video, "accepted-preview.mp4", "a draft cannot claim to have a newly rendered preview");

  for (const failure of ["failUpdate", "failRender"] as const) {
    const retry = await editorHarness(new Map(storage));
    await retry.exec('poll(run.id, true)');
    retry[failure]();
    await retry.$("render").onclick({ preventDefault() {} });
    assert.equal(retry.isDirty(), true, "failed updates retain editable changes for retry");
    assert.equal(retry.getRun().placements[0].enabled, false);
    assert.equal(retry.getRun().id, ui.getRun().id);
    assert.equal(retry.getRun().render.video, "accepted-preview.mp4");
    assert.ok([...retry.storage.keys()].some(key => key.startsWith("sfx-draft:")));
  }
  const stale = await editorHarness(new Map(storage));
  const newer = fixtureRun(path.resolve("fixture-library")); newer.revision += 1;
  stale.setNextRun(newer);
  await stale.exec('poll(run.id, true)');
  assert.equal(stale.isDirty(), false, "a draft for an old revision must not overwrite a newer saved timeline");
  assert.equal(stale.getRun().placements[0].enabled, true);
}

export async function testReaperUiAcceptsNamesAndNeverRendersEdits() {
  const ui = await editorHarness();
  ui.$("reaper-output-path").value = "Boss 技能";
  await ui.$("reaper-export-form").onsubmit({ preventDefault() {} });
  assert.equal(ui.calls.find(call => call.url.endsWith("/export/reaper"))?.body.outputPath, "Boss 技能.rpp");
  const pending = await editorHarness();
  await pending.exec('quickEdit("event", "boss-event", "mute")');
  await pending.$("reaper-export-form").onsubmit({ preventDefault() {} });
  assert.equal(pending.calls.length, 0, "exporting must require pending edits to be applied with the preview button first");
  assert.equal(pending.isDirty(), true);
  assert.match(pending.$("reaper-export-progress").textContent, /更新视频预览/);
}

export async function testSfxDraftCanBeDiscardedWithoutRendering() {
  const ui = await editorHarness();
  await ui.exec('quickEdit("event", "boss-event", "delete")');
  ui.$("gain").value = "-19";
  ui.$("gain").oninput();
  assert.equal(ui.isDirty(), true);
  assert.equal(typeof ui.$("discard-edits").onclick, "function");
  await ui.$("discard-edits").onclick({ preventDefault() {} });
  assert.equal(ui.isDirty(), true, "the first click requests confirmation without discarding");
  await ui.exec('selectedEvent().description = "edited after discard confirmation"; markDirty()');
  assert.equal(ui.$("discard-edits").textContent, "撤销暂存修改", "new edits cancel an earlier discard confirmation");
  await ui.$("discard-edits").onclick({ preventDefault() {} });
  assert.equal(ui.isDirty(), true, "new changes require a fresh discard confirmation");
  await ui.$("discard-edits").onclick({ preventDefault() {} });
  assert.equal(ui.isDirty(), false);
  assert.equal(ui.getRun().events.length, 5);
  assert.equal(ui.getRun().placements.length, 6);
  assert.equal(ui.getRun().render.video, "accepted-preview.mp4");
  assert.equal(ui.calls.some(call => call.body && /\/(edit-preview|quick-edit|render)$/.test(call.url)), false);
  assert.equal([...ui.storage.keys()].some(key => key.startsWith("sfx-draft:")), false);
}

export async function testCreativeBriefIsAuxiliaryAndSupportsExplicitReanalysis() {
  const html = await fs.readFile(path.resolve("src/ui/public/sfx.html"), "utf8");
  const source = await fs.readFile(path.resolve("src/ui/public/sfx.js"), "utf8");
  assert.match(html, /视频内容辅助说明（可选填）/);
  assert.match(html, /声音要求（可选填）/);
  assert.match(html, /视频内容辅助说明（可选填）/);
  assert.match(html, /留空时，完全根据视频画面自动分析/);
  assert.match(html, /背景音乐素材库（独立目录，可选）/);
  assert.doesNotMatch(html, /留空则从上方素材库中查找背景音乐/);
  assert.match(html, /id="add-library-preference"[^>]*>添加</);
  assert.match(html, /id="add-keyword-preference"[^>]*>添加</);
  for (const id of ["add-library-preference", "add-library-exclusion", "add-keyword-preference", "add-keyword-exclusion"]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*class="[^"]*\\badd-button\\b`), `${id} must use the shared add-button style`);
  }
  for (const id of ["add-event", "add-music", "add-described-event", "add-manual-event"]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*class="[^"]*\\badd-action-button\\b`), `${id} must use the shared add-action-button style`);
  }
  assert.match(html, /风格词、感受词或具体作品名称/);
  assert.match(html, /先分析声音风格，再匹配声音/);
  assert.match(html, /Gemini重新分析生成/);
  assert.match(html, /根据新说明重新分析/);
  assert.match(source, /\/api\/sfx\/runs\/\$\{run\.id\}\/reanalyze/);
  assert.match(source, /reanalyzeProject\("visual"\)/);
  assert.match(source, /reanalyzeProject\("brief"\)/);
  assert.doesNotMatch(source, /video-description[^\n]*onkeydown[^\n]*analyze/);
}
