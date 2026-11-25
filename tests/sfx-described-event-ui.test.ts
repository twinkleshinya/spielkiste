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
  assert.match(js, /正在提交补声分析/);
  assert.doesNotMatch(js, /任务超过 30 分钟/);
}
import { editorHarness } from "./sfx-edit-preview-ui.test.js";

export async function testDescribedEventButtonFeedbackAndRecovery() {
  const ui = await editorHarness();
  const click = () => ui.$("add-described-event").onclick({preventDefault(){}});
  await click();
  assert.match(ui.$("described-event-status").textContent, /请先描述/);
  assert.equal(ui.$("described-event-status").hidden, false);
  ui.$("described-event-description").value = "猩猩啃咬角色";
  await ui.exec('quickEdit("event", "boss-event", "mute")');
  await click();
  assert.match(ui.$("described-event-status").textContent, /更新视频预览/);
  assert.equal(ui.calls.some(c=>c.url.endsWith('/add-described-event')), false);
  ui.exec('dirty=false');
  let rejectRequest!: (error: Error) => void;
  ui.context.fetch = () => new Promise((_resolve, reject) => {rejectRequest = reject;});
  const pending = click();
  assert.equal(ui.$("add-described-event").disabled, true);
  assert.match(ui.$("described-event-status").textContent, /正在提交/);
  rejectRequest(new Error("模型网关连接中断"));
  await pending;
  assert.match(ui.$("described-event-status").textContent, /模型网关连接中断/);
  assert.equal(ui.$("described-event-description").value, "猩猩啃咬角色");
  assert.equal(ui.$("add-described-event").disabled, false);

  // Retry the real handler, then observe progress locally and the new preview.
  const child = ui.getRun(); child.id = "new-described-run"; child.revision++;
  child.render.revision = child.revision;
  child.events.push({...child.events[0], id:"new-bite", muted:false, description:"猩猩啃咬角色", start:1.25,end:1.75});
  child.placements.push({...child.placements[0],id:"new-bite-clip",eventId:"new-bite",enabled:true,category:"impact"});
  const requests: any[] = [];
  let resolveStatus!: (value: any) => void;
  let signalStarted!: () => void;
  const started = new Promise<void>(resolve=>{signalStarted=resolve;});
  ui.context.CSS = {escape:(value:string)=>value};
  ui.context.fetch = async (url:string,options?:any) => {
    requests.push({url, body:options?.body && JSON.parse(options.body)});
    const response=(data:any)=>({ok:true,json:async()=>data});
    if(url.endsWith('/add-described-event'))return response({runId:child.id});
    if(url.endsWith('/status')) {signalStarted();return new Promise(resolve=>{resolveStatus=resolve;});}
    if(url.endsWith('/runs/'+child.id))return response(child);
    return response({});
  };
  let virtualNow = Date.now();
  ui.context.Date = class extends Date { static now(){return virtualNow;} };
  ui.context.setTimeout = (callback:()=>void) => {virtualNow += 65*60*1000; callback(); return 1;};
  const retry=click(); await started;
  assert.match(ui.$("described-event-status").textContent,/定位动作/);
  resolveStatus({ok:true,json:async()=>({status:'analyzing',progress:'Gemini 正在精定位'})});
  // The next status arrives after 65 virtual minutes; the browser must keep polling.
  ui.context.fetch = async (url:string) => ({ok:true,json:async()=>url.endsWith('/status')?{status:'ready',progress:'已补充啃咬音效'}:url.endsWith('/runs/'+child.id)?child:{}});
  await retry;
  assert.equal(ui.getRun().id, child.id);
  assert.match(ui.$("described-event-status").textContent, /找到 1 个动作点位/);
  assert.equal(ui.$("described-event-description").value, "", ui.$("described-event-status").textContent);
  assert.equal(requests[0].body.description,"猩猩啃咬角色");

  // Legacy servers may report ready with empty new events: never claim success.
  ui.$("described-event-description").value="加风声";
  const empty=ui.getRun(); empty.id="empty-supplement"; empty.revision++;empty.render.revision=empty.revision;
  empty.events.push({...empty.events[0],id:"empty-wind",description:"风声"});
  ui.context.fetch=async(url:string)=>({ok:true,json:async()=>url.endsWith('/add-described-event')?{runId:empty.id}:url.endsWith('/status')?{status:'ready'}:url.endsWith('/runs/'+empty.id)?empty:[]});
  await click();
  assert.match(ui.$("described-event-status").textContent,/未添加可播放音效/);
  assert.equal(ui.$("described-event-status").dataset.state,"error");
  assert.equal(ui.$("described-event-description").value,"加风声");
}
