import {compatibilityEvidence,type CreativeBrief} from "./CreativeBrief.js";
import { AudioAsset, AudioLibraryIndex, SoundEvent, SoundPlacement } from "./models.js";
import { assetNameAdvice } from "./AssetIntent.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { writeJson } from "./SfxRunStore.js";
import { diverseCandidates } from "./CandidateDiversity.js";
import { SFX_WORKFLOW } from "./WorkflowPolicy.js";
import {keywordPreferenceResolver,pathPreference,referenceStylesFor} from "./LibraryPreferences.js";
import { chargeContinuityAdvice } from "./SoundIntentReview.js";
import {eligibleAssets,filterEventCandidates} from "./AssetExclusions.js";
import {AudioLibraryIndexer} from './AudioLibraryIndexer.js';

export type AudioSample = { assetId: string; data: string; format: "wav"; segments: { start: number; end: number }[] };
export type AudioDescription = { assetId: string; summary: string; tags: string[]; energy: number; hasMusic: boolean; hasSpeech: boolean };
export type SelectionTask = { creativeBrief?:CreativeBrief; taskId: string; event: Pick<SoundEvent, "id" | "category" | "description" | "query" | "type" | "start" | "end" | "actor" | "phase" | "evidence" | "musicStage" | "intensity">; role: string; layerQuery: string; previousAssetId?: string; candidates: (AudioDescription & { fileName: string; duration?: number; pathPreference?: {path:string;weight:number}; keywordPreference?: NonNullable<AudioLibraryIndex["keywordPreferences"]>[number]; pitchSweep?: boolean; nameAdvice?: ReturnType<typeof assetNameAdvice>; continuityAdvice?: ReturnType<typeof chargeContinuityAdvice> })[] };
export type RecoveryTask = {taskId:string;query:string;description:string;reason:string};
export type RecoveryAsset = {assetId:string;fileName:string;relativePath:string;acoustics?:AudioAsset['acoustics']};
export type AudioSelectionModel = { model: string; reasoningEffort?: "high" | "xhigh"; initialize?(): Promise<void>; describe(samples: AudioSample[], signal?: AbortSignal): Promise<unknown>; choose(tasks: SelectionTask[], signal?: AbortSignal,samples?:AudioSample[]): Promise<unknown>; discover?(tasks:RecoveryTask[],catalogue:RecoveryAsset[],signal?:AbortSignal):Promise<unknown> };
export type AudioClipSource = { sample(asset: AudioAsset, music: boolean, outputDir: string, signal?: AbortSignal): Promise<AudioSample>; inspect?(asset: AudioAsset, signal?: AbortSignal): Promise<boolean> };
export type SelectionOptions = { outputDir: string; cacheDir: string; signal?: AbortSignal; progress?: (message: string) => void; previousPlacements?: SoundPlacement[]; recoveryAttempt?:boolean };
export type SelectionReport = { elapsedMs?: number; model: string; status: "complete" | "partial" | "fallback" | "skipped"; analyzedAssets: number; cachedAssets: number; selectedLayers: number; rejectedLayers: number; fallbackLayers: number; warnings: string[]; decisions: { eventIds: string[]; taskId: string; assetId: string | null; reason: string; basis: "audio-context" | "fallback" }[]; audio: AudioDescription[] };

const descriptionSchema = z.object({ assetId: z.string(), summary: z.string().min(1).max(2000), tags: z.array(z.string().max(100)).max(20), energy: z.number().min(0).max(1), hasMusic: z.boolean(), hasSpeech: z.boolean() });
const choicesSchema = z.object({ choices: z.array(z.object({ taskId: z.string(), assetId: z.string().nullable(), reason: z.string().min(1).max(2000), confidence: z.number().min(0).max(1),meetsDescription:z.boolean().optional() })).max(100) });

export class GeminiAudioSelector {
  constructor(private model: AudioSelectionModel, private clips: AudioClipSource) {}
  async select(events: SoundEvent[], index: AudioLibraryIndex, options: SelectionOptions): Promise<SelectionReport> {
    const selectionStarted = Date.now();
    options.signal?.throwIfAborted();
    await this.model.initialize?.();
    const report: SelectionReport = { model: this.model.model, status: "skipped", analyzedAssets: 0, cachedAssets: 0, selectedLayers: 0, rejectedLayers: 0, fallbackLayers: 0, warnings: [], decisions: [], audio: [] };
    filterEventCandidates(events.filter(e=>!e.locked),index.assets,index);
    const assets = new Map(eligibleAssets(index.assets,index).map(a => [a.id, a]));
    type Group = { taskId: string; events: SoundEvent[]; layers: NonNullable<SoundEvent["layers"]>; ids: string[] };
    const groups: Group[] = [];
    const unlocked = events.filter(e => !e.locked);
    for (const event of unlocked.filter(e => e.category !== "music")) {
      if (!event.layers?.length) event.layers = [{ id: "default", role: event.category === "other" ? "texture" : event.category, query: event.query, offset: 0, candidates: [...event.candidates] }];
      for (const layer of event.layers || []) {
        layer.candidates = layer.candidates.filter(c => assets.get(c.assetId)?.usable);
        const ids = layer.candidates.slice(0, 4).map(c => c.assetId);
        if (ids.length) groups.push({ taskId: `${event.id}:${layer.id}`, events: [event], layers: [layer], ids });
      }
    }
    const musicEvents = unlocked.filter(e => e.category === "music");
    if (musicEvents.length) {
      const ids = [...new Set(musicEvents.flatMap(e => e.candidates.map(c => c.assetId)))].filter(id => assets.get(id)?.usable).slice(0, 6);
      for (const event of musicEvents) if (!event.layers?.length && event.candidates.length) event.layers = [{ id: "default", role: "music", query: event.query, offset: 0, candidates: [...event.candidates] }];
      if (ids.length) groups.unshift({ taskId: "music:continuous", events: musicEvents, layers: musicEvents.flatMap(e => e.layers || []), ids });
    }
    const wanted = [...new Set(groups.flatMap(g => g.ids))].slice(0, SFX_WORKFLOW.selection.maxAudioAssets);
    const descriptions = new Map<string, AudioDescription>();
    const auditionSamples=new Map<string,AudioSample>();
    const keys = new Map<string, string>();
    await fs.mkdir(options.cacheDir, { recursive: true });
    for (const id of wanted) {
      const a = assets.get(id)!;
      const key = createHash("sha256").update(JSON.stringify(["audio-v3-effort", this.model.model, this.model.reasoningEffort || "high", a.path, a.size, a.mtimeMs, groups.some(g => g.taskId === "music:continuous" && g.ids.includes(id))])).digest("hex");
      keys.set(id, path.join(options.cacheDir, `${key}.json`));
      try {
        const cached = descriptionSchema.parse(JSON.parse(await fs.readFile(keys.get(id)!, "utf8")));
        if (cached.assetId === id && (!this.clips.inspect || await this.clips.inspect(a, options.signal))) {
          if ((a.pitchSweep === undefined && groups.some(g => /^ui_/.test(g.events[0].type) && g.ids.includes(id))) || !a.acoustics && !groups.some(g=>g.taskId==="music:continuous"&&g.ids.includes(id))) await this.clips.sample(a, false, options.outputDir, options.signal);
          descriptions.set(id, cached); report.cachedAssets++;
        }
      } catch { /* stale or missing cache */ }
    }
    const pending = wanted.filter(id => !descriptions.has(id));
    for (let i = 0; i < pending.length; i += 3) {
      options.signal?.throwIfAborted();
      const samples: AudioSample[] = [];
      for (const id of pending.slice(i, i + 3)) {
        if(!assets.get(id)?.usable)continue;
        try { samples.push(await this.clips.sample(assets.get(id)!, groups.some(g => g.taskId === "music:continuous" && g.ids.includes(id)), options.outputDir, options.signal)); }
        catch { options.signal?.throwIfAborted();const asset=assets.get(id)!;asset.usable=false;asset.warning ||= "候选片段解码失败，本次选材已排除";report.warnings.push(`候选 ${asset.fileName} 无法制作音频片段，已排除并使用其余有效候选。`); }
      }
      if (!samples.length) continue;
      for(const sample of samples)auditionSamples.set(sample.assetId,sample);
      options.progress?.(`Gemini 分析本地候选声音：${Math.min(i + 3, pending.length)}/${pending.length}，另有 ${report.cachedAssets} 份缓存`);
      try {
        const parsed = z.object({ assets: z.array(descriptionSchema).max(10) }).parse(await this.model.describe(samples, options.signal));
        for (const sample of samples) {
          const matching = parsed.assets.filter(a => a.assetId === sample.assetId);
          if (matching.length === 1) { descriptions.set(sample.assetId, matching[0]); await writeJson(keys.get(sample.assetId)!, matching[0]); }
          else report.warnings.push(`候选 ${assets.get(sample.assetId)!.fileName} 缺少有效音频分析。`);
        }
      } catch { options.signal?.throwIfAborted();report.warnings.push(`Gemini 第 ${Math.floor(i/3)+1} 批音频分析未完成，其余批次继续处理；本批未听取的有效候选仅保留规则匹配，需复核。`); }
    }
    report.audio = [...descriptions.values()]; report.analyzedAssets = descriptions.size;
    for(const group of groups) {
      group.ids=group.ids.filter(id=>assets.get(id)?.usable);
      for(const layer of group.layers)layer.candidates=layer.candidates.filter(c=>assets.get(c.assetId)?.usable);
    }
    for(const group of groups.filter(g=>g.taskId!=="music:continuous")) {
      const keep=diverseCandidates(group.ids.map(assetId=>({asset:assets.get(assetId)!,score:1,reason:"候选音色比较"})),4).map(r=>r.asset.id);
      group.ids=keep;
      for(const layer of group.layers)layer.candidates=layer.candidates.filter(c=>keep.includes(c.assetId));
    }
    const tasks: SelectionTask[] = groups.map(g => {
      const event = g.events[0];
      const previousAssetId = options.previousPlacements?.find(p => p.enabled && p.eventId === event.id && p.layerId === g.layers[0]?.id && g.ids.includes(p.assetId))?.assetId;
      const layerQuery=g.layers.map(l=>l.query).join("；").slice(0,2000);
      return { creativeBrief:{descriptionConstraints:index.descriptionConstraints,videoDescription:index.videoDescription,soundRequirements:index.soundRequirements,style:index.style,referenceWorks:index.referenceWorks,styleProfile:index.styleProfile,styleCompatibility:compatibilityEvidence(index.styleCompatibility),referenceStyles:referenceStylesFor(event,index.referenceStyles)},taskId: g.taskId, role: g.layers[0]?.role || event.category, layerQuery, previousAssetId, event: { id: event.id, start: event.start, end: g.events.at(-1)!.end, type: event.type, category: event.category, description: event.category === "music" ? g.events.map(e => `${e.musicStage || ""}: ${e.description}`).join("；").slice(0, 2000) : event.description, query:g.events.map(e=>e.query).join("；").slice(0,2000), actor: event.actor, phase: event.phase, evidence: event.evidence, musicStage: event.musicStage, intensity: event.intensity }, candidates: g.ids.filter(id => descriptions.has(id)).map(id => ({ ...descriptions.get(id)!, fileName: assets.get(id)!.fileName,pathPreference:pathPreference(assets.get(id)!.path,index.libraryPreferences),keywordPreference:keywordPreferenceResolver(index.keywordPreferences,event)(assets.get(id)!), duration: assets.get(id)!.duration, pitchSweep: assets.get(id)!.pitchSweep, nameAdvice: assetNameAdvice(event, g.layers[0]?.role || event.category, assets.get(id)!),continuityAdvice:chargeContinuityAdvice(event,layerQuery,descriptions.get(id)!.summary,descriptions.get(id)!.tags) })) };
    });
    for (let i = 0; i < tasks.length; i += 8) {
      options.signal?.throwIfAborted();
      const batch = tasks.slice(i, i + 8).filter(t => t.candidates.length);
      let choices: z.infer<typeof choicesSchema>["choices"] = [];
      if (batch.length) {
        options.progress?.(`Gemini 结合画面选择音效与音乐：${Math.min(i + 8, tasks.length)}/${tasks.length} 层`);
        try {
          const audio:AudioSample[]=[];
          for(const id of new Set(batch.flatMap(t=>t.candidates.map(c=>c.assetId)))){
            if(!auditionSamples.has(id))auditionSamples.set(id,await this.clips.sample(assets.get(id)!,batch.some(t=>t.event.category==='music'&&t.candidates.some(c=>c.assetId===id)),options.outputDir,options.signal));
            audio.push(auditionSamples.get(id)!);
          }
          choices = choicesSchema.parse(await this.model.choose(batch, options.signal,audio)).choices;
        }
        catch { options.signal?.throwIfAborted(); report.warnings.push("Gemini 选材决策失败，本批候选保留文件名规则。" ); }
      }
      for (const task of tasks.slice(i, i + 8)) {
        const group = groups.find(g => g.taskId === task.taskId)!;
        // Captions can miss swept tones; apply measured UI constraints before trusting them.
        if (/^ui_(?:button_hide|appear|parry_prompt|select|scroll)$/.test(task.event.type)) {
          const sweeps = new Set(group.ids.filter(id => assets.get(id)?.pitchSweep));
          if (sweeps.size) {
            for (const layer of group.layers) layer.candidates = layer.candidates.filter(c => !sweeps.has(c.assetId));
            task.candidates = task.candidates.filter(c => !sweeps.has(c.assetId));
            if (task.previousAssetId && sweeps.has(task.previousAssetId)) delete task.previousAssetId;
            report.warnings.push("普通UI操作候选中的明显扫频短音已排除，避免出现与画面不符的啾声；关键预警与升档另行判断。");
          }
        }
        const matches = choices.filter(c => c.taskId === task.taskId);
        const choice = matches.length === 1 ? matches[0] : undefined;
        const strictDescription=Boolean(index.descriptionConstraints&&(index.descriptionConstraints.exclusive||index.descriptionConstraints.restrictions.length||group.events.some(e=>e.descriptionRequirementIds?.length)));
        if(strictDescription&&(!choice||choice.meetsDescription!==true||choice.assetId!==null&&!task.candidates.some(c=>c.assetId===choice.assetId))){
          for(const layer of group.layers)layer.candidates=[];
          report.rejectedLayers+=group.layers.length;
          report.warnings.push(`${task.event.start.toFixed(3)}秒 ${task.event.description}：素材未通过描述要求复核，保留缺口，不使用规则回退。`);
          report.decisions.push({taskId:task.taskId,eventIds:group.events.map(e=>e.id),assetId:null,basis:'audio-context',reason:choice?.reason||'未获得描述符合性判断'});
          continue;
        }
        if (!strictDescription && choice?.assetId === null && task.previousAssetId && task.candidates.some(c => c.assetId === task.previousAssetId && !c.hasMusic && !c.hasSpeech) && group.events[0].category !== "music") {
          const reason = "重新选材未确认更合适素材，保留上一版已用贴片；名称和音色待复核";
          for (const layer of group.layers) layer.candidates = [{ assetId: task.previousAssetId, score: 1, reason }, ...layer.candidates.filter(c => c.assetId !== task.previousAssetId)];
          report.fallbackLayers += group.layers.length;
          report.warnings.push("部分重新选材未找到替代素材，已保留上一版已用贴片，避免仅因名称差异让动作声消失。");
          report.decisions.push({ taskId: task.taskId, eventIds: group.events.map(e => e.id), assetId: task.previousAssetId, reason, basis: "fallback" });
          continue;
        }
        if (!choice || choice.assetId !== null && !task.candidates.some(c => c.assetId === choice.assetId)) {
          report.fallbackLayers += group.layers.length;
          report.decisions.push({ taskId: task.taskId, eventIds: group.events.map(e => e.id), assetId: null, basis: "fallback", reason: "未获得有效音频选材决策，保留文件名规则候选" });
          continue;
        }
        if (choice.assetId !== null && group.events[0].category !== "music") {
          const duplicate = report.decisions.some(d => d.basis === "audio-context" && d.assetId === choice.assetId && d.eventIds.includes(group.events[0].id));
          if (duplicate) { choice.assetId = null; choice.reason = "模型选中已用于该动作其他层的相同素材，省略重复叠加"; }
        }
        const preferred=choice.assetId?pathPreference(assets.get(choice.assetId)!.path,index.libraryPreferences):undefined;
        const reason = `Gemini 音频片段＋画面判断：${choice.reason}${preferred?`；路径优先 ×${preferred.weight}：${preferred.path}（相关性优先）`:""}`;
        for (const layer of group.layers) {
          if (choice.assetId === null) layer.candidates = [];
          else layer.candidates = [{ assetId: choice.assetId, score: choice.confidence * 100, reason }, ...(strictDescription?[]:layer.candidates.filter(c => c.assetId !== choice.assetId))];
        }
        if (choice.assetId === null) report.rejectedLayers += group.layers.length; else report.selectedLayers += group.layers.length;
        report.decisions.push({ taskId: task.taskId, eventIds: group.events.map(e => e.id), assetId: choice.assetId, reason, basis: "audio-context" });
      }
    }
    // Resolve successful decisions first, then keep distinct rule fallback assets.
    for (const event of unlocked.filter(e => e.category !== "music")) {
      const used = new Set<string>();
      const priority = [...event.layers || []].sort((a, b) => Number(report.decisions.some(d => d.taskId === `${event.id}:${b.id}` && d.basis === "audio-context" && d.assetId !== null)) - Number(report.decisions.some(d => d.taskId === `${event.id}:${a.id}` && d.basis === "audio-context" && d.assetId !== null)));
      for (const layer of priority) {
        layer.candidates = layer.candidates.filter(c => assets.get(c.assetId)?.usable && !used.has(c.assetId));
        if (layer.candidates.length) used.add(layer.candidates[0].assetId);
      }
    }
    for(const decision of report.decisions.filter(d=>d.basis==="fallback")) {
      const retained=groups.find(g=>g.taskId===decision.taskId)?.layers[0]?.candidates[0]?.assetId;
      decision.assetId=retained||null;
    }
    for (const event of unlocked) if (event.layers) event.candidates = event.layers.flatMap(l => l.candidates).slice(0, 8);
    for(const group of groups)for(const layer of group.layers) {
      const selectedId=layer.candidates[0]?.assetId,description=selectedId?descriptions.get(selectedId):undefined;
      if(!description)continue;
      const advice=chargeContinuityAdvice(group.events[0],layer.query,description.summary,description.tags);
      if(advice.warnings.length) {
        for(const event of group.events)event.requiresHumanReview=true;
        report.warnings.push(`${group.events[0].start.toFixed(3)}秒 ${assets.get(selectedId!)?.fileName}：${advice.warnings.join("；")}`);
      }
    }
    // A rejected shortlist is a retrieval gap, not proof the library lacks that sound.
    // One recovery pass broadens intent and hears new recordings; never force a rejected pick.
    const missing=unlocked.flatMap(event=>(event.layers||[]).filter(layer=>!layer.candidates.length).map(layer=>({event,layer,taskId:`${event.id}:${layer.id}`})));
    if(missing.length&&!options.recoveryAttempt&&this.model.discover){
      options.progress?.(`Gemini 扩展声音意图检索：${missing.length} 个缺声层`);
      const recoverySchema=z.object({recoveries:z.array(z.object({taskId:z.string(),queries:z.array(z.string().max(300)).max(6),assetIds:z.array(z.string()).max(8)})).max(100)});
      // A bounded, distributed catalogue includes opaque names; it is a discovery sample,
      // never a claim that Gemini listened to the entire library.
      const available=[...assets.values()].filter(a=>a.usable),catalogue:RecoveryAsset[]=[];
      for(let i=0;i<Math.min(240,available.length);i++){const a=available[Math.floor(i*available.length/Math.min(240,available.length))];catalogue.push({assetId:a.id,fileName:a.fileName,relativePath:a.relativePath,acoustics:a.acoustics});}
      const retryEvents:SoundEvent[]=[];
      try{
        for(let offset=0;offset<missing.length;offset+=8){
          const batch=missing.slice(offset,offset+8);
          const discovered=recoverySchema.parse(await this.model.discover(batch.map(({event,layer,taskId})=>({taskId,query:`${event.query}; ${layer.query}`,description:event.description,reason:report.decisions.find(d=>d.taskId===taskId)?.reason||'初筛无候选'})),catalogue,options.signal));
          for(const {event,layer,taskId} of batch){
            const recovery=discovered.recoveries.filter(r=>r.taskId===taskId);if(recovery.length!==1)continue;
            const tried=new Set(groups.find(g=>g.taskId===taskId)?.ids||[]);
            const ranked=recovery[0].queries.flatMap(query=>new AudioLibraryIndexer().search(index,query,24,event));
            const direct=recovery[0].assetIds.flatMap(id=>{const a=assets.get(id);return a?.usable?[{asset:a,score:1,reason:'Gemini 扩展目录候选，待听取验证'}]:[];});
            // Include model-discovered opaque filenames; a large lexical list must not
            // consume every listening slot before these recordings can be heard.
            const pool=[...direct.slice(0,2),...ranked.sort((a,b)=>b.score-a.score),...direct.slice(2)];
            const seen=new Set<string>();
            const candidates=diverseCandidates(pool.filter(r=>!tried.has(r.asset.id)&&!seen.has(r.asset.id)&&Boolean(seen.add(r.asset.id))),4).map(r=>({assetId:r.asset.id,score:r.score,reason:r.reason}));
            if(candidates.length){
              const existing=retryEvents.find(e=>e.id===event.id);
              if(existing)existing.layers!.push({...layer,candidates});
              else retryEvents.push({...event,layers:[{...layer,candidates}],candidates});
            }
          }
        }
        if(retryEvents.length){
          const retry=await this.select(retryEvents,index,{...options,recoveryAttempt:true,outputDir:path.join(options.outputDir,'retrieval-recovery')});
          const taskIds=new Set(retryEvents.flatMap(e=>e.layers!.map(l=>`${e.id}:${l.id}`)));
          for(const taskId of taskIds){
            const old=report.decisions.find(d=>d.taskId===taskId),decision=retry.decisions.find(d=>d.taskId===taskId);
            if(old){if(old.basis==='fallback')report.fallbackLayers--;else if(old.assetId===null)report.rejectedLayers--;else report.selectedLayers--;}
            report.decisions=report.decisions.filter(d=>d.taskId!==taskId);
            if(decision)report.decisions.push({...decision,reason:`扩展检索后试听：${decision.reason}`});
          }
          for(const e of retryEvents)for(const recovered of e.layers!){const original=unlocked.find(v=>v.id===e.id)!,layer=original.layers!.find(l=>l.id===recovered.id)!;layer.candidates=recovered.candidates;}
          report.selectedLayers+=retry.selectedLayers;report.rejectedLayers+=retry.rejectedLayers;report.fallbackLayers+=retry.fallbackLayers;
          report.cachedAssets+=retry.cachedAssets;report.analyzedAssets+=retry.analyzedAssets;report.audio=[...new Map([...report.audio,...retry.audio].map(a=>[a.assetId,a])).values()];report.warnings.push(...retry.warnings);
        }
      }catch(error){options.signal?.throwIfAborted();report.warnings.push(`扩展检索未完成：${error instanceof Error?error.message:'模型请求失败'}；缺项保留，不能视为已配声。`);}
    }
    for(const event of unlocked){
      const used=new Set<string>();
      for(const layer of event.layers||[]){layer.candidates=layer.candidates.filter(c=>!used.has(c.assetId));if(layer.candidates[0])used.add(layer.candidates[0].assetId);}
      event.candidates=(event.layers||[]).flatMap(l=>l.candidates).slice(0,8);
    }
    const remaining=unlocked.flatMap(event=>(event.layers||[]).filter(l=>!l.candidates.length).map(l=>`${event.start.toFixed(3)}秒 ${event.description}（${l.query}）`));
    report.warnings=report.warnings.filter(w=>!unlocked.some(e=>(e.layers||[]).every(l=>l.candidates.length)&&w.startsWith(`${e.start.toFixed(3)}秒 ${e.description}：素材未通过描述要求复核`)));
    for(const {event,taskId} of missing)if(!report.decisions.some(d=>d.taskId===taskId)){
      report.rejectedLayers++;report.decisions.push({taskId,eventIds:[event.id],assetId:null,basis:'audio-context',reason:'初筛及扩展检索均未获得可验证候选，声音尚未匹配'});
    }
    if(remaining.length)report.warnings.push(`声音尚未匹配，需补充素材或重试：${remaining.join('；')}`);
    report.status = !groups.length&&!missing.length ? "skipped" : remaining.length ? "partial" : report.fallbackLayers === 0 ? "complete" : report.selectedLayers + report.rejectedLayers > 0 ? "partial" : "fallback";
    report.warnings = [...new Set(report.warnings)];
    if (wanted.length < new Set(groups.flatMap(g => g.ids)).size) report.warnings.push("候选音频分析达到160份上限，未分析的候选保留规则匹配。");
    report.elapsedMs = Date.now() - selectionStarted;
    await writeJson(path.join(options.outputDir, "selection-report.json"), report);
    return report;
  }
}
