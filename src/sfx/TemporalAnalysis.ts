import {extractDescriptionConstraints,reviewDescriptionWindow} from './DescriptionConstraints.js';
import {creativeContext,type CreativeBrief} from "./CreativeBrief.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DistanceSchema, EventSchema, ImportanceSchema, Scene, SoundEvent, round } from "./models.js";
import { MediaSource } from "./MediaTools.js";
import { writeJson } from "./SfxRunStore.js";
import { SFX_WORKFLOW } from "./WorkflowPolicy.js";
import { trustedDistance } from "./MixPerspective.js";

export interface FrameDirector {
  readonly model?:string;
  analyzeFrames(scenes: Scene[], prompt: string, signal?: AbortSignal): Promise<unknown>;
}
export interface AnalysisOptions extends CreativeBrief { signal?: AbortSignal; progress?: (message: string) => void; musicEnabled?: boolean }
export function temporalWindows(duration: number) {
  const windows: Array<{ start: number; end: number }> = [];
  for (let start = 0; start < duration; start += SFX_WORKFLOW.timing.hopSeconds) {
    windows.push({ start: round(start), end: round(Math.min(duration, start + SFX_WORKFLOW.timing.windowSeconds)) });
    if (start + SFX_WORKFLOW.timing.windowSeconds >= duration) break;
  }
  return windows;
}

export function actionReviewWindows(duration: number) {
  const windows: Array<{ start: number; end: number }> = [];
  for (let start = 0; start < duration; start += SFX_WORKFLOW.timing.reviewHopSeconds) {
    windows.push({ start: round(start), end: round(Math.min(duration, start + SFX_WORKFLOW.timing.reviewSeconds)) });
    if (start + SFX_WORKFLOW.timing.reviewSeconds >= duration) break;
  }
  return windows;
}

export function mergeWindowEvents(windows: SoundEvent[][]): SoundEvent[] {
  const result: SoundEvent[] = [];
  for (const window of windows) {
    const matched = new Set<SoundEvent>(), additions: SoundEvent[] = [];
    for (const event of [...window].sort((a, b) => a.start - b.start)) {
    const duplicate = result.filter(e => {
      if (matched.has(e)) return false;
      const canonical = (type: string) => type.replace(/^(?:player|boss)_/, "").replace(/_sustain$/, "").replace(/^(?:foot_?step|step)$/, "footstep");
      if ((e.actor || "") !== (event.actor || "") || canonical(e.type) !== canonical(event.type) || e.phase !== event.phase || e.category !== event.category && e.phase !== "contact") return false;
      const overlap = Math.max(0, Math.min(e.end, event.end) - Math.max(e.start, event.start));
      const contact = e.category === "impact" || e.phase === "contact";
      return Math.abs(e.start - event.start) <= (contact ? .2 : .32) && overlap > 0
        || !contact && overlap / Math.min(e.end - e.start, event.end - event.start) > .7;
    }).sort((a, b) => Math.abs(a.start - event.start) - Math.abs(b.start - event.start))[0];
    if (!duplicate) additions.push(event);
    else {
      matched.add(duplicate);
      const end = Math.max(duplicate.end, event.end);
      const oldDistance=duplicate.distance,oldImportance=duplicate.importance;
      const requirements=[...new Set([...(duplicate.descriptionRequirementIds||[]),...(event.descriptionRequirementIds||[])])];
      if (event.confidence > duplicate.confidence) Object.assign(duplicate, event, { id: duplicate.id });
      // Spatial confidence is independent of contact timing confidence; timing-only updates retain it.
      const spatial=[oldDistance,event.distance].filter((d):d is NonNullable<typeof d>=>Boolean(trustedDistance(d))).sort((a,b)=>b.confidence-a.confidence)[0];
      duplicate.distance=spatial||duplicate.distance||oldDistance;
      duplicate.importance=duplicate.importance||oldImportance||event.importance;
      duplicate.end = round(end);
      if(requirements.length)duplicate.descriptionRequirementIds=requirements;
    }
    }
    result.push(...additions);
  }
  return result.sort((a, b) => a.start - b.start);
}

const spatialShape = `"distance":{"range":"near/mid/far/unknown","confidence":0.8,"evidence":"声源远近的可见依据，不能确定时写unknown"},"importance":"key/support/detail"`;
const eventShape = `{"start":0.0,"end":1.0,"type":"player_charge","actor":"player/boss/ui/environment","phase":"preparation/motion/contact/aftermath/sustain","description":"中文具体描述","query":"brief English filename keywords","category":"foley/impact/whoosh/ambience/music/other","confidence":0.8,"evidence":"可见画面证据，不需要推理过程",${spatialShape}}`;
const guardrails = `每张图顶端及图片前文本都是整片 ABSOLUTE TIME，禁止相对窗口计时。只报实际可见事件，不预测窗口外的命中。持续姿势是持续事件，不是连续新攻击。分清玩家与Boss、起手与接触、红色预警与伤害；接触取首次碰撞/闪光/破土/落地帧，不能用起手帧替代。橙色命中光不等于火焰爆炸。UI只报真实切换/反馈，不为静态HUD、伤害数字或镜头切换凭空发声；新增伤害数字配合受击反应或血条变化可以支持延迟技能命中的证据，需写明可见依据。没有可见命中证据就不报命中。可见动作逐项覆盖，包括蓄力档位、跳跃、挥刀、咆哮、捶胸、落地、地刺、受击、碎石。query匹配文件名，简短而准确，不堆无关词；cast用于施法，charge用于蓄力，swish用于挥动，impact用于实际接触。准备/抬手/收势不能匹配impact；contact表示真实接触。多次捶胸、挥击逐次分开记录，type用chest_pound/sword_swing/sword_hit/land/ground_slam等稳定名称；同一动作的跨窗type一致。category和phase只能取列举值中的一个。
每条事件额外输出distance和importance。distance相对摄像机及画面玩家的听觉视点，只分near近景、mid中景、far远景、unknown不确定，附独立confidence和简短可见evidence；结合地面纵深、角色与玩家间距、遮挡及运动判断，不以Boss身体巨大或单帧占屏大小代替距离，更不能编造米数。按这次声音实际发声位置判断：远处怪物的吼叫/捶胸在怪物处，飞到玩家身边的石块命中/地刺破土按近处落点，不继承攻击者距离。发声位置显著变化时按真实动作阶段划分，不能把同一声反复复制；UI/配乐/环境底床记unknown，不继承Boss距离。importance按当前动作的游戏可读性选key关键预警/咆哮/蓄力/主要释放/重击与命中、support普通主体、detail细碎脚步/碎屑/衣物/尾部装饰；真实重要的落地可为key，不能把每条接触或每个Boss动作都标key。`;

function parseEvents(value: unknown, duration: number, precision: number): SoundEvent[] {
  const items = z.object({ events: z.array(z.unknown()).max(160) }).passthrough().parse(value).events;
  return items.flatMap(item => {
    const raw = item as Record<string, unknown>;
    const start = round(Math.max(0, Number(raw.start))), end = round(Math.min(duration, Number(raw.end)));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
    const parsed = EventSchema.safeParse({ ...raw, id: randomUUID(), start, end, source: "vision", candidates: [], requiresHumanReview: true, timingPrecision: precision });
    if (!parsed.success) throw new Error(`模型事件格式无效：${parsed.error.issues.map(i => i.path.join(".")).join(", ")}`);
    return [parsed.data];
  });
}

/** Uses the same workflow for every video; no video-specific cue times or asset IDs. */
export async function analyzeTemporal(video: string, duration: number, outputDir: string, media: MediaSource, director: FrameDirector, options: AnalysisOptions = {}) {
  let brief=creativeContext(options);
  const originalDirector=director;
  if(brief)director={model:originalDirector.model,analyzeFrames:(scenes,prompt,signal)=>originalDirector.analyzeFrames(scenes,prompt+brief,signal)};
  const signal = options.signal, progress = options.progress || (() => {});
  if (!media.sampleFrames) throw new Error("当前媒体工具不支持密集时间帧");
  if (duration > SFX_WORKFLOW.timing.maxVideoSeconds) throw new Error("精细动作分析当前支持 5 分钟以内视频，请先截取动作片段。");
  const warnings: string[] = [];
  let focusedWindows=0;
  signal?.throwIfAborted();
  progress("Gemini 1/4：抽取带绝对时间的密集动作帧（5 FPS）");
  const frames = await media.sampleFrames(video, 0, duration, SFX_WORKFLOW.timing.fps, path.join(outputDir, "frames", "dense"), signal, SFX_WORKFLOW.timing.frameWidth);
  if (!frames.length) throw new Error("未能抽取有效画面");
  const overviewFrames = frames.filter((_, i) => i % Math.max(1, Math.ceil(frames.length / 36)) === 0);
  if (overviewFrames.at(-1) !== frames.at(-1)) overviewFrames.push(frames.at(-1)!);
  progress("Gemini 1/4：理解完整视频、角色和背景音乐结构");
  const descriptionConstraints=await extractDescriptionConstraints(originalDirector,overviewFrames,options,signal);
  if(descriptionConstraints){brief=creativeContext({...options,descriptionConstraints});progress("已解析描述要求，画面分析后将逐项核对");}
  const overviewPrompt = `你是游戏视频声音导演，先理解完整视频 ${duration} 秒。${guardrails}
返回JSON {"context":"中文简述角色、场景、武器材质与战斗节奏，角色只确认外形不猜游戏专名","focusRegions":[{"actor":"boss","x":0.1,"y":0.2,"width":0.5,"height":0.5,"reason":"需要放大复查的头口或武器动作"}],"events":[${eventShape}]}。focusRegions最多2个，坐标是原图归一化0..1，覆盖该角色在全片中的移动范围，排除字幕HUD；清晰近景可空数组。
本轮events只给环境氛围${options.musicEnabled !== false ? "和背景音乐结构" : "，不要音乐"}，不要具体动作。
${options.musicEnabled !== false ? `音乐是创作配乐建议，不是听到原声：给出进入enter、增强build、高潮climax、收束release、退出exit的实际区间，额外字段musicStage及intensity(0..1)，category=music、type=music_cue、query='music boss battle tension orchestral'等本地音乐文件名词；按画面节奏选择合理阶段，无需硬凑5种，区间连续、顺序明确、最多8段、不重叠。结束前安排淡出；不将每次攻击都切成一首新曲。` : ""}`;
  const overview = await director.analyzeFrames(overviewFrames, overviewPrompt, signal);
  await writeJson(path.join(outputDir, "analysis-overview.json"), overview);
  let overviewEvents = parseEvents(overview, duration, .2).filter(e => e.category === "ambience" || options.musicEnabled !== false && e.category === "music");
  // Music intervals express a single continuous score, not stacked songs.
  let musicEnd = 0;
  overviewEvents = overviewEvents.sort((a, b) => a.start - b.start).filter(e => {
    if (e.category !== "music") return true;
    e.start = round(Math.max(e.start, musicEnd));
    if (e.end <= e.start) return false;
    musicEnd = e.end; return true;
  });
  const context = typeof (overview as any)?.context === "string" ? (overview as any).context.slice(0, 2000) : "";
  const regionSchema=z.object({actor:z.string().max(100),x:z.number().min(0).max(1),y:z.number().min(0).max(1),width:z.number().min(.05).max(1),height:z.number().min(.05).max(1),reason:z.string().max(1000).optional()});
  const regions=(Array.isArray((overview as any)?.focusRegions)?(overview as any).focusRegions:[]).slice(0,2).flatMap((value:unknown)=>{const r=regionSchema.safeParse(value);return r.success&&r.data.x+r.data.width<=1.001&&r.data.y+r.data.height<=1.001?[r.data]:[];});
  const windows = temporalWindows(duration), proposed: SoundEvent[][] = [];
  // Bounded concurrency keeps the local gateway responsive and covers the entire clip.
  for (let i = 0; i < windows.length; i += 2) {
    const results = await Promise.allSettled(windows.slice(i, i + 2).map(async (window, j) => {
      signal?.throwIfAborted(); progress(`Gemini 2/4：动作分段 ${i + j + 1}/${windows.length}（${window.start}–${window.end} 秒）`);
      const selected = frames.filter(f => f.start >= window.start - .001 && f.start < window.end);
      const result = await director.analyzeFrames(selected, `完整场景：${context}\n只分析窗口 ${window.start}–${window.end} 秒中的实际动作。${guardrails}\n返回JSON {"events":[${eventShape}]}。本轮不含环境和音乐；先逐个角色检查头口发声动作、预警、蓄力、攻击与接触，再检查普通移动和脚步，不能用大量脚步替代关键动作。吼叫需有张嘴、胸颈用力等动态证据；仅单帧露齿不能证明吼叫。最多60个事件，描述中文，保留细小但真实的动作与UI反馈。`, signal);
      await writeJson(path.join(outputDir, `analysis-window-${i + j + 1}.json`), { ...window, result });
      return parseEvents(result, duration, .2).filter(e => e.category !== "music" && e.category !== "ambience" && e.start >= window.start - .2 && e.start < window.end);
    }));
    for (const result of results) { if (result.status === "rejected") throw result.reason; proposed.push(result.value); }
  }
  let actions = mergeWindowEvents(proposed);
  // Re-read distant faces and weapon gestures at their native detail instead of
  // relying on one compressed whole-frame view for all subsequent passes.
  if(media.sampleRegionFrames)for(const [regionIndex,region]of regions.entries())for(const [i,window]of windows.entries()){
    signal?.throwIfAborted();progress(`Gemini 角色局部动作查漏：${region.actor} · ${i+1}/${windows.length}`);
    try{
      const selected=await media.sampleRegionFrames(video,window.start,window.end,SFX_WORKFLOW.timing.fps,path.join(outputDir,'frames',`focus-${regionIndex+1}-${i+1}`),region,signal);
      const existing=actions.filter(e=>e.start<window.end&&e.end>window.start).map(({start,end,type,actor,description})=>({start,end,type,actor,description}));
      const result=await director.analyzeFrames(selected,`角色局部动作查漏。这是原画面区域 ${JSON.stringify(region)} 的放大图，角色标识${region.actor}，场景${context}，时间${window.start}–${window.end}。现有清单${JSON.stringify(existing)}。${guardrails} 重点复核头口张合、胸颈用力、预警、蓄力、手臂武器轨迹和真实接触，逐张对照，只补遗漏动作；静态张嘴或露齿不是连续吼叫证据。局部图不能推断画外命中，距离沿用原全景判断，不因放大改成近景。JSON {"events":[${eventShape}]}，不含环境音乐，最多25条。`,signal);
      await writeJson(path.join(outputDir,`analysis-focus-${regionIndex+1}-${i+1}.json`),{region,...window,result});
      focusedWindows++;
      actions=mergeWindowEvents([actions,parseEvents(result,duration,.2).filter(e=>!["music","ambience"].includes(e.category)&&e.start>=window.start&&e.start<window.end)]);
    }catch(error){signal?.throwIfAborted();warnings.push(`角色局部复查失败，保留全景点位待复核：${String(error instanceof Error?error.message:error).slice(0,180)}`);}
  }
  // Revisit each section with the current list visible to find omitted secondary actions.
  for (let i = 0; i < windows.length; i += 2) {
    const results = await Promise.allSettled(windows.slice(i, i + 2).map(async (window, j) => {
      signal?.throwIfAborted(); progress(`Gemini 2/4：动作覆盖查漏 ${i + j + 1}/${windows.length}`);
      const existing = actions.filter(e => e.start < window.end && e.end > window.start).map(e => ({ start: e.start, end: e.end, type: e.type, actor: e.actor, phase: e.phase, description: e.description }));
      const selected = frames.filter(f => f.start >= window.start - .001 && f.start < window.end);
      const result = await director.analyzeFrames(selected, `动作覆盖查漏。场景：${context}。窗口 ${window.start}–${window.end}。现有清单：${JSON.stringify(existing)}。${guardrails}\n逐张对照，只返回清单遗漏的真实动作：尤其头口与胸颈的发声动作、预警与蓄力、落地后再次挥刀/命中、Boss抬臂/砸下、捶胸连续接触、UI收起。不要把“收势/站立/恢复”等泛称覆盖的区间当作没有其他动作。禁止重复已有事件，未遗漏则空数组。返回 {"events":[${eventShape}]}，不含音乐环境，最多25条。`, signal);
      await writeJson(path.join(outputDir, `analysis-audit-${i + j + 1}.json`), { ...window, result });
      return parseEvents(result, duration, .2).filter(e => !["music", "ambience"].includes(e.category) && e.start >= window.start - .2 && e.start < window.end);
    }));
    for (const result of results) { if (result.status === "rejected") { signal?.throwIfAborted(); warnings.push("动作查漏部分失败，保留首次分析结果待复核"); } else actions = mergeWindowEvents([actions, result.value]); }
  }
  const reviewWindows = actionReviewWindows(duration);
  // Short, sharper sequences avoid treating a whole recovery pose as one action.
  for (let i = 0; i < reviewWindows.length; i += 2) {
    const results = await Promise.allSettled(reviewWindows.slice(i, i + 2).map(async (window, j) => {
      signal?.throwIfAborted(); progress(`Gemini 2/4：短窗动作复查 ${i + j + 1}/${reviewWindows.length}（${window.start}–${window.end} 秒）`);
      const existing = actions.filter(e => e.start < window.end && e.end > window.start).map(e => ({ id: e.id, start: e.start, end: e.end, type: e.type, actor: e.actor, phase: e.phase, category: e.category, description: e.description }));
      const selected = await media.sampleFrames!(video, window.start, window.end, SFX_WORKFLOW.timing.reviewFps, path.join(outputDir, "frames", `action-review-${i + j + 1}`), signal, 768);
      const result = await director.analyzeFrames(selected, `短窗动作复查。场景：${context}。只审核 ${window.start}–${window.end} 秒。现有清单：${JSON.stringify(existing)}。${guardrails}\n这组画面更清晰且每秒12帧，逐帧检查武器轨迹、双方身体、地面、技能光效和变化的UI。站起/收势/待机的泛称不能代替实际再次挥刀；持续捶胸要逐次标出首次接触；一次砸地不能被不同说法重复计数，脚落地和拳砸地按真实身体部位区分。\n只返回漏项或纠正项，没问题不要复述。JSON {"replaceEventIds":["被纠正或重复的原事件id"],"events":[${eventShape}]}。只有证据明确且你提供了更准确替代动作时才删除原事件；局部复查不得删除跨越此窗口的整个持续事件，环境和音乐不变，最多35个动作。`, signal);
      const parsed = z.object({ replaceEventIds: z.array(z.string()).max(60).default([]) }).passthrough().parse(result);
      const events = parseEvents(result, duration, 1 / 12).filter(e => !["music", "ambience"].includes(e.category) && e.start >= window.start - .083 && e.start < window.end);
      // A replacement must concern the same actor and overlapping visible action.
      // Unrelated additions are not permission to delete every event in the window.
      const vocal=(e:Pick<SoundEvent,'type'|'description'>)=>/roar|grunt|growl|vocal|吼叫|咆哮|叫声/i.test(`${e.type} ${e.description}`);
      const replacements = parsed.replaceEventIds.filter(id => existing.some(e => e.id === id && e.start >= window.start && e.end <= window.end && events.some(next => next.actor === e.actor && next.start < e.end && next.end > e.start && vocal(next)===vocal(e))));
      await writeJson(path.join(outputDir, `analysis-action-review-${i + j + 1}.json`), { ...window, result, appliedReplacements: replacements });
      return { events, replacements };
    }));
    for (const result of results) {
      if (result.status === "rejected") { signal?.throwIfAborted(); warnings.push("部分短窗复查失败，保留现有清单待复核"); }
      else actions = mergeWindowEvents([actions.filter(e => !result.value.replacements.includes(e.id)), result.value.events]);
    }
  }
  const contacts = actions.filter(e => e.category === "impact" || e.phase === "contact");
  let refinedContacts = 0;
  for (let i = 0; i < contacts.length; i += 2) {
    const results = await Promise.allSettled(contacts.slice(i, i + 2).map(async (event, j) => {
      signal?.throwIfAborted(); progress(`Gemini 3/4：接触点复核 ${i + j + 1}/${contacts.length}（约 ${event.start} 秒）`);
      const start = Math.max(0, event.start - .5), end = Math.min(duration, event.start + .55);
      const closeFrames = await media.sampleFrames!(video, start, end, SFX_WORKFLOW.timing.contactFps, path.join(outputDir, "frames", `contact-${i + j + 1}`), signal, 768);
      const result = await director.analyzeFrames(closeFrames, `逐帧复核这一条接触事件：${JSON.stringify({ id: event.id, start: event.start, type: event.type, description: event.description, actor: event.actor,distance:event.distance,importance:event.importance })}。${guardrails}\n返回JSON {"visible":true,"start":0.0,"end":0.0,"confidence":0.8,"evidence":"中文说明第一张实际接触/地面破裂/命中闪光证据",${spatialShape}}。如没有看到这条接触，visible=false；不要替换成另一角色的动作。start/end整片绝对时间，精确按画面标签，end>start。`, signal);
      const review = z.object({ visible: z.boolean(), start: z.number().finite().optional(), end: z.number().finite().optional(), confidence: z.number().min(0).max(1).optional(), evidence: z.string().max(2000),distance:DistanceSchema.optional(),importance:ImportanceSchema.optional() }).parse(result);
      await writeJson(path.join(outputDir, `analysis-contact-${i + j + 1}.json`), { eventId: event.id, originalStart: event.start, review });
      if (!review.visible) { event.confidence = Math.min(event.confidence, .35); event.evidence = `密集帧未确认接触：${review.evidence}`; return; }
      if (review.start === undefined || review.start < start || review.start > end || review.end === undefined || review.end <= review.start) throw new Error("接触点复核返回了窗口外时间");
      event.start = round(review.start); event.end = round(Math.min(duration, Math.max(review.end, event.start + .05)));
      event.confidence = Math.min(event.confidence, review.confidence ?? event.confidence); event.evidence = review.evidence; event.timingPrecision = 1 / 30;
      if(review.distance)event.distance=review.distance;
      if(review.importance)event.importance=review.importance;
      refinedContacts++;
    }));
    for (const result of results) if (result.status === "rejected") {
      signal?.throwIfAborted(); warnings.push(`局部接触复核失败，保留初次点位待复核：${String(result.reason instanceof Error ? result.reason.message : result.reason).slice(0, 200)}`);
    }
  }
  signal?.throwIfAborted(); progress("Gemini 4/4：合并跨段事件、整理音乐点位与画面证据");
  let events = mergeWindowEvents([overviewEvents, actions]);
  let descriptionReview:import('./CreativeBrief.js').DescriptionReview|undefined;
  if(descriptionConstraints){
    const reviewed:SoundEvent[][]=[],missing:Array<{requirementId:string;reason:string}>=[];
    for(let start=0;start<duration;start+=6){
      const end=Math.min(duration,start+6);
      progress(`Gemini 描述逐项复核：${start}–${end} 秒`);
      const selected=frames.filter(f=>f.start>=Math.max(0,start-.2)&&f.start<Math.min(duration,end+.2));
      const result=await reviewDescriptionWindow(director,selected,events.filter(e=>e.start>=start&&e.start<end),descriptionConstraints,duration,start,end,eventShape,signal);
      reviewed.push(result.events);missing.push(...result.missing);
    }
    events=mergeWindowEvents(reviewed);
    descriptionReview={constraints:descriptionConstraints,requirements:descriptionConstraints.requirements.filter(r=>r.requiresSound).map(r=>{
      const matches=events.filter(e=>e.descriptionRequirementIds?.includes(r.id));
      return {...r,eventIds:matches.map(e=>e.id),status:matches.length?'located' as const:'not-visible' as const,reason:matches.length?'Gemini 已按画面定位':missing.filter(m=>m.requirementId===r.id).map(m=>m.reason).join('；')||'未确认对应画面动作，请检查说明或补充定位'};
    })};
    for(const r of descriptionReview.requirements)if(r.status!=='located')warnings.push(`描述要求未覆盖：${r.text}（${r.reason}）`);
    await writeJson(path.join(outputDir,'description-review.json'),descriptionReview);
  }
  if (!descriptionConstraints && options.musicEnabled !== false && !events.some(e => e.category === "music")) warnings.push("模型未给出可靠的音乐结构，音乐点位留空，可在时间线添加。");
  const report = { descriptionReview, workflow: "overview-window-focus-audit-dense-contact-v4", model: director.model || process.env.SFX_CCSWITCH_MODEL || SFX_WORKFLOW.model, windows: windows.length, refinedContacts, timingNote: `动作按5 FPS、全景宽${SFX_WORKFLOW.timing.frameWidth}px分析，完成${focusedWindows}个角色局部复查、${reviewWindows.length}个12 FPS短窗查漏纠错，接触点用30 FPS模型复核；画面采样精度不等于判断准确率，仍需试听复核。` };
  await writeJson(path.join(outputDir, "analysis-review.json"), { ...report, context, warnings, events });
  return { events, scenes: overviewFrames, warnings, report };
}
