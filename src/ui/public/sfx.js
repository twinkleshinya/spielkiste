import { planSourceEdit, edgeFades } from "/sfx-clip-edit.js";
import {chooseLocalFolder,searchFolderPaths} from "/sfx-folders.js?v=20261124-native-picker";
import {createKeywordPreferences,createLibraryPreferences,createLibraryExclusions,createKeywordExclusions} from "/sfx-library-preferences.js";
import {assetExclusionReasonResolver} from "/sfx-asset-exclusions.js";
const $ = id => document.getElementById(id);
let run = null, project = null, selectedId = null, selectedLayerId = "default", dirty = false, busy = false, showingPreview = false, reaperExporting = false;
let aiConfig = null;
let taskRunId=null,taskState=null,taskPolling=false,taskControlPending=false;
function renderTaskControls(id,state){
  taskRunId=id;taskState=state;
  const active=['analyzing','rendering','paused'].includes(state?.status),failed=state?.status==='failed';
  $('task-controls').hidden=!active&&!failed;
  $('task-control-title').textContent=failed?'任务未完成':state?.status==='paused'?'任务已停止':state?.taskControl?.state==='pausing'?'正在停止':'任务进行中';
  $('task-control-note').textContent=state?.taskControl?.state==='pausing'?'已收到停止请求，将在当前请求或处理步骤结束后暂停；已完成结果会保留。':failed?`${state.error||state.progress||'处理失败'}；点击继续会重试未完成操作，原版本保持不变。`:state?.status==='paused'?state.progress||'进度已保留，点击继续接着处理。':state?.progress||'';
  $('resume-task').hidden=!(failed||state?.status==='paused'||state?.taskControl?.state==='pausing');
  $('pause-task').hidden=!active||state?.status==='paused'||state?.taskControl?.state==='pausing';
  $('terminate-task').hidden=!active;
  for(const name of ['pause-task','resume-task','terminate-task'])$(name).disabled=taskControlPending;
}
async function controlCurrentTask(action){
  if(!taskRunId||taskControlPending)return;
  if(action==='terminate'&&!window.confirm('终止本次任务？已保存的原版本不会改变；终止后需要重新发起。'))return;
  const id=taskRunId;taskControlPending=true;renderTaskControls(id,taskState);
  try{
    const result=await api(`/api/sfx/runs/${id}/control`,{action});
    if(result.status)renderTaskControls(result.runId||id,result);
    if(action==='resume'&&!taskPolling){taskControlPending=false;await poll(result.runId||id,true,{time:$('video').currentTime||0,playing:false});}
    else if(action==='terminate'&&!taskPolling)renderTaskControls(id,{status:'cancelled'});
  }finally{taskControlPending=false;if(taskState)renderTaskControls(taskRunId,taskState);}
}
const labels = { foley: "拟音", impact: "冲击", whoosh: "运动", ambience: "环境", music: "音乐", other: "其他 / UI" };
const musicStages = { enter: "进入", build: "增强", climax: "高潮", release: "收束", exit: "退出" };
const text = (tag, value, className) => { const el = document.createElement(tag); el.textContent = value; if (className) el.className = className; return el; };
const num = id => Number($(id).value);
const time = value => { const n = Math.max(0, Number(value) || 0); return `${String(Math.floor(n / 60)).padStart(2, "0")}:${(n % 60).toFixed(3).padStart(6, "0")}`; };
const api = async (url, body) => {
  const response = await fetch(url, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json(); if (!response.ok) throw Object.assign(new Error(data.error || `请求失败：${response.status}`),{code:data.code,conflicts:data.conflicts,suggestions:data.suggestions}); return data;
};
let conflictSelection = '', conflictIdentity = '', appliedConflictRequirements = '';
function hideStyleConflict(){ $('style-conflict-panel').hidden=true;conflictSelection='';conflictIdentity=''; }
function handleRequestError(error){
  status(error.message,true);
  if(error.code==='STYLE_CONFLICT'){
    const identity=JSON.stringify([selectedStyle(),selectedReferenceWorks()]);
    if($('style-conflict-panel').hidden||identity!==conflictIdentity)$('style-conflict-custom').value='';
    conflictIdentity=identity;conflictSelection='';
    $('style-conflict-panel').hidden=false;$('style-conflict').textContent=error.message;
    const container=$('style-conflict-options');container.replaceChildren();const radios=[];
    for(const option of (Array.isArray(error.suggestions)?error.suggestions:[]).filter(o=>typeof o?.title==='string'&&typeof o?.requirements==='string'&&o.requirements.trim()).slice(0,3)){
      const label=text('label','','style-blend-option'),radio=document.createElement('input'),description=document.createElement('span');
      radio.type='radio';radio.name='style-blend';radio.checked=false;radios.push(radio);
      radio.onchange=()=>{for(const other of radios)other.checked=other===radio;conflictSelection=option.requirements;};
      description.append(text('strong',option.title),text('small',option.requirements));label.append(radio,description);container.append(label);
    }
    $('style-conflict-panel').scrollIntoView({block:'center',behavior:'smooth'});
  }
}
function status(message, error = false) { $("status").textContent = message; $("status").classList.toggle("error", error); }
function persistDraft() {
  if (!run || !dirty) return true;
  try {
    localStorage.setItem(`sfx-draft:${run.id}`, JSON.stringify({ version:1, runId:run.id, baseRevision:run.revision, videoPath:run.videoPath, libraryPath:run.libraryPath, edit:editPayload(), assets:run.assets, selectedId, selectedLayerId }));
    return true;
  } catch { return false; }
}
function clearDraft(id) { try { localStorage.removeItem(`sfx-draft:${id}`); } catch { /* keep saved server versions available */ } }
function restoreDraft() {
  try {
    const saved = JSON.parse(localStorage.getItem(`sfx-draft:${run.id}`) || "null");
    if (!saved || saved.version !== 1 || saved.runId !== run.id || saved.baseRevision !== run.revision || saved.videoPath !== run.videoPath || saved.libraryPath !== run.libraryPath) return false;
    if (!Array.isArray(saved.edit?.events) || !Array.isArray(saved.edit?.placements) || !Array.isArray(saved.assets) || saved.edit.revision !== run.revision) return false;
    const assets = new Map(run.assets.map(asset => [asset.id, asset]));
    for (const asset of saved.assets) if (!assets.has(asset.id)) assets.set(asset.id, asset);
    Object.assign(run, saved.edit, { assets:[...assets.values()] });
    keywordPreferences.load((run.keywordPreferences || []).filter(p=>p.purpose!=="reference"));
    loadExclusions(run);
    selectedId = saved.selectedId; selectedLayerId = saved.selectedLayerId || "default";
    dirty = true;
    return true;
  } catch { return false; }
}
function resetDiscardConfirmation() { delete $("discard-edits").dataset.confirm; $("discard-edits").textContent = "撤销暂存修改"; }
function markDirty() { dirty = true; resetDiscardConfirmation(); $("save-state").textContent = persistDraft() ? "修改已暂存在本机 · 预览未更新" : "修改暂存在当前页面 · 预览未更新"; updatePreviewStatus(); }
function keepDraftBeforeLeaving() {
  if (dirty && !persistDraft()) throw new Error("当前修改无法暂存在本机，请先点击“更新视频预览”后再切换项目。");
}
function requireUpdatedPreview() {
  if (dirty || run?.render && run.render.revision !== run.revision) throw new Error("有待更新的修改，请先点击“更新视频预览”，完成后再操作。");
}
function setBusy(value) { busy = value; for (const id of ["refresh-library-index","style-conflict-custom","apply-style-conflict","video-description","sound-requirements","sound-style","custom-style","reference-works","audio-output-mode","research-style","refresh-style","search-library-path","search-music-path","discard-edits", "analyze", "reanalyze-visual", "reanalyze-brief", "reanalyze-video-description", "reanalyze-sound-requirements", "reanalyze-sound-style", "reanalyze-reference-works", "render", "preserve", "history", "refresh-history", "switch-project", "open-new-project", "add-event", "add-music", "add-described-event", "add-manual-event", "search", "pick-video", "browse-library", "browse-music", "new-project", "name", "video-path", "library-path", "music-library-path", "described-event-description", "ai-reidentify", "apply-timing", "rename-project", "save-as-project", "sync-project", "version-history", "open-version", "restore-version", "export-reaper", "ai-config-open", "video-seek"]) { const el = $(id); if (el) el.disabled = value; } $("style-conflict-options").inert=value;libraryPreferences.setBusy(value);keywordPreferences.setBusy(value);libraryExclusions.setBusy(value);keywordExclusions.setBusy(value); $("event-editor").inert = value; $("event-list").inert=value; $("timeline").inert=value; $("parent-version").inert=value; for(const kind of ["sfx","music"])$("mute-"+kind+"-group").disabled=value||!run?.events.some(e=>(e.category==="music")===(kind==="music")); }
function renderAiConfig(snapshot) {
  aiConfig = snapshot;
  const button = $("ai-config-open"), dot = $("ai-config-dot"), label = $("ai-config-status");
  if (!button || !label) return;
  button.dataset.state = snapshot?.ready ? "ready" : "error";
  label.textContent = snapshot?.ready ? `已连接 · ${snapshot.model} · ${snapshot.reasoningEffort === "xhigh" ? "Extreme High" : "High"}` : snapshot?.source === "disabled" ? "已关闭" : snapshot?.configured ? "待测试" : "需要配置";
  dot.title = snapshot?.error || snapshot?.baseUrl || "";
}
async function loadAiConfig() {
  try { renderAiConfig(await api("/api/sfx/ai-config")); }
  catch (error) { renderAiConfig({ ready:false, source:"missing", model:"gemini-4-argon", error:error.message }); }
}
function aiConfigInput() {
  return { mode:"ccswitch", reasoningEffort:$("ai-config-reasoning").value || "high", configPath:$("ai-config-path").value.trim() || undefined, model:$("ai-config-model").value.trim() || undefined, baseUrl:$("ai-config-base-url").value.trim() || undefined, bearer:$("ai-config-bearer").value || undefined, wireApi:$("ai-config-wire-api").value };
}
function fillAiConfig(snapshot) {
  if (!snapshot) return;
  $("ai-config-reasoning").value = snapshot.reasoningEffort || "high";
  $("ai-config-path").value = snapshot.configPath || "";
  $("ai-config-model").value = snapshot.model || "gemini-4-argon";
  $("ai-config-model-select").value = ["gemini-4-argon", "gemini-4-hydrogen"].includes($("ai-config-model").value) ? $("ai-config-model").value : "custom";
  $("ai-config-custom-model").hidden = $("ai-config-model-select").value !== "custom";
  // An auto-discovered CC Switch file already contains its own bearer. Keep
  // the manual fields blank so saving the dialog stores the file path instead
  // of silently replacing the discovered credential with an unauthenticated
  // copy of the gateway URL.
  $("ai-config-base-url").value = snapshot.configPath ? "" : (snapshot.baseUrl || "");
  $("ai-config-wire-api").value = snapshot.wireApi || "responses";
  $("ai-config-bearer").value = "";
  $("ai-config-manual").open = !snapshot.configPath || !snapshot.configured;
}
async function testAiConfigFromDialog(save = false) {
  const message = $("ai-config-message"); message.className = "ai-config-message"; message.textContent = "正在测试 Gemini 图片与音频输入，最多约 90 秒…";
  const controls = ["test-ai-config", "save-ai-config", "ai-config-close", "ai-config-path", "ai-config-model-select", "ai-config-reasoning", "ai-config-model", "ai-config-base-url", "ai-config-bearer", "ai-config-wire-api"];
  controls.forEach(id => { $(id).disabled = true; });
  try {
    const input = aiConfigInput();
    if (save) { const saved = await api("/api/sfx/ai-config", input); renderAiConfig(saved); fillAiConfig(saved); }
    const result = await api("/api/sfx/ai-config/test", save ? aiConfigInput() : input);
    if (!result.ok) throw new Error(result.error || "连接测试失败");
    message.textContent = `${save ? "已保存到本机，" : "当前填写内容"}图片与音频测试通过 · ${result.model || "Gemini"} · ${(result.elapsedMs / 1000).toFixed(1)} 秒${save ? "" : "；请点“保存并测试”后用于生成"}`;
    status(save ? "AI 配置已保存，图片与音频输入均可用。" : "测试通过，请保存配置后开始生成。");
  } catch (error) { message.className = "ai-config-message error"; message.textContent = `${save ? "保存或测试" : "连接测试"}失败：${error.message}`; }
  finally { $("ai-config-bearer").value = ""; await loadAiConfig(); controls.forEach(id => { $(id).disabled = false; }); }
}
$("ai-config-model-select").onchange = () => {
  const model = $("ai-config-model-select").value;
  $("ai-config-custom-model").hidden = model !== "custom";
  if (model !== "custom") $("ai-config-model").value = model;
  $("ai-config-message").className = "ai-config-message";
  $("ai-config-message").textContent = "点“保存并测试”后，后续新生成将使用所选模型。已有视频保持原样。";
};
$("ai-config-reasoning").onchange = () => { $("ai-config-message").textContent = "点“保存并测试”后，点位分析、音频判断及选材统一使用所选档位。"; };
$("ai-config-open").onclick = async () => { fillAiConfig(aiConfig); $("ai-config-message").textContent = aiConfig?.error || ""; $("ai-config-dialog").showModal(); await loadAiConfig(); fillAiConfig(aiConfig); };
$("ai-config-close").onclick = () => { $("ai-config-bearer").value = ""; $("ai-config-dialog").close(); };
$("ai-config-dialog").onclose = () => { $("ai-config-bearer").value = ""; };
$("ai-config-dialog").oncancel = event => { if ($("test-ai-config").disabled) event.preventDefault(); };
$("test-ai-config").onclick = event => { event?.preventDefault(); void testAiConfigFromDialog(); };
$("ai-config-form").onsubmit = async event => { event.preventDefault(); await testAiConfigFromDialog(true); };
async function renderWorkflowReport() {
  const id=run.id;
  try {
    const report=await api(`/api/sfx/runs/${id}/export/workflow`);if(run?.id!==id)return;
    const names={complete:"完成",reused:"复用",partial:"部分完成",fallback:"规则回退",skipped:"无需执行",missing:"缺少依据",pending:"待生成"};
    $("workflow-run-title").textContent=`${report.profile?.name||"历史版本流程复盘"} · ${report.runStatus==="failed"?"生成失败":{"checks-passed":"自动检查通过，待试听","needs-review":"有项目待复核",failed:"发现需要修正的问题"}[report.quality.status]}`;
    $("workflow-run-note").textContent=report.legacy?"依据历史版本现存报告只读复盘；不代表已重新执行标准流程。":`配置 v${report.profile.version} · ${report.effective.timingModel||"点位模型未完成"}${report.effective.reasoningEffort ? ` / ${report.effective.reasoningEffort === "xhigh" ? "Extreme High" : "High"}` : ""} · ${report.effective.addedReverb?"额外混响开启":"无额外混响"} · ${report.effective.originalMuted?"原视频数字静音":`原视频 ${report.effective.originalGainDb} dB`}`;
    if(report.runStatus==="failed")$("workflow-run-note").textContent=`生成失败：${report.error||report.progress||"任务未完成"}`;
    const stages=$("workflow-run-stages");stages.replaceChildren();
    for(const s of report.stages){const li=text("li",`${s.name}：${names[s.status]||s.status}`);li.dataset.state=s.status;li.title=s.detail;stages.append(li);}
    const checks=$("workflow-checks");checks.replaceChildren();
    for(const c of report.quality.checks){const li=text("li",`${{pass:"✓",review:"待复核",fail:"需修正"}[c.status]} · ${c.detail}`);li.dataset.state=c.status;checks.append(li);}
    $("workflow-effective").textContent=JSON.stringify({effective:report.effective,options:report.profile?.options,models:report.usage?.models},null,2);
  }catch(e){if(run?.id===id)$("workflow-run-note").textContent=`报告暂不可用：${e.message}`;}
}
function selectedEvent() { return run?.events.find(e => e.id === selectedId); }
function selectedPlacement() { return run?.placements.find(p => p.eventId === selectedId && (p.layerId || "default") === selectedLayerId); }
function mediaUrl(kind, suffix = "") { return `/api/sfx/runs/${run.id}/media/${kind}${suffix}`; }
function updatePreviewStatus() {
  if (!dirty) resetDiscardConfirmation();
  const stale = dirty || run?.render && run.render.revision !== run.revision;
  if (dirty) $("preview-state").textContent = "有修改 · 点击更新视频预览";
  else if (!run?.render) $("preview-state").textContent = "尚未生成音效预览";
  else if (run.status === "failed" && run.error?.includes("新预览未生成")) $("preview-state").textContent = "新预览未生成 · 当前播放上一版预览";
  else $("preview-state").textContent = stale ? "有修改 · 点击更新视频预览" : "预览与已保存贴片一致";
  $("discard-edits").hidden = !dirty;
  $("discard-edits").disabled = busy;
  $("show-preview").disabled = !run?.render;
}
function showVideo(preview = false, playback) {
  if (!run || preview && !run.render) return;
  const current = playback?.time ?? ($("video").currentTime || 0);
  const playing=playback?.playing ?? !$("video").paused; showingPreview = preview;
  $("video").src = mediaUrl(preview ? "preview" : "video", preview ? `?v=${Date.now()}` : "");
  $("video").addEventListener("loadedmetadata", () => { const duration=$("video").duration || run.duration || 0; $("video-seek").max=String(duration); $("video-seek").value=String(Math.min(current, Math.max(0,duration-.001))); $("video").currentTime = Math.min(current, Math.max(0,duration-.001)); if(playing)$("video").play().catch(()=>{}); }, { once: true });
  $("show-source").classList.toggle("selected", !preview); $("show-preview").classList.toggle("selected", preview);
}
function renderEvents() {
  const timeline = $("timeline"); timeline.replaceChildren();
  $("sfx-event-list").replaceChildren(); $("music-event-list").replaceChildren();
  $("event-count").textContent = `${run.events.length} 个点位 / ${run.placements.filter(p => p.enabled&&!run.events.find(e=>e.id===p.eventId)?.muted).length} 个启用贴片`;
  const filter = $("event-filter").value;
  for (const kind of ["sfx", "music"]) {
    const group=run.events.filter(e=>(e.category==="music")===(kind==="music"));
    const visible=group.filter(e=>filter==="all"||filter==="action"&&!["music","ambience"].includes(e.category)||e.category===filter);
    $(kind+"-event-group").hidden=filter!=="all"&&!visible.length;
    $(kind+"-group-count").textContent=`${group.length} 个点位 · ${group.filter(e=>!e.muted).length} 个未静音`;
    const button=$("mute-"+kind+"-group"),restoring=group.some(e=>typeof e.groupMuteWasMuted==="boolean");
    button.textContent=`${restoring?"恢复":"静音"}全部${kind==="music"?"音乐":"音效"}`;
    button.disabled=busy||!group.length;button.setAttribute("aria-pressed",String(restoring));
    if(!visible.length) $(kind+"-event-list").append(text("p",kind==="music"?"暂无音乐点位":"暂无音效点位","empty-state"));
  }
  run.events.filter(e => filter === "all" || filter === "action" && !["music", "ambience"].includes(e.category) || e.category === filter).forEach((event, i) => {
    const list=$(event.category==="music"?"music-event-list":"sfx-event-list");
    const p = run.placements.find(item => item.eventId === event.id); const chosen = run.assets.find(a => a.id === p?.assetId);
    const row=text("div","",`event-item${event.muted?" muted":""}`);row.dataset.eventId=event.id;
    const button = text("button", "", `event-row${selectedId === event.id ? " active" : ""}`); button.type = "button";
    button.append(text("span", String(i + 1).padStart(2, "0"), "number"));
    const content = document.createElement("div"); content.append(text("strong", event.description || "未命名事件"));
    content.append(text("small", `${time(event.start)} → ${time(event.end)} · ${labels[event.category]} · ${(event.layers || []).length} 层 · ${event.requiresHumanReview ? "待复核" : "已复核"}`));
    if (event.category === "music") content.append(text("small", `${musicStages[event.musicStage] || "配乐"} · 强度 ${(event.intensity ?? .5).toFixed(2)}${!p ? " · 待选音乐" : ""}`, "music-label"));
    if (chosen) content.append(text("small", `${event.muted?"已静音 · ":""}${p.enabled&&!event.muted ? "●" : "○"} ${chosen.fileName}`));
    button.append(content); button.onclick = () => selectEvent(event.id, true);row.append(button);
    const controls=text("div","","event-actions");
    for(const [action,label] of [[event.muted?"unmute":"mute",event.muted?"恢复":"静音"],["delete","删除"]]) {
      const control=text("button",label,action==="delete"?"danger-text":"secondary");control.type="button";control.dataset.action=action;control.title=`${label}整个点位及其音效`;
      control.onclick=guard(()=>quickEdit("event",event.id,action));controls.append(control);
    }
    row.append(controls);list.append(row);
    const bar = text("button", "", `${selectedId === event.id ? "active " : ""}${event.category === "music" ? "music-bar" : ""}`); bar.type = "button"; bar.title = event.description;
    bar.classList.toggle("muted",event.muted===true);bar.style.left = `${event.start / run.duration * 100}%`; bar.style.width = `${Math.max(.4, (event.end - event.start) / run.duration * 100)}%`;
    bar.onclick = () => selectEvent(event.id, true); timeline.append(bar);
  });
  const musicEvents = run.events.filter(e => e.category === "music");
  $("music-summary").textContent = `${musicEvents.length} 个音乐区间 · ${run.placements.filter(p => p.category === "music" && p.enabled&&!run.events.find(e=>e.id===p.eventId)?.muted).length} 个启用音乐贴片 · 音乐也可逐点静音或删除`;
}
function toggleSoundGroup(kind) {
  if(!run||busy)return;
  const group=run.events.filter(e=>(e.category==="music")===(kind==="music"));
  if(!group.length)return;
  const restoring=group.some(e=>typeof e.groupMuteWasMuted==="boolean");
  for(const event of group){
    if(restoring){if(typeof event.groupMuteWasMuted==="boolean"){event.muted=event.groupMuteWasMuted;delete event.groupMuteWasMuted;}}
    else{event.groupMuteWasMuted=event.muted===true;event.muted=true;}
  }
  markDirty();renderEvents();if(selectedEvent())selectEvent(selectedId);
  status(`${kind==="music"?"音乐":"音效"}整体${restoring?"恢复":"静音"}已暂存，点击“更新视频预览”后试听。`);
}
function renderCandidates() {
  const box = $("candidates"); box.replaceChildren(); const event = selectedEvent(); if (!event) return;
  $("candidate-method").textContent = (event.layers || []).some(l => l.candidates.some(c => c.reason.startsWith("Gemini 音频片段"))) ? "Gemini 音频＋画面判断" : "名称参考 / 相似备选合并";
  const layers = event.layers?.length ? event.layers : [{ id: "default", role: event.category, query: event.query, offset: 0, candidates: event.candidates }];
  layers.forEach(layer => {
    const section = text("div", "", "layer-card"); section.append(text("strong", `${layer.role} 层 · ${layer.query || "待填写检索词"}`));
    const editLayer = text("button", "编辑此层", "text-button"); editLayer.type = "button"; editLayer.onclick = () => { selectedLayerId = layer.id; $("query").value = layer.query || event.query; renderPlacement(); }; section.append(editLayer);
    const placement = run.placements.find(p => p.eventId === event.id && (p.layerId||"default") === layer.id);
    if(placement) {
      section.classList.toggle("muted",!placement.enabled||event.muted===true);
      section.append(text("p",event.muted?"整个点位已静音":placement.enabled?"此音效正在使用":"此音效已静音","subtle"));
      const controls=text("div","","quick-actions");
      for(const [action,label] of [[placement.enabled?"mute":"unmute",placement.enabled?"静音音效":"恢复音效"],["delete","删除音效"]]) {
        const control=text("button",label,action==="delete"?"danger-text":"secondary");control.type="button";control.dataset.action=action;control.dataset.placementId=placement.id;
        control.onclick=guard(()=>quickEdit("placement",placement.id,action));controls.append(control);
      }
      section.append(controls);
    }
    const excluded=assetExclusionReasonResolver(exclusionSettings());
    const seen = new Set();
    let candidates = [...(layer.candidates || []),...(layer.alternatives || [])].filter(candidate=>{const asset=run.assets.find(a=>a.id===candidate.assetId);return asset&&!seen.has(asset.id)&&Boolean(seen.add(asset.id))&&(!excluded(asset)||candidate.assetId===placement?.assetId);});
    if (placement && !candidates.some(c => c.assetId === placement.assetId)) candidates.unshift({ assetId: placement.assetId, reason: "当前已选择素材", score: 0 });
    candidates.sort((a,b)=>Number(b.assetId===placement?.assetId)-Number(a.assetId===placement?.assetId));
    if (!candidates.length) section.append(text("p", "暂无符合当前筛选条件的候选，可调整排除设置或填写声音意图后搜索。", "no-results"));
    candidates.forEach(candidate => {
      const asset = run.assets.find(a => a.id === candidate.assetId); if (!asset) return;
      const card = text("div", "", `candidate${placement?.assetId === asset.id ? " chosen" : ""}`);
      card.append(text("strong", asset.fileName)); card.append(text("p", `${asset.duration?.toFixed(2) || "?"} 秒 · ${asset.channels || "?"} 声道 · ${asset.relativePath}`)); card.append(text("p", candidate.reason));
      if (asset.warning) card.append(text("p", asset.warning, "error"));
      if(excluded(asset))card.append(text("p",`${excluded(asset)}；当前已用声音保留，新选材时跳过。`,"subtle"));
      const buttons = text("div", "", "buttons"); const audition = text("button", "▷ 试听", "secondary"); audition.type = "button";
      audition.onclick = () => { $("video").pause(); $("audition").hidden = false; $("audition").src = mediaUrl("asset", `?id=${asset.id}`); $("audition").play().catch(e => status(`浏览器无法试听此格式：${e.message}`, true)); };
      const choose = text("button", placement?.assetId === asset.id ? "已选用" : "选用"); choose.type = "button"; choose.disabled = !asset.usable || Boolean(excluded(asset)) || placement?.assetId === asset.id; choose.title = excluded(asset)||"暂存素材替换，点击更新视频预览后生效"; choose.onclick = guard(async () => { selectedLayerId = layer.id; await chooseAsset(asset, layer.id); });
      buttons.append(audition, choose); card.append(buttons); section.append(card);
    });
    box.append(section);
  });
}
async function chooseAsset(asset, layerId = "default") {
  if (!run || busy) return;
  const exclusion=assetExclusionReasonResolver(exclusionSettings())(asset);
  if(exclusion)throw new Error(`不能选用该素材。${exclusion}`);
  if (!asset.usable) { status("该音频无法读取，请选其他候选。", true); return; }
  const event = selectedEvent(); if (!event) return;
  if(run.placements.some(p=>p.eventId===event.id&&(p.layerId||"default")===layerId&&p.assetId===asset.id))return;
  if (!$("event-editor").reportValidity()) throw new Error("请先修正事件或贴片参数");
  const layer = (event.layers || []).find(item => item.id === layerId) || { id: layerId, role: event.category, offset: 0, candidates: [] };
  const start = event.start + (layer.offset || 0); const sustained = ["music", "ambience"].includes(event.category);
  const previous = event.category === "music" ? [...run.placements].filter(p => p.category === "music" && p.assetId === asset.id && Math.abs(p.start + p.duration - start) < .3).sort((a, b) => b.start - a.start)[0] : undefined;
  const edit = planSourceEdit(event, layer.role, asset, run.duration, start);
  const sourceOffset = sustained ? previous && asset.duration ? (previous.sourceOffset + start - previous.start) % asset.duration : asset.onset || 0 : edit.sourceOffset;
  const duration = sustained ? Math.floor(Math.min(event.end-start,run.duration-start)*1000)/1000 : edit.duration;
  if (!Number.isFinite(duration) || duration <= 0) { status("事件时间无效，请先调整起止时间。", true); return; }
  layer.candidates = [{ assetId: asset.id, score: 1, reason: "用户选用" }, ...(layer.candidates || []).filter(c => c.assetId !== asset.id)];
  const existing = run.placements.find(p => p.eventId === event.id && (p.layerId||"default") === layerId);
  const p = { id: existing?.id || crypto.randomUUID(), eventId: event.id, layerId, role: layer.role === "other" ? "foley" : layer.role, locked: Boolean(event.locked), assetId: asset.id, start, duration, sourceOffset, gainDb: existing?.gainDb ?? (event.category === "music" ? -14 : layer.role === "ambience" ? -18 : -6), fadeIn: Math.min(sustained ? .35 : edit.fadeIn, duration / 3), fadeOut: Math.min(sustained ? .5 : edit.fadeOut, duration / 3), category: event.category, enabled: true, loop: sustained ? Boolean(asset.duration && sourceOffset + duration > asset.duration) : edit.loop, sourceEdit:{assetId:asset.id,sourceOffset,duration,basis:"manual",reason:"用户换用素材，按声音类型保留有界释放"} };
  if (existing) Object.assign(existing, p); else run.placements.push(p);
  markDirty(); renderEvents(); renderPlacement(); renderCandidates();
  $("audition").pause(); $("audition").hidden = true;
  status("素材替换已暂存，点击“更新视频预览”后应用。");
}
function renderPlacement() {
  const p = selectedPlacement(); $("placement-fields").hidden = !p; $("placement-fields").disabled = !p; $("loop-control").hidden = !p;
  const summary = $("source-edit-summary"); summary.hidden = !p;
  if (!p) return;
  for (const [id, key] of Object.entries({ "placement-start": "start", "placement-duration": "duration", "source-offset": "sourceOffset", gain: "gainDb", "fade-in": "fadeIn", "fade-out": "fadeOut" })) $(id).value = p[key];
  $("mute-placement").textContent=p.enabled?"静音这个音效":"恢复这个音效";
  $("loop-control").hidden = false; $("loop").checked = Boolean(p.loop);
  const basis = {"gemini-audio":"Gemini 音频复核","local-bounded":"本地有界剪辑","manual":"人工截取"}[p.sourceEdit?.basis] || "待复核截取";
  summary.textContent = `${basis}：使用源素材 ${p.sourceOffset.toFixed(3)}–${(p.sourceOffset+p.duration).toFixed(3)} 秒；淡入 ${(p.fadeIn*1000).toFixed(0)} ms，淡出 ${(p.fadeOut*1000).toFixed(0)} ms。${p.sourceEdit?.reason || "可调整素材截取起点与使用时长。"}`;
}
function selectEvent(id, seek = false) {
  if (selectedId !== id) selectedLayerId = run.events.find(e => e.id === id)?.layers?.[0]?.id || "default";
  selectedId = id; const event = selectedEvent(); renderEvents();
  $("empty-inspector").hidden = Boolean(event); $("event-editor").hidden = !event;
  $("audition").pause(); $("audition").hidden = true;
  if (!event) return;
  $("mute-event").textContent=event.muted?"恢复整个点位":"静音整个点位";
  $("description").value = event.description; $("query").value = event.query; $("event-start").value = event.start; $("event-end").value = event.end; $("category").value = event.category; $("confirmed").checked = !event.requiresHumanReview;
  $("event-source").textContent = event.source === "vision" ? `视觉模型 · ${Math.round(event.confidence * 100)}%` : event.source === "scene" ? "镜头复核" : "人工事件";
  $("music-event-fields").hidden = event.category !== "music"; $("music-stage").value = event.musicStage || "enter"; $("music-intensity").value = event.intensity ?? .5;
  $("event-evidence").hidden = !event.evidence; $("event-evidence").textContent = event.evidence ? `画面依据：${event.evidence}${event.timingPrecision ? ` · 采样间隔 ${event.timingPrecision.toFixed(3)} 秒` : ""}` : "";
  renderCandidates(); renderPlacement();
  void loadEventAlternatives(event).catch(error=>{if(selectedId===event.id)status(`备选补查未完成：${error.message}。可点击搜索重试。`,true);});
  if (seek) $("video").currentTime = event.start;
}
const alternativeLoads = new Map();
const alternativeSearchQueues = new Map();
async function loadEventAlternatives(event) {
  if(!run||!['ready','failed'].includes(run.status))return;
  const currentRun=run;
  const layers=event.layers?.length?event.layers:[];
  const settings={keywordPreferences:keywordPreferences.read(),...exclusionSettings()};
  for(const layer of layers) {
    const key=JSON.stringify([run.id,event.id,layer.id,layer.query,settings]);
    if((layer.alternatives||layer.candidates||[]).length>=5||alternativeLoads.has(key))continue;
    const loading=(async()=>{
      const previous=alternativeSearchQueues.get(currentRun.id)||Promise.resolve();
      const request=previous.catch(()=>{}).then(()=>api(`/api/sfx/runs/${currentRun.id}/search`,{query:layer.query||event.query,category:event.category,eventId:event.id,...settings}));
      alternativeSearchQueues.set(currentRun.id,request);
      let results;
      try{results=await request;}finally{if(alternativeSearchQueues.get(currentRun.id)===request)alternativeSearchQueues.delete(currentRun.id);}
      if(run!==currentRun||!run.events.includes(event))return;
      const alternatives=[];const seen=new Set();
      for(const result of [...layer.alternatives||[],...layer.candidates||[],...results]){
        if(result.asset){const old=run.assets.find(a=>a.id===result.assetId);if(old)Object.assign(old,result.asset);else run.assets.push(result.asset);}
        if(!seen.has(result.assetId)){seen.add(result.assetId);alternatives.push({assetId:result.assetId,score:result.score,reason:`待试听备选（非自动选用）：${result.reason}`});}
      }
      layer.alternatives=alternatives.slice(0,5);
      if(selectedId===event.id)renderCandidates();
    })();
    alternativeLoads.set(key,loading);
    try{await loading;}catch(error){alternativeLoads.delete(key);throw error;}
  }
}
function renderWorkspace(keepVideo = false) {
  const projectUrl = new URL(location.href); projectUrl.searchParams.delete("new");projectUrl.searchParams.set("run", run.id); history.replaceState(null, "", projectUrl);
  $("new-project-setup").hidden = true;
  $("workspace").hidden = false; $("project-title").textContent = project?.name || run.name; $("run-id").textContent = run.id;
  $("reanalyze-visual").hidden = !run || !["ready","failed"].includes(run.status);
  $("reanalyze-brief").hidden = !run || !["ready","failed"].includes(run.status);
  $("reanalyze-brief-panel").hidden = !run || !["ready","failed"].includes(run.status);
  if (run) {
    $("reanalyze-video-description").value = run.videoDescription || "";
    $("reanalyze-sound-requirements").value = run.soundRequirements || "";
    $("reanalyze-sound-style").value = run.style || "";
    $("reanalyze-reference-works").value = referenceWorksFrom(run).join("；");
  }
  $("duration-label").textContent = time(run.duration);void renderWorkflowReport();
  void loadVersionHistory();
  $("parent-version").hidden=!run.parentRunId;$("parent-version").href=run.parentRunId?`/sfx?run=${run.parentRunId}`:"#";
  $("warnings").textContent = run.warnings.join("\n"); $("warnings").hidden = !run.warnings.length;
  $("empty-placement-help").hidden = run.placements.some(p => p.enabled&&!run.events.find(e=>e.id===p.eventId)?.muted);
  $("save-state").textContent = dirty ? "修改已暂存 · 预览未更新" : "已保存到本机";
  $("analysis-summary").hidden = !run.analysisReport; $("analysis-summary").textContent = run.analysisReport ? `${run.analysisReport.model} · ${run.analysisReport.windows} 个重叠窗口 · ${run.analysisReport.refinedContacts} 个接触点完成模型复核。${run.analysisReport.timingNote}` : "";
  const selection = run.selectionReport;
  const actionEvents = run.events.filter(e => !e.muted&&!["ambience", "music"].includes(e.category));
  const coveredActions = new Set(run.placements.filter(p => p.enabled&&!run.events.find(e=>e.id===p.eventId)?.muted).map(p => p.eventId));
  const actionCoverage = actionEvents.filter(e => coveredActions.has(e.id)).length;
  $("selection-summary").hidden = !selection;
  const styleSummaries=[...(run.styleProfile?[`风格：${run.styleProfile.style} · ${run.styleProfile.summary}`]:[]),...(run.referenceStyles||[]).map(r=>`参考作品：${r.keyword} · ${r.profile.summary}`)];
  $("style-summary").hidden=!styleSummaries.length;$("style-summary").textContent=styleSummaries.length?styleSummaries.join("；")+"（文献研究与声音设计推导，未试听参考原声）":"";
  $("selection-summary").textContent = selection ? `${selection.model} · 音频选材${({ complete: "完成", partial: "部分完成", fallback: "使用规则回退", skipped: "无可分析候选" })[selection.status]}：分析 ${selection.analyzedAssets} 份候选片段（${selection.cachedAssets} 份缓存），选用 ${selection.selectedLayers} 层，拒选 ${selection.rejectedLayers} 层，规则回退 ${selection.fallbackLayers} 层。动作覆盖 ${actionCoverage}/${actionEvents.length} 个，尚缺 ${actionEvents.length - actionCoverage} 个动作素材。只分析候选片段，风格与混音仍需试听。` : "";
  if (selection?.scope === "selective") $("selection-summary").textContent += ` 本次为关键与疑难候选复核，其余 ${selection.ruleRetainedLayers || 0} 层沿用名称规则选材。`;
  updatePreviewStatus(); if (!keepVideo) showVideo(false);
  const mix = run.mixReport;
  $("mix-summary").hidden = !mix;
  $("mix-summary").textContent = mix ? `自动混音：${run.workflow?.operation==="automix"&&run.workflow.source==="reused"?"保留原素材、截取与淡入淡出，仅调整电平和避让":"使用已保存的声音主体与释放、边缘淡入淡出"}；${mix.workflow.includes("vocal") ? "角色吼叫与" : ""}关键动作优先，音乐与次要细节动态避让。${mix.measuredLufs != null ? `实测 ${mix.measuredLufs} LUFS，真峰值 ${mix.measuredTruePeakDb} dBTP。` : "生成预览后测量整体响度。"}锁定贴片保留人工设置。` : "";
  if(mix?.perspective) $("mix-summary").textContent += ` 距离混音：${mix.perspective.knownClips}条有远近依据，${mix.perspective.attenuatedClips}条已降低，${mix.perspective.unknownClips}条待复核；远景较轻，细节靠后。`;
  const usageRunId = run.id;
  $("usage-summary").hidden = true;
  fetch(`/api/sfx/runs/${usageRunId}/export/usage`).then(r => r.ok ? r.json() : null).then(report => {
    if (!report || run?.id !== usageRunId) return;
    const t = report.totals;
    $("usage-summary").hidden = false;
    $("usage-summary").textContent = `本次处理 ${(report.elapsedMs / 1000).toFixed(1)} 秒 · ${t.requests} 次模型请求 · 输入 ${t.inputTokens.toLocaleString()} / 输出 ${t.outputTokens.toLocaleString()} token${t.requestsMissingUsage ? `（${t.requestsMissingUsage} 次请求未返回用量，以上为已知部分）` : ""}。${run.parentRunId ? "复用的上一版点位与选材不重复计入本次。" : ""}`;
  }).catch(() => {});
  selectEvent(run.events.some(e => e.id === selectedId) ? selectedId : run.events[0]?.id);
  const exports = $("exports"); exports.replaceChildren();
  const download = $("download-video");
  if (download) {
    download.hidden = !run.render;
    download.href = run.render ? `/api/sfx/runs/${run.id}/export/video` : "#";
    download.download = `${(project?.name || run.name || "Spielkiste").replace(/[<>:"/\\|?*]+/g, "_")}.mp4`;
  }
  const workflowLink=text("a","工作流与质量报告 ↓");workflowLink.href=`/api/sfx/runs/${run.id}/export/workflow`;workflowLink.download="";exports.append(workflowLink);
  for (const [format, label] of [["json", "贴片 JSON ↓"], ["csv", "清单 CSV ↓"], ["events", "事件 JSON ↓"], ["music", "音乐点位 ↓"], ...(run.analysisReport ? [["review", "分析依据 ↓"]] : []), ...(run.selectionReport ? [["selection", "Gemini 选材依据 ↓"]] : []), ...(run.sourceReview ? [["edits", "发声段落复核 ↓"]] : []), ...(run.workflow?.operation === "augment" ? [["described", "描述补声依据 ↓"]] : []), ...(run.mixReport ? [["mix", "混音报告 ↓"], ["usage", "耗时与 token ↓"]] : []), ...(run.render ? [["video", "预览 MP4 ↓"], ["audio", "混音 WAV ↓"]] : [])]) {
    const a = text("a", label); a.href = `/api/sfx/runs/${run.id}/export/${format}`; a.download = ""; exports.append(a);
  }
}
async function poll(id, afterRender = false, playback, {recoverDraft = true, onProgress} = {}) {
  history.replaceState(null,'',`/sfx?run=${id}`);
  setBusy(true);taskPolling=true;renderTaskControls(id,{status:'analyzing',progress:'正在读取任务进度…'});
  try {
    for (;;) {
      const next = await api(`/api/sfx/runs/${id}/status`); status(next.progress); onProgress?.(next.progress);
      renderTaskControls(id,next);
      if (!["analyzing", "rendering", "paused"].includes(next.status)) {
        run = await api(`/api/sfx/runs/${id}`); project = run.projectId ? await api(`/api/sfx/projects/${run.projectId}`).catch(() => null) : null; dirty = false;
        loadExclusions(run);
        if (recoverDraft && restoreDraft()) status("已恢复暂存修改；当前视频仍为上次预览，点击“更新视频预览”后应用。");
        renderWorkspace(true);
        showVideo(afterRender&&Boolean(run.render),playback);
        const historySelect=$("history"); if (run.projectId) historySelect.value=run.projectId;
        try {await api("/api/sfx/workspace",{runId:run.id,projectId:run.projectId});}
        catch {$("save-state").textContent="项目已保存 · 下次恢复记录未更新";}
        if (run.error) throw new Error(run.error);
        if(run.status==='cancelled')throw new Error('本次任务已终止，原版本保持不变。');
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 400));
    }
  } finally {taskPolling=false;setBusy(false); }
}
async function refreshHistory() {
  $("project-storage").textContent="正在读取本机已保存项目…";
  try { const records = await api("/api/sfx/projects"); const select = $("history"); select.replaceChildren(new Option("选择已保存的项目…", "")); records.forEach(p => select.add(new Option(`${p.name} · ${p.versionCount} 个版本 · ${p.git === "synced" ? "Git已同步" : p.git === "committed" ? "已提交到本机 Git" : p.git === "pending-sync" ? "本机已保存，待同步" : p.git === "unavailable" ? "Git不可用" : "仅保存在本机"}`, p.projectId))); if (run?.projectId) select.value = run.projectId;$("project-storage").textContent=`${records.length} 个项目 · 默认仅保存在本机；点击“上传项目到 Git”才上传；是否包含视频及已用素材由 Git 设置决定。`; }
  catch (e) { $("project-storage").textContent=`项目列表暂未加载：${e.message}。可点击刷新重试。`; }
}
async function loadVersionHistory() {
  const picker=$("version-history"); if(!picker||!run?.projectId)return;
  try { const versions=await api(`/api/sfx/projects/${run.projectId}/versions`); picker.replaceChildren(new Option(`当前版本 · ${run.name || `版本 ${run.revision}`}`, run.id)); versions.forEach(v=>{if(v.runId!==run.id)picker.add(new Option(`${v.name || `版本 ${v.revision}`} · ${v.operation||"保存"} · ${new Date(v.createdAt).toLocaleString()}${v.hasPreview?" · 有预览":""}`,v.runId));}); picker.value=run.id; } catch(e) { status(`版本历史暂不可用：${e.message}`,true); }
}
async function projectAction(action, body) {
  if(!run||busy)return;
  setBusy(true); try { const result=await api(`/api/sfx/projects/${run.projectId}/${action}`,body); if(result.project) project=result.project; if(result.runId){await poll(result.runId,true,{time:$('video').currentTime||0,playing:false});} else {await refreshHistory();renderWorkspace(true);} return result; } finally {setBusy(false);} }
function loadProjectInputs() {
  hideStyleConflict();
  $("name").value=project?.name || run.name;$("video-path").value=run.videoPath;$("library-path").value=run.libraryPath;$("music-library-path").value=run.musicLibraryPath||"";libraryPreferences.load(run.libraryPreferences||[]);keywordPreferences.load((run.keywordPreferences||[]).filter(p=>p.purpose!=="reference"));
  loadExclusions(run);
  $("video-description").value=run.videoDescription||"";$("sound-requirements").value=run.soundRequirements||"";$("audio-output-mode").value=run.audioOutputMode||"all";appliedConflictRequirements="";
  $("reference-works").value=referenceWorksFrom(run).join("；");
  $("reanalyze-video-description").value=run.videoDescription||"";
  $("reanalyze-sound-requirements").value=run.soundRequirements||"";
  $("reanalyze-sound-style").value=run.style||"";
  $("reanalyze-reference-works").value=referenceWorksFrom(run).join("；");
  const preset=["修仙","武侠","暗黑奇幻","科幻","写实战争","恐怖悬疑","卡通喜剧","史诗冒险","魔法","现代动作","赛博朋克","像素复古"];$("sound-style").value=run.style?(preset.includes(run.style)?run.style:"custom"):"";$("custom-style").value=run.style||"";$("sound-style").onchange();if(run.styleProfile)showStyleProfile(run.styleProfile);for(const [i,reference] of (run.referenceStyles||[]).entries())showStyleProfile(reference.profile,Boolean(run.styleProfile)||i>0);
}
async function reanalyzeProject(mode) {
  if (!run || busy) return;
  requireUpdatedPreview();
  hideStyleConflict();
  const description = mode === "visual" ? "" : $("reanalyze-video-description").value.trim();
  const soundRequirements = mode === "visual" ? "" : $("reanalyze-sound-requirements").value.trim();
  const style = mode === "visual" ? "" : $("reanalyze-sound-style").value.trim();
  const loadedReferenceText = referenceWorksFrom(run).join("；");
  const mainReferenceText = $("reference-works").value.trim();
  const reanalyzeReferenceText = $("reanalyze-reference-works").value.trim();
  // An explicit edit in the main project input, including clearing it, wins over the loaded value.
  const referenceText = mainReferenceText !== loadedReferenceText ? mainReferenceText : reanalyzeReferenceText;
  const referenceWorks = mode === "visual" ? [] : referenceText.split(/[；;\n]+/u).map(value=>value.trim()).filter(Boolean);
  const playback = { time: $("video").currentTime || 0, playing: false };
  $("video").pause(); setBusy(true);
  status(mode === "visual" ? "Gemini 正在重新分析整段画面和声音点位…" : "Gemini 正在结合新描述要求重新分析画面、点位和音效…");
  let submitted = false;
  try {
    const result = await api(`/api/sfx/runs/${run.id}/reanalyze`, { mode, videoDescription: description || undefined, soundRequirements: soundRequirements || undefined, style: style || undefined,referenceWorks,keywordPreferences:keywordPreferences.read() });
    submitted = true;
    await poll(result.runId, true, playback, { recoverDraft: false });
    loadProjectInputs();
    status(mode === "visual" ? "Gemini 已重新分析并生成新版本，原版本仍保留。" : "已根据新描述要求重新分析并生成新版本，原版本仍保留。", false);
  } catch (error) {
    if (!submitted) updatePreviewStatus();
    throw error;
  } finally { setBusy(false); }
}
function editPayload() {return {revision:run.revision,events:run.events,placements:run.placements,originalGainDb:run.originalGainDb,originalMuted:run.originalMuted===true,audioOutputMode:$("audio-output-mode").value||run.audioOutputMode||"all",musicEnabled:run.musicEnabled!==false,keywordPreferences:keywordPreferences.read(),...exclusionSettings()};}
async function updateEditedPreview() {
  if(!run||busy)return;
  if (!$("event-editor").reportValidity()) throw new Error("请检查事件与贴片参数");
  const previous = { run:structuredClone(run), project, selectedId, selectedLayerId, dirty, preview:showingPreview, exclusions:exclusionSettings() };
  persistDraft();
  const playback={time:$("video").currentTime||0,playing:!$("video").paused};$("video").pause();setBusy(true);status("正在保存并生成新预览…");$("preview-state").textContent="正在生成新视频…";
  try {
    const result=await api(`/api/sfx/runs/${run.id}/edit-preview`,editPayload());
    await poll(result.runId,true,playback,{recoverDraft:false});
    clearDraft(previous.run.id);
    status("视频预览已更新，所有暂存修改已保存为一个新版本。");
  } catch (error) {
    run=previous.run;project=previous.project;selectedId=previous.selectedId;selectedLayerId=previous.selectedLayerId;dirty=previous.dirty;
    loadExclusions(previous.exclusions);
    renderWorkspace(true);persistDraft();showVideo(previous.preview, {time:playback.time,playing:false});
    throw new Error(`预览更新失败，修改已保留，可再次点击“更新视频预览”重试：${error.message}`);
  }
  finally {setBusy(false);updatePreviewStatus();}
}
async function applyManualTiming() {
  const event = selectedEvent();
  if (!run || !event || busy) return;
  if (!$('event-editor').reportValidity()) throw new Error('请检查事件与贴片参数');
  const start = num('event-start'), end = num('event-end');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('事件终点必须大于起点');
  const oldStart = event.start;
  event.start = Math.round(start * 1000) / 1000;
  event.end = Math.round(end * 1000) / 1000;
  for (const p of run.placements.filter(item => item.eventId === event.id)) {
    p.start = Math.max(0, Math.round((p.start + event.start - oldStart) * 1000) / 1000);
    if (['music', 'ambience'].includes(event.category)) {
      const asset = run.assets.find(a => a.id === p.assetId);
      p.duration = Math.max(.001, Math.min(event.end - p.start, run.duration - p.start));
      p.loop = Boolean(asset?.duration && p.sourceOffset + p.duration > asset.duration);
      p.fadeIn = Math.min(p.fadeIn, p.duration / 3);
      p.fadeOut = Math.min(p.fadeOut, p.duration / 3);
      if (p.sourceEdit) p.sourceEdit.duration = p.duration;
    }
  }
  markDirty(); renderEvents(); renderPlacement();
  status('手动时间已暂存，点击“更新视频预览”后应用。');
}
async function aiReidentifyEvent() {
  const event = selectedEvent();
  if (!run || !event || busy) return;
  requireUpdatedPreview();
  if (!event.description.trim()) throw new Error('请先填写事件描述');
  const playback={time:$('video').currentTime||0,playing:!$('video').paused}; $('video').pause(); setBusy(true);
  status('Gemini 正在重新定位当前事件…'); $('preview-state').textContent='正在重新识别点位…';
  let submitted = false;
  try {
    const result = await api(`/api/sfx/runs/${run.id}/locate-event`, { revision:run.revision, eventId:event.id, description:event.description });
    submitted = true; await poll(result.runId, true, playback);
    status(run.events.find(item=>item.id===event.id)?.requiresHumanReview ? '点位已更新，但置信度较低，请人工复核。' : 'Gemini 已重新定位点位并生成新预览。');
  } catch (error) { if (!submitted) updatePreviewStatus(); throw error; }
  finally { setBusy(false); }
}
function describedEventStatus(message, error = false) {
  const element = $("described-event-status");
  element.hidden = false;
  element.textContent = message;
  element.dataset.state = error ? "error" : "progress";
}
async function addDescribedEvent() {
  try { return await submitDescribedEvent(); }
  catch (error) { describedEventStatus(error.message || String(error), true); throw error; }
}
async function submitDescribedEvent() {
  if (!run) throw new Error("请先打开已分析的项目，再描述补声。");
  if (busy) throw new Error("当前任务仍在处理中，请等待完成后再补声。");
  requireUpdatedPreview();
  const input = $("described-event-description").value.trim();
  if (!input) throw new Error("请先描述需要补充的声音，例如“猩猩啃咬角色”");
  const button = $("add-described-event");
  const originalLabel = button?.textContent || "Gemini 查找动作并添加音效";
  const previousIds = new Set(run.events.map(event => event.id));
  const playback={time:$("video").currentTime||0,playing:!$("video").paused}; $("video").pause(); setBusy(true);
  if (button) button.textContent = "正在提交补声分析…";
  describedEventStatus("正在提交补声分析请求…");
  status("正在提交补声分析请求…"); $("preview-state").textContent="正在查找缺失动作并生成新预览…";
  let submitted = false;
  try {
    const result = await api(`/api/sfx/runs/${run.id}/add-described-event`, { revision: run.revision, description: input });
    submitted = true;
    if (button) button.textContent = "正在定位动作并生成预览…";
    describedEventStatus("正在定位动作、匹配素材并生成新预览…");
    status("补声分析已开始，正在定位动作、匹配素材并生成新预览…");
    await poll(result.runId, true, playback, {onProgress: message => describedEventStatus(message)});
    const addedEvents = run.events.filter(event => !previousIds.has(event.id)).sort((a, b) => a.start - b.start);
    const addedIds = new Set(addedEvents.filter(e=>!e.muted).map(e=>e.id));
    const activeAdded = run.placements.filter(p=>addedIds.has(p.eventId)&&p.enabled&&((run.audioOutputMode||"all")==="sfx"?p.category!=="music":run.audioOutputMode==="music"?p.category==="music":p.category!=="music"||run.musicEnabled!==false));
    if (addedEvents.length) {
      $("event-filter").value = "all";
      selectEvent(addedEvents[0].id, false);
      const seekToAddedEvent = () => { if (run?.id === result.runId) $("video").currentTime = Math.max(0, addedEvents[0].start); };
      if ($("video").readyState >= 1) seekToAddedEvent();
      else $("video").addEventListener("loadedmetadata", seekToAddedEvent, { once: true });
      document.querySelector(`[data-event-id="${CSS.escape(addedEvents[0].id)}"]`)?.scrollIntoView({ block: "nearest" });
    }
    if (!activeAdded.length) {
      const message = `已找到 ${addedEvents.length} 个动作点位，但未添加可播放音效。请查看选材缺口，不能视为补声完成。`;
      describedEventStatus(message, true); status(message, true);
      return;
    }
    $("described-event-description").value = "";
    const completed = new Set(activeAdded.map(p=>p.eventId)).size;
    const message = `已根据“${input}”找到 ${addedEvents.length} 个动作点位，添加 ${activeAdded.length} 个启用音效贴片（覆盖 ${completed}/${addedEvents.length} 个点位），已生成新预览，请试听确认。`;
    describedEventStatus(message, completed<addedEvents.length); status(message, completed<addedEvents.length);
  } catch (error) { if (!submitted) updatePreviewStatus(); throw error; }
  finally { setBusy(false); if (button) button.textContent = originalLabel; }
}
async function quickEdit(target,targetId,action) {
  if(!run||busy)return;
  const item = (target === "event" ? run.events : run.placements).find(item => item.id === targetId);
  if (!item) return;
  if(target==="event") {
    if(action==="delete") {run.events=run.events.filter(e=>e.id!==targetId);run.placements=run.placements.filter(p=>p.eventId!==targetId);}
    else {item.muted=action==="mute";if(typeof item.groupMuteWasMuted==="boolean")item.groupMuteWasMuted=item.muted;}
  } else if(action==="delete")run.placements=run.placements.filter(p=>p.id!==targetId);
  else item.enabled=action==="unmute";
  markDirty();
  selectEvent(run.events.some(e=>e.id===selectedId)?selectedId:run.events[0]?.id);
  status(`${{mute:"静音",unmute:"恢复",delete:"删除"}[action]}已暂存，点击“更新视频预览”后应用。`);
}
function guard(action) { return async event => { event?.preventDefault(); try { await action(event); } catch (e) { handleRequestError(e); } }; }
$('pause-task').onclick=guard(()=>controlCurrentTask('pause'));
$('resume-task').onclick=guard(()=>controlCurrentTask('resume'));
$('terminate-task').onclick=guard(()=>controlCurrentTask('terminate'));
const libraryPreferences=createLibraryPreferences($("library-preferences"),{chooseFolder:browseLocalFolder,isBusy:()=>busy,onChange:error=>{if(error)status(error.message,true);else rememberLibrarySettings();}});
const keywordPreferences=createKeywordPreferences($("keyword-preferences"),{isBusy:()=>busy,onChange:()=>{rememberLibrarySettings();if(run)markDirty();}});
const libraryExclusions=createLibraryExclusions($("excluded-library-paths"),{chooseFolder:browseLocalFolder,isBusy:()=>busy,onChange:exclusionsChanged});
const keywordExclusions=createKeywordExclusions($("excluded-keywords"),{isBusy:()=>busy,onChange:exclusionsChanged});
function exclusionSettings() {return {excludedLibraryPaths:libraryExclusions.read(),excludedKeywords:keywordExclusions.read()};}
function loadExclusions(value={}) {libraryExclusions.load(value.excludedLibraryPaths||[]);keywordExclusions.load(value.excludedKeywords||[]);}
function exclusionsChanged(error) {
  if(error){status(error.message,true);return;}
  rememberLibrarySettings();if(run){markDirty();renderCandidates();}
}
function rememberLibrarySettings() {
  try {const previous=JSON.parse(localStorage.getItem("sfx-last-input")||"{}");localStorage.setItem("sfx-last-input",JSON.stringify({...previous,libraryPath:$("library-path").value,musicLibraryPath:$("music-library-path").value,referenceWorks:selectedReferenceWorks(),libraryPreferences:libraryPreferences.read(),keywordPreferences:keywordPreferences.read(),...exclusionSettings()}));}catch { /* optional preference storage */ }
}
function resetToNewProject() {
  taskRunId=null;taskState=null;$('task-controls').hidden=true;
  $("video").pause();
  $("video").removeAttribute("src");
  $("video").load();
  $("audition").pause();
  $("audition").removeAttribute("src");
  $("audition").hidden = true;
  run = null;
  project = null;
  selectedId = null;
  selectedLayerId = "default";
  dirty = false;
  importSession = null;
  $("workspace").hidden = true;
  $("new-project-setup").hidden = false;
  $("reanalyze-visual").hidden = true;
  $("reanalyze-brief").hidden = true;
  $("history").value = "";
  $("name").value = "";
  for(const id of ["video-description","sound-requirements","sound-style","custom-style","reference-works"])$(id).value="";$("audio-output-mode").value="all";$("custom-style-label").hidden=true;$("style-profile-panel").hidden=true;appliedConflictRequirements="";hideStyleConflict();
  $("video-path").value = "";
  $("library-index-status").textContent="首次扫描自动保存，之后使用相同目录直接读取记录；素材有增删或移动时，点击更新。包含音效、优先目录及音乐目录。";
  $("library-path").value = "";
  $("music-library-path").value = "";
  libraryPreferences.load([]);
  keywordPreferences.load([]);
  loadExclusions({});
  $("status").textContent = "可以选择视频和本机音效文件夹。已有项目仍在“已保存项目”中。";
  history.replaceState(null, "", "/sfx?new=1");
}
function referenceWorksFrom(input){
  const names=input.referenceWorks??[...(input.keywordPreferences||[]).filter(p=>p.purpose==="reference").map(p=>p.keyword),...(input.referenceStyles||[]).map(r=>r.keyword)];
  return [...new Map(names.map(name=>[name.normalize("NFKC").trim().toLowerCase(),name.trim()])).values()].filter(Boolean);
}
function selectedReferenceWorks(){return [...new Map($("reference-works").value.split(/[；;\n]+/u).map(name=>[name.normalize("NFKC").trim().toLowerCase(),name.trim()])).values()].filter(Boolean);}
function selectedStyle(){return $("sound-style").value==="custom"?$("custom-style").value.trim():$("sound-style").value;}
function showStyleProfile(profile,append=false){
  $("style-profile-panel").hidden=false;$("style-profile-title").textContent=`${profile.style} · 风格档案 · ${profile.researchedAt.slice(0,10)}`;
  const content=$("style-profile-content");if(!append)content.replaceChildren();else $("style-profile-title").textContent="声音风格与参考作品研究档案";const heading=document.createElement("p");heading.textContent=`${profile.targetType==="work"?"参考作品":"声音风格"}：${profile.style}`;content.append(heading);
  for(const text of [profile.summary,"音色："+profile.palette.join("；"),"避免："+profile.avoid.join("；"),...profile.actionGuidance,"依据限制："+profile.limitations]){const p=document.createElement("p");p.textContent=text;content.append(p);}
  for(const reference of profile.references){const p=document.createElement("p"),a=document.createElement("a");a.textContent=reference.title;try{const url=new URL(reference.url);if(url.protocol!=="https:")continue;a.href=url.href;}catch{continue;}a.target="_blank";a.rel="noopener noreferrer";p.append(a);content.append(p);}
}
$("sound-style").onchange=()=>{hideStyleConflict();$("custom-style-label").hidden=$("sound-style").value!=="custom";$("style-profile-panel").hidden=true;const style=selectedStyle();if(style)void api("/api/sfx/styles").then(result=>{if(style!==selectedStyle())return;const profile=result.profiles?.find(p=>p.style===style);if(profile)showStyleProfile(profile);}).catch(()=>{});};
async function researchSelectedStyle(refresh=false){
  const style=selectedStyle(),works=selectedReferenceWorks();
  if(!style&&!works.length)throw new Error("请选择风格，或在声音方向区填写参考作品");if(busy)return;setBusy(true);
  hideStyleConflict();status(refresh?"正在重新研究并检查声音方向…":"正在分析并检查声音方向…");
  try{
    const result=await api('/api/sfx/styles/check',{style,referenceWorks:works,soundRequirements:$("sound-requirements").value.trim(),refresh});
    let count=0;if(result.styleProfile)showStyleProfile(result.styleProfile,count++>0);
    for(const reference of result.referenceStyles||[])showStyleProfile(reference.profile,count++>0);
    status('声音方向检查通过，档案已保存。');
  }finally{setBusy(false);}

}
$('reference-works').addEventListener('input',hideStyleConflict);$('custom-style').addEventListener('input',hideStyleConflict);
$('apply-style-conflict').onclick=guard(async()=>{
  if(busy)return;
  const custom=$('style-conflict-custom').value.trim();
  if(!conflictSelection&&!custom)throw new Error('请选择一种混合方式，或填写自定义要求。');
  if(conflictIdentity!==JSON.stringify([selectedStyle(),selectedReferenceWorks()])){hideStyleConflict();throw new Error('声音方向已改变，请重新检查。');}
  let existing=$('sound-requirements').value.trim();
  if(appliedConflictRequirements&&existing.endsWith(appliedConflictRequirements))existing=existing.slice(0,-appliedConflictRequirements.length).trim();
  const additions=[conflictSelection,custom].filter(value=>value&&!existing.includes(value));
  const requirements=[existing,...additions].filter(Boolean).join('\n');
  if(requirements.length>4000)throw new Error('声音要求合计不能超过4000字，请精简后重试。');
  appliedConflictRequirements=additions.join('\n');$('sound-requirements').value=requirements;setBusy(true);status('正在检查已确认的声音要求…');
  try{await api('/api/sfx/styles/check',{style:selectedStyle(),referenceWorks:selectedReferenceWorks(),soundRequirements:requirements});hideStyleConflict();status('声音方向检查通过。请点击生成，或根据新说明重新分析。');}
  finally{setBusy(false);}
});
$("research-style").onclick=guard(()=>researchSelectedStyle());$("refresh-style").onclick=guard(()=>researchSelectedStyle(true));
$("refresh-library-index").onclick=guard(async()=>{
  if(busy)return;
  const clean=value=>value.trim().replace(/^"|"$/g, "");
  const paths=[clean($("library-path").value),...libraryPreferences.read().map(p=>clean(p.path)),clean($("music-library-path").value)].filter(Boolean);
  if(!paths.length)throw new Error("请先选择素材库目录，再更新索引");
  setBusy(true);const output=$("library-index-status");
  try{
    output.textContent="正在更新素材库索引…";
    const health=await api("/api/sfx/health");
    if(!health.capabilities?.includes("library-index-cache"))throw new Error("当前服务尚未加载索引缓存功能，请等待正在生成的任务结束后，重新启动 Spielkiste。");
    const {id}=await api("/api/sfx/library-index",{paths});
    for(;;){
      const result=await api(`/api/sfx/library-index/${id}`);
      output.textContent=result.error?`${result.progress}：${result.error}`:result.progress;
      if(result.status==="failed")throw new Error(output.textContent);
      if(result.status==="ready"){status("素材库索引已更新，下次生成将直接读取记录；现有预览保持不变。");break;}
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
  }catch(error){output.textContent=error.message;throw error;}
  finally{setBusy(false);}
});
$("search-library-path").onclick=guard(async()=>{if(busy)return;setBusy(true);try{const value=await searchFolderPaths($("library-path").value.trim());if(value){$("library-path").value=value;rememberLibrarySettings();}}finally{setBusy(false);}});
$("search-music-path").onclick=guard(async()=>{if(busy)return;setBusy(true);try{const value=await searchFolderPaths($("music-library-path").value.trim()||$("library-path").value.trim());if(value){$("music-library-path").value=value;rememberLibrarySettings();}}finally{setBusy(false);}});
$("create-form").onsubmit = event => { event.preventDefault(); };
$("analyze").onclick = guard(async () => {
  if(busy)return;
  if(!$("create-form").reportValidity())return;
  if($("sound-style").value==="custom"&&!selectedStyle())throw new Error("请输入自定义风格名称");
  keepDraftBeforeLeaving();
  hideStyleConflict();status("正在检查声音方向…");
  const input = { videoDescription:$("video-description").value.trim(),soundRequirements:$("sound-requirements").value.trim(),style:selectedStyle(),name: $("name").value, workflowPreset:"reference-v6",reusePreserved:true,audioOutputMode:$("audio-output-mode").value||"all",videoPath: $("video-path").value.trim().replace(/^"|"$/g, ""), libraryPath: $("library-path").value.trim().replace(/^"|"$/g, ""),referenceWorks:selectedReferenceWorks(),libraryPreferences:libraryPreferences.read(),keywordPreferences:keywordPreferences.read(),...exclusionSettings(), musicLibraryPath: $("music-library-path").value.trim().replace(/^"|"$/g, "") };
  setBusy(true);
  try {
    const result = await api("/api/sfx/runs", input); localStorage.setItem("sfx-last-input", JSON.stringify(input));
    selectedId = null; await poll(result.runId, true);
    if(result.reused)status("已打开相同条件下的已有版本；点位、素材、剪辑和混音保持原样。");
  }catch(error) {
    if (/Gemini AI 连接未就绪/.test(error.message)) { await loadAiConfig(); fillAiConfig(aiConfig); $("ai-config-message").className="ai-config-message error"; $("ai-config-message").textContent=error.message; $("ai-config-dialog").showModal(); }
    throw error;
  }finally {setBusy(false);}
});
$("reanalyze-visual").onclick = guard(() => reanalyzeProject("visual"));
$("reanalyze-brief").onclick = guard(() => reanalyzeProject("brief"));
$("history").onchange = guard(async () => {
  const projectId = $("history").value; if (!projectId) return;
  keepDraftBeforeLeaving();
  const project=await api(`/api/sfx/projects/${projectId}`); selectedId = null; await poll(project.currentRunId, true);
  loadProjectInputs();
});
$("refresh-history").onclick = refreshHistory;
$("rename-project").onclick = guard(async()=>{const name=window.prompt("项目名称",run?.name||"");if(name&&name.trim()){await projectAction("rename",{name:name.trim()});status("项目已重命名，不会创建新音效版本。");}});
$("save-as-project").onclick = guard(async()=>{requireUpdatedPreview();const name=window.prompt("新项目名称",`${run?.name||"项目"} 副本`);if(name&&name.trim()){const result=await projectAction("save-as",{name:name.trim()});if(result?.projectId){await refreshHistory();status("已另存为新项目，并切换到新项目。");}}});
$("sync-project").onclick = guard(async()=>{if(!run?.projectId||busy)return;requireUpdatedPreview();const config=await api('/api/sfx/git-config');if(!config.configured){$("git-settings-open").click();return;}const includeMedia=$("git-include-media").checked;if(!window.confirm(`上传当前项目的历史清单${includeMedia?'、视频、预览及已用音频':''}到 ${config.repository}？`))return;setBusy(true);status("正在上传项目到 Git…");try{const result=await api(`/api/sfx/projects/${run.projectId}/sync`,{includeMedia});await refreshHistory();status(result.git.status==='synced'?`项目已上传 · ${result.git.commit?.slice(0,8)} · ${result.git.mediaCount} 个媒体文件`:`本机项目已保留，上传未完成：${result.git.error||'请重试'}`,result.git.status!=='synced');}finally{setBusy(false);}});
$("open-version").onclick = guard(async()=>{const id=$("version-history").value;if(id&&id!==run?.id){keepDraftBeforeLeaving();selectedId=null;await poll(id,true,{time:$('video').currentTime||0,playing:false});status("已打开历史版本；当前项目指针未改变。");}});
$("restore-version").onclick = guard(async()=>{const id=$("version-history").value;if(!id||id===run?.id)return;keepDraftBeforeLeaving();if(!window.confirm("回退会创建一个新的当前版本，旧版本仍保留。继续吗？"))return;await projectAction("restore",{runId:id});status("已回退并生成新的项目版本。");});
$("preserve").onclick=guard(async()=>{
  if(!run||busy)return;
  requireUpdatedPreview();
  const name=window.prompt("新版本名称",`${run.name || "视频音效"} · 新版本`);
  if(!name||!name.trim())return;
  setBusy(true);
  try {
    const result=await api(`/api/sfx/projects/${run.projectId}/save-version`,{name:name.trim(),runId:run.id});
    if(result?.runId){await poll(result.runId,true,{time:$("video").currentTime||0,playing:false});}
    await refreshHistory();
    status(`已保存为新版本：${name.trim()}。可在“版本”中打开或回退。`);
  } finally{setBusy(false);}
});
$("render").onclick = guard(async () => {
  if (!run || busy) return;
  if (!$("event-editor").reportValidity())throw new Error("请检查事件与贴片参数");
  if(dirty){await updateEditedPreview();return;}
  const playback={time:$("video").currentTime||0,playing:!$("video").paused};
  setBusy(true);
  try{const result=await api(`/api/sfx/runs/${run.id}/render`,{});await poll(result.runId,true,playback);}
  finally{setBusy(false);}
});
$("discard-edits").onclick = guard(async () => {
  if (!run || busy || !dirty) return;
  if ($("discard-edits").dataset.confirm !== run.id) {
    $("discard-edits").dataset.confirm = run.id;
    $("discard-edits").textContent = "确认撤销暂存修改";
    status("再点一次即可撤销本次暂存修改，恢复已保存的点位和音效。");
    return;
  }
  const id = run.id;
  const playback = {time:$("video").currentTime || 0, playing:false};
  await poll(id, showingPreview, playback, {recoverDraft:false});
  clearDraft(id);
  delete $("discard-edits").dataset.confirm;
  $("discard-edits").textContent = "撤销暂存修改";
  status("已撤销暂存修改，继续使用已保存的预览。");
});
$("show-source").onclick = () => showVideo(false); $("show-preview").onclick = () => showVideo(true);
$("export-reaper").onclick = guard(async () => {
  if (!run || busy) return;
  $("reaper-export-progress").textContent = dirty ? "有待更新的修改，请先点击“更新视频预览”，完成后再导出。" : "";
  $("reaper-export-result").hidden = true;
  $("reaper-export-dialog").showModal();
});
for (const id of ["close-reaper-export", "cancel-reaper-export"]) $(id).onclick = () => { if (!reaperExporting) $("reaper-export-dialog").close(); };
$("reaper-export-dialog").addEventListener("cancel", event => { if (reaperExporting) event.preventDefault(); });
$("reaper-export-form").onsubmit = async event => {
  event.preventDefault();
  if (!run || busy || reaperExporting) return;
  const channelMode = document.querySelector('input[name="reaper-channel-mode"]:checked').value;
  const audioFormat=$("reaper-audio-format").value,sampleRate=Number($("reaper-sample-rate").value);
  const dither=$("reaper-dither").value, noiseShaping=$("reaper-noise-shaping").checked;
  if (dirty || run.render && run.render.revision !== run.revision) { $("reaper-export-progress").textContent = "有待更新的修改，请先点击“更新视频预览”，完成后再导出。"; return; }
  const requestedOutput = $("reaper-output-path").value.trim().replace(/^"|"$/g, "").trim();
  const outputPath = requestedOutput && !/\.rpp$/i.test(requestedOutput) ? `${requestedOutput}.rpp` : requestedOutput;
  $("reaper-output-path").value = outputPath;
  reaperExporting = true;
  for (const control of $("reaper-export-form").elements) control.disabled = true;
  $("reaper-export-result").hidden = true;
  try {
    setBusy(true);
    $("reaper-export-progress").textContent = channelMode === "preserve" && audioFormat === "preserve" && !sampleRate ? "正在复制完整素材并生成工程…" : "正在载入原素材，由 REAPER 转换并保存成品工程，大型素材需要一些时间…";
    const result = await api(`/api/sfx/runs/${run.id}/export/reaper`, { channelMode,audioFormat,sampleRate,dither,noiseShaping, ...(outputPath ? { outputPath } : {}) });
    $("reaper-export-progress").textContent = `已导出 ${result.placementTrackCount} 条音效轨道、${result.folderTrackCount} 条分类轨道。`;
    const output = $("reaper-export-result");
    const audioFiles = result.manifest.media.filter(file => file.kind === "audio");
    const formats = { preserve: "保留原文件", wav16: "WAV · 16 位 PCM", wav24: "WAV · 24 位 PCM", wav32f: "WAV · 32 位浮点", wav64f: "WAV · 64 位浮点" };
    const effectiveFormat = result.manifest.conversion && result.settings.audioFormat === "preserve" ? "wav64f" : result.settings.audioFormat;
    const channels = [...new Set(audioFiles.map(file => file.channels).filter(Number.isFinite))].sort((a, b) => a - b);
    const rates = [...new Set(audioFiles.map(file => file.sampleRate).filter(Number.isFinite))].sort((a, b) => a - b);
    const actual = result.manifest.conversion
      ? `REAPER 已核验 ${audioFiles.length} 份音频：${channels.map(value => `${value} 声道`).join(" / ")} · ${rates.map(value => `${value / 1000} kHz`).join(" / ")}`
      : `${audioFiles.length} 份完整原文件，保留各自的声道、格式和采样率。`;
    output.replaceChildren(text("p", `本次导出：${formats[effectiveFormat]}`), text("p", actual), text("p", `最终渲染：Dither ${result.settings.dither === "on" ? "开启" : result.settings.dither === "auto" ? "自动（16 位开启）" : "关闭"} · Noise Shaping ${result.settings.noiseShaping ? "开启" : "关闭"}`), text("p", "工程文件"), text("code", result.outputPath), text("p", "移动或分享时，请复制整个文件夹："), text("code", result.projectDirectory));
    output.hidden = false;
    status(`Reaper 工程已生成：${result.outputPath}`);
  } catch (error) {
    $("reaper-export-progress").textContent = `导出失败：${error.message}`;
    status(`Reaper 导出失败：${error.message}`, true);
  } finally {
    setBusy(false);
    reaperExporting = false;
    for (const control of $("reaper-export-form").elements) control.disabled = false;
  }
};
$("video").ontimeupdate = () => { const current=$("video").currentTime || 0; $("timecode").textContent = time(current); const seek=$("video-seek"); if(document.activeElement!==seek) seek.value=String(current); };
$("video-seek").oninput = () => { const value=Number($("video-seek").value); if(Number.isFinite(value)) { $("video").currentTime=value; $("timecode").textContent=time(value); } };
$("video").onerror = () => status("浏览器无法播放该视频编码。可先编辑事件，再生成 H.264 预览。", true);
$("event-filter").onchange = renderEvents;
$("mute-sfx-group").onclick=guard(()=>toggleSoundGroup("sfx"));
$("mute-music-group").onclick=guard(()=>toggleSoundGroup("music"));
$("music-stage").onchange = () => { const e = selectedEvent(); if (e) { e.musicStage = $("music-stage").value; markDirty(); renderEvents(); } };
$("music-intensity").oninput = () => { const e = selectedEvent(); if (!e) return; const delta = (num("music-intensity") - (e.intensity ?? .5)) * 7; e.intensity = num("music-intensity"); for (const p of run.placements.filter(p => p.eventId === e.id)) p.gainDb = Math.max(-60, Math.min(12, Math.round((p.gainDb + delta) * 100) / 100)); markDirty(); renderEvents(); renderPlacement(); };
for (const [id, key] of Object.entries({ description: "description", query: "query", "event-start": "start", "event-end": "end", category: "category" })) {
  $(id).oninput = () => { const e = selectedEvent(); if (!e) return; const oldStart = e.start; e[key] = ["start", "end"].includes(key) ? num(id) : $(id).value;
    if (key === "category") { for (const p of run.placements.filter(p => p.eventId === e.id)) { p.category = e.category; if (e.category === "music") p.role = "music"; } $("music-event-fields").hidden = e.category !== "music"; }
    if (["start", "end"].includes(key)) for (const p of run.placements.filter(p => p.eventId === e.id)) { if (key === "start") p.start = Math.max(0, p.start + e.start - oldStart); if (["music", "ambience"].includes(e.category)) { const a = run.assets.find(a => a.id === p.assetId); p.duration = Math.max(.001, Math.min(e.end - p.start, run.duration - p.start)); p.loop = Boolean(a?.duration && p.sourceOffset + p.duration > a.duration); p.fadeIn = Math.min(p.fadeIn, p.duration / 3); p.fadeOut = Math.min(p.fadeOut, p.duration / 3); } }
    if (key === "query") { const layer = (e.layers || []).find(l => l.id === selectedLayerId) || e.layers?.[0]; if (layer) layer.query = e.query; }
    markDirty(); renderEvents(); renderPlacement(); };
}
for (const [id, key] of Object.entries({ "placement-start": "start", "placement-duration": "duration", "source-offset": "sourceOffset", gain: "gainDb", "fade-in": "fadeIn", "fade-out": "fadeOut" })) $(id).oninput = () => { const p = selectedPlacement(); if (p) { p[key] = num(id); if(["duration","sourceOffset"].includes(key)){Object.assign(p,edgeFades(p.duration,true,p.fadeIn,p.fadeOut));p.sourceEdit={assetId:p.assetId,sourceOffset:p.sourceOffset,duration:p.duration,basis:"manual",reason:"用户裁剪，边缘使用短淡入淡出"};$("fade-in").value=p.fadeIn;$("fade-out").value=p.fadeOut;} markDirty(); } };
$("mute-placement").onclick=guard(()=>{const p=selectedPlacement();if(p)return quickEdit("placement",p.id,p.enabled?"mute":"unmute");});
$("remove-placement").onclick=guard(()=>{const p=selectedPlacement();if(p)return quickEdit("placement",p.id,"delete");});
$("mute-event").onclick=guard(()=>{const e=selectedEvent();if(e)return quickEdit("event",e.id,e.muted?"unmute":"mute");});
$("apply-timing").onclick=guard(applyManualTiming);
$("ai-reidentify").onclick=guard(aiReidentifyEvent);
$("add-described-event").onclick=guard(addDescribedEvent);
$("loop").onchange = () => { const p = selectedPlacement(); if (p) { p.loop = $("loop").checked; markDirty(); } };
$("confirmed").onchange = () => { selectedEvent().requiresHumanReview = !$("confirmed").checked; markDirty(); renderEvents(); };
$("event-editor").onsubmit = event => event.preventDefault();
$("search").onclick = guard(async () => {
  const event = selectedEvent(); if (!event || busy) return;
  setBusy(true); status("查找候选并读取音频信息…");
  try {
    const allLayers = event.layers?.length ? event.layers : [{ id: "default", role: event.category === "other" ? "texture" : event.category, offset: 0, query: event.query, candidates: [] }];
    if (!event.layers?.length) event.layers = allLayers;
    const layers = [allLayers.find(l => l.id === selectedLayerId) || allLayers[0]];
    const searchQuery = $("query").value;
    for (const layer of layers) {
      const results = await api(`/api/sfx/runs/${run.id}/search`, { query: searchQuery || layer.query || event.query, category: event.category,eventId:event.id,keywordPreferences:keywordPreferences.read(),...exclusionSettings() });
      for (const result of results) if (result.asset) {
        const asset = run.assets.find(a => a.id === result.assetId);
        if (asset) Object.assign(asset, result.asset);
        else run.assets.push(result.asset);
      }
      layer.alternatives = results.map(({ assetId, score, reason }) => ({ assetId, score, reason: `待试听备选（非自动选用）：${reason}` }));
    }
    renderCandidates(); status(`找到 ${layers[0].alternatives.length} 个备选，试听后点击“选用”替换。`);
  } finally { setBusy(false); }
});
function addEvent(music = false) {
  const start = Math.min(Math.max(0, $("video").currentTime || 0), Math.max(0, run.duration - .1));
  const event = { id: crypto.randomUUID(), start: Math.round(start * 1000) / 1000, end: Math.min(run.duration, Math.round((start + 1) * 1000) / 1000), type: "manual", description: "新声音事件", query: "", category: "foley", confidence: 1, source: "manual", candidates: [], requiresHumanReview: true };
  if (music) Object.assign(event, { type: "music_cue", category: "music", description: "背景音乐进入", query: "music battle tension", musicStage: "enter", intensity: .5, end: Math.min(run.duration, start + 5) });
  $("event-filter").value = music ? "music" : "all";
  run.events.push(event); run.events.sort((a, b) => a.start - b.start); markDirty(); selectEvent(event.id);
}
function openAddEventMode() {
  const box = $("described-event-box");
  box.hidden = false;
  $("add-event").setAttribute("aria-expanded", "true");
  $("add-event").textContent = "描述补声已展开";
  $("described-event-description").focus();
  box.scrollIntoView({ block: "nearest", behavior: "smooth" });
}
$("add-event").onclick = openAddEventMode;
$("add-manual-event").onclick = guard(() => { $("described-event-box").hidden = true; $("add-event").setAttribute("aria-expanded", "false"); $("add-event").textContent = "＋ 添加事件"; addEvent(false); });
$("add-music").onclick = () => addEvent(true);
$("remove-event").onclick = guard(()=>quickEdit("event",selectedId,"delete"));
let importSession = null;
async function ensureImportSession() {
  if (importSession) return importSession;
  importSession = await api("/api/upload-session", { targetRoot: ".output/sfx/imports/" + crypto.randomUUID() });
  return importSession;
}
async function uploadImportedFile(file, kind, relativePath = file.name) {
  const session = await ensureImportSession();
  const response = await fetch("/api/upload?sessionId=" + encodeURIComponent(session.sessionId) + "&kind=" + encodeURIComponent(kind) + "&targetRoot=" + encodeURIComponent(session.folders.root), { method: "POST", headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(file.name), "x-relative-path": encodeURIComponent(relativePath) }, body: file });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || ("上传失败：" + file.name)); return data;
}
$("pick-video").onclick = () => $("video-file").click();
$("video-file").onchange = guard(async () => {
  const file = $("video-file").files[0]; if (!file) return; setBusy(true); status("正在导入视频…");
  try { const data = await uploadImportedFile(file, "videos"); $("video-path").value = data.path; status("已上传视频副本：" + file.name + "；也可以直接粘贴本机路径。"); }
  finally { setBusy(false); $("video-file").value = ""; }
});
async function browseLocalFolder(target,description) {
  if(busy)return;setBusy(true);status("正在打开 Windows 文件夹窗口，请在系统窗口中选择目录或取消…");
  try {
    const directory=await chooseLocalFolder($(target).value.trim()||(target!=="library-path"?$("library-path").value.trim():""),description);
    if(directory){$(target).value=directory;rememberLibrarySettings();status("已选择素材目录，直接读取音频，无需上传素材库。");}
    else status("已取消选择，原路径保持不变。");
  }finally {setBusy(false);}
}
$("browse-library").onclick=guard(()=>browseLocalFolder("library-path","选择音效素材库路径"));
$("browse-music").onclick=guard(()=>browseLocalFolder("music-library-path","选择背景音乐素材库文件夹（可选）"));
$("library-path").addEventListener("change",rememberLibrarySettings);$("music-library-path").addEventListener("change",rememberLibrarySettings);
$("new-project").onclick = guard(() => {
  keepDraftBeforeLeaving();
  resetToNewProject();
});
$("open-new-project").onclick = guard(() => {
  keepDraftBeforeLeaving();
  resetToNewProject();
  $("new-project-setup").hidden=false;
  $("new-project-setup").scrollIntoView({behavior:"smooth",block:"start"});
});
$("open-project-window").onclick = guard(async () => {
  if(window.spielkisteDesktop?.newWindow)await window.spielkisteDesktop.newWindow();
  else window.open("/sfx?new=1","_blank","noopener");
});
$("switch-project").onclick = () => { $("history").focus(); $("saved-projects").scrollIntoView({behavior:"smooth",block:"center"}); };
window.addEventListener("beforeunload", event => { if (dirty && !persistDraft()) { event.preventDefault(); event.returnValue = ""; } });
const initialParams=new URLSearchParams(location.search),initialId = initialParams.get("run");
const historyLoad=refreshHistory();
if(initialId) {
  setBusy(true);status(initialId?"正在打开已保存项目…":"正在恢复上次打开的本机项目…");
  try {
    await poll(initialId,true);loadProjectInputs();status("已打开本机保存的项目，可以直接播放或继续编辑。");
  }catch(e){status(`项目暂未打开：${e.message}。可以从“已保存项目”重新选择。`,true);}
  finally{setBusy(false);}
}else resetToNewProject();
await historyLoad;
await loadAiConfig();


