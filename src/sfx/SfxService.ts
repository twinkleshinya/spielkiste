import {referenceWorksFrom} from './CreativeBrief.js';
import {StyleResearcher} from "./StyleResearch.js";
import {creativeContext,type CreativeBrief} from "./CreativeBrief.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { CreateRunSchema, EventSchema, ExclusionFields, IndexSchema, KeywordPreferencesSchema, PlacementSchema, SfxError, SfxRun, round, validateTimeline,type KeywordPreference } from "./models.js";
import { SfxRunStore, exportTimeline, writeJson } from "./SfxRunStore.js";
import { AudioLibraryIndexer } from "./AudioLibraryIndexer.js";
import { SfxVideoAnalyzer } from "./SfxVideoAnalyzer.js";
import { MediaTools, type MediaSource } from "./MediaTools.js";
import { OllamaVisionProvider } from "./OllamaVisionProvider.js";
import { GeminiVideoProvider } from "./GeminiVideoProvider.js";
import { CcSwitchVisionProvider } from "./CcSwitchVisionProvider.js";
import { createPlacements } from "./PlacementEngine.js";
import { SfxRenderer } from "./SfxRenderer.js";
import { probeAudio } from "./AudioLibraryIndexer.js";
import { hydratePlacements } from "./HydratePlacements.js";
import { buildEventTimeline } from "./EventTimelineBuilder.js";
import { planAllEventCandidates, repairEventCandidates } from "./CandidatePlanner.js";
import { assetNameAdvice } from "./AssetIntent.js";
import { planAutoMix } from "./AutoMix.js";
import { usagePhase, withModelUsage } from "./ModelUsage.js";
import { selectReviewEvents } from "./SelectionPolicy.js";
import { prepareCandidates } from "./PrepareCandidates.js";
import { GeminiAudioSelector } from "./GeminiAudioSelector.js";
import { CcSwitchAudioProvider } from "./CcSwitchAudioProvider.js";
import { AudioCandidateClips } from "./AudioCandidateClips.js";
import { compareRuns, type SfxComparison } from "./SfxComparison.js";
import { prepareDiverseCandidates, measureShortlist } from "./CandidatePreparation.js";
import { diverseCandidates } from "./CandidateDiversity.js";
import { reviewSourceEdits } from "./GeminiSourceEditor.js";
import { edgeFades } from "./ClipEdit.js";
import { SFX_WORKFLOW, workflowSnapshot } from "./WorkflowPolicy.js";
import {buildWorkflowReport} from "./WorkflowReport.js";
import {PreservedSounds} from "./PreservedSounds.js";
import {additionalLibraryRoots,normalizeExcludedLibraryPaths,normalizeKeywordPreferences,normalizeLibraryPreferences} from "./LibraryPreferences.js";
import {assetExclusionReasonResolver,normalizeExcludedKeywords,type AssetExclusions} from "./AssetExclusions.js";
import { applyEventTiming, DescribedEventResultSchema, DescribedEventsResultSchema, EventTimingResultSchema, type EventTimingProvider } from "./EventTiming.js";
import { SfxProjectStore } from "./SfxProjectStore.js";
import { SfxGitStore } from "./SfxGitStore.js";
import { ProjectGit } from "./ProjectGit.js";
import { ReaperExporter } from "./ReaperExporter.js";
import { AiConfigService, type AiReasoningEffort } from "./SfxAiConfig.js";

function creativeFields(input:CreativeBrief):CreativeBrief{return {videoDescription:input.videoDescription,soundRequirements:input.soundRequirements,style:input.style,referenceWorks:input.referenceWorks,styleProfile:input.styleProfile,styleCompatibility:input.styleCompatibility,referenceStyles:input.referenceStyles};}

type PreviewRenderer = { renderPreview(run: SfxRun, outputDir: string, options?: { preserveSavedMix?: boolean; preserveSourceEdits?: boolean; videoSource?: string; preservePlacementIds?: ReadonlySet<string> }): Promise<{ video: string; audio: string; revision: number }> };

const EditSchema = z.object({ revision: z.number().int().nonnegative(), events: z.array(EventSchema).max(1000), placements: z.array(PlacementSchema).max(1000), originalGainDb: z.number().finite().min(-60).max(6), originalMuted:z.boolean().optional(), musicEnabled: z.boolean().optional(),keywordPreferences:KeywordPreferencesSchema.optional(),...ExclusionFields });
const QuickEditSchema = z.object({revision:z.number().int().nonnegative(),target:z.enum(["event","placement"]),targetId:z.string().min(1),action:z.enum(["mute","unmute","delete"])});
const ReaperExportSchema = z.object({ templatePath: z.string().trim().min(1).optional(), outputPath: z.string().trim().min(1).optional(), channelMode: z.enum(["preserve", "mono", "stereo"]).default("preserve"),audioFormat:z.enum(["preserve","wav16","wav24","wav32f","wav64f"]).default("preserve"),sampleRate:z.union([z.literal(0),z.literal(44100),z.literal(48000),z.literal(88200),z.literal(96000),z.literal(192000)]).default(0),dither:z.enum(["auto","on","off"]).default("auto"),noiseShaping:z.boolean().default(false) });
const ANALYSIS_TIMEOUT_MS = 30 * 60 * 1000;
const INDEX_TIMEOUT_MS = 10 * 60 * 1000;
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(new SfxError(message, 408)), timeoutMs);
    promise.then(value => { if (timer) clearTimeout(timer); resolve(value); }, error => { if (timer) clearTimeout(timer); reject(error); });
  });
}

async function assertAutomaticAiReady(parsed: z.infer<typeof CreateRunSchema>): Promise<{ model: string; reasoningEffort?: AiReasoningEffort } | undefined> {
  if (parsed.analysisMode !== "auto") return undefined;

  // reference-v6 always uses the local CC Switch-compatible Gemini gateway.
  // A direct Google Gemini key is only a valid provider for an explicitly
  // custom automatic workflow, so it must not hide a missing CC Switch config
  // for the standard workflow.
  const directGemini = process.env.SFX_USE_GEMINI === "1" && Boolean(process.env.GEMINI_API_KEY?.trim());
  const requiresCcSwitch = parsed.workflowPreset === "reference-v6" || !directGemini;
  if (!requiresCcSwitch) return {model:process.env.SFX_GEMINI_MODEL?.trim() || "gemini-2.5-flash"};

  const service = new AiConfigService();
  const snapshot = await service.snapshot();
  if (!snapshot.ready) throw new SfxError(`Gemini AI 连接未就绪：${snapshot.error || "请先打开右上角 AI 连接设置并测试连接"}`, 503);
  return { model: snapshot.model, reasoningEffort: snapshot.reasoningEffort || "high" };
}

export class SfxService {
  public store: SfxRunStore;
  public styles: StyleResearcher;
  public projects: SfxProjectStore;
  public projectGit: ProjectGit;
  private pending = new Map<string, Promise<void>>();
  private active = new Map<string, SfxRun>();
  private locks = new Set<string>();
  private failedWrites = new Map<string, SfxRun>();
  constructor(
    public root = path.resolve(".output/sfx"),
    private selectorFactory = (model?:string, effort?:AiReasoningEffort) => new GeminiAudioSelector(new CcSwitchAudioProvider(model, effort), new AudioCandidateClips()),
    private timingFactory = (model?:string, effort?:AiReasoningEffort): EventTimingProvider => new CcSwitchVisionProvider(model, effort),
    private mediaFactory = (): MediaSource => new MediaTools(),
    private rendererFactory = (): PreviewRenderer => new SfxRenderer()
  ) {
    this.styles = new StyleResearcher(path.join(root,"style-profiles"));
    this.store = new SfxRunStore(path.join(root, "runs"));
    this.projectGit = new ProjectGit(path.join(root,'project-git'));
    const metadataRoot = path.resolve(root) === path.resolve(".output/sfx") ? path.resolve("projects") : path.join(root, "projects");
    this.projects = new SfxProjectStore(metadataRoot, this.store, new SfxGitStore(path.resolve(".")));
  }
  private async saveProjectVersion(run: SfxRun, operation = run.workflow?.operation || "save") {
    run.projectId = this.projects.deriveProjectId(run);
    await this.store.save(run);
    const result = await this.projects.registerRun(run, operation);
    return result;
  }
  private runIndex(run:SfxRun) {return {...creativeFields(run),version:1 as const,root:run.libraryPath,generatedAt:run.createdAt,assets:run.assets,warnings:[],musicLibraryConfigured:Boolean(run.musicLibraryPath && path.resolve(run.musicLibraryPath)!==path.resolve(run.libraryPath)),libraryPreferences:run.libraryPreferences,keywordPreferences:run.keywordPreferences,excludedLibraryPaths:run.excludedLibraryPaths,excludedKeywords:run.excludedKeywords};}
  private audioProvider(run:SfxRun) {return new CcSwitchAudioProvider(run.workflow?.requestedModel, run.workflow?.reasoningEffort || "high");}
  async status(id: string) {
    const run = this.failedWrites.get(id) || this.active.get(id) || await this.readRun(id);
    return { id: run.id, status: run.status, progress: run.progress, error: run.error, revision: run.revision };
  }
  async compare(localId?: string, geminiId?: string): Promise<SfxComparison> {
    const ids = localId && geminiId ? { localId, geminiId } : await this.defaultComparisonIds();
    const [local, gemini] = await Promise.all([this.readRun(ids.localId), this.readRun(ids.geminiId)]);
    return compareRuns(local, gemini);
  }
  private async defaultComparisonIds() {
    const summaries = await this.store.list();
    const runs = await Promise.all(summaries.map(async summary => {
      try { return await this.readRun(summary.id); } catch { return undefined; }
    }));
    const gemini = runs.filter((run): run is SfxRun => Boolean(run?.selectionReport?.model)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!gemini) throw new SfxError("没有找到带 Gemini 音频选材报告的项目，请先生成一个 Gemini 版本。", 404);
    const sameVideoLocal = runs.filter((run): run is SfxRun => Boolean(run && !run.selectionReport && pathEqualForComparison(run.videoPath, gemini.videoPath))).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const local = sameVideoLocal || runs.filter((run): run is SfxRun => Boolean(run && !run.selectionReport)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!local) throw new SfxError("没有找到本地规则选材版本，请先生成一个关闭 Gemini 音频选材的项目。", 404);
    return { localId: local.id, geminiId: gemini.id };
  }
  async readRun(id: string) {
    if (this.failedWrites.has(id)) return this.failedWrites.get(id)!;
    if (this.active.has(id)) return structuredClone(this.active.get(id)!);
    const run = await this.store.readRun(id);
    // Legacy runs predate stable project IDs. Derive the ID on read so the
    // current editor can immediately show project actions and version history;
    // the next saved version persists it in the run snapshot.
    if (!run.projectId) run.projectId = this.projects.deriveProjectId(run);
    if (["analyzing", "rendering"].includes(run.status) && !this.pending.has(id)) {
      run.status = run.duration > 0 ? "ready" : "failed"; run.progress = "上次任务被中断，可重试";
      run.error = "本地服务重启中断了处理；请重新分析或渲染。"; await this.store.save(run);
    }
    return run;
  }
  async checkStyleDirection(body:unknown,requested?:{model:string;reasoningEffort?:AiReasoningEffort},refresh=false):Promise<CreativeBrief>{
    const input=z.object({style:z.string().trim().max(120).optional(),referenceWorks:z.array(z.string().trim().min(1).max(120)).max(12).optional(),soundRequirements:z.string().trim().max(4000).optional()}).parse(body);
    if(!input.style&&!input.referenceWorks?.length)return {};
    const config=requested||await new AiConfigService().resolve(),effort=config.reasoningEffort||'high';
    const styleProfile=input.style?await this.styles.research(input.style,config.model,effort,undefined,refresh):undefined;
    const referenceStyles=[];
    for(const name of input.referenceWorks||[])referenceStyles.push({keyword:name,profile:await this.styles.research(name,config.model,effort,undefined,refresh,'work')});
    const brief:CreativeBrief={...input,styleProfile,referenceStyles};
    const compatibility=await this.styles.checkCompatibility(brief,config.model,effort);
    const unresolved=compatibility.conflicts.filter(c=>!c.resolvedByRequirements);
    if(unresolved.length){
      const aspects={timbre:'音色',material:'材质',dynamics:'动态',space:'空间',music:'音乐',rhythm:'节奏',other:'声音方向'};
      const details=unresolved.map(c=>`「${c.left}」与「${c.right}」的${aspects[c.aspect]}存在冲突`).join('；');
      throw Object.assign(new SfxError(`${details}。请选择一种混合方式，或补充自定义声音要求后重新检查。`,409),{code:'STYLE_CONFLICT',conflicts:unresolved,suggestions:compatibility.suggestions});
    }
    return {...brief,styleCompatibility:compatibility};
  }
  async create(input: unknown) {
    const parsed = CreateRunSchema.parse(input);
    parsed.projectId = parsed.projectId || randomUUID();
    const video = path.resolve(parsed.videoPath); const library = path.resolve(parsed.libraryPath);
    if (!/\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(video)) throw new SfxError("请选择支持的视频文件");
    try { if (!(await fs.stat(video)).isFile() || !(await fs.stat(library)).isDirectory()) throw new Error(); }
    catch { throw new SfxError("视频文件或音效文件夹不存在"); }
    const musicLibrary = parsed.musicLibraryPath ? path.resolve(parsed.musicLibraryPath) : undefined;
    if (musicLibrary) { try { if (!(await fs.stat(musicLibrary)).isDirectory()) throw new Error(); } catch { throw new SfxError("背景音乐文件夹不存在"); } }
    parsed.libraryPreferences=normalizeLibraryPreferences(parsed.libraryPreferences);
    parsed.keywordPreferences=normalizeKeywordPreferences(parsed.keywordPreferences);
    parsed.excludedLibraryPaths=normalizeExcludedLibraryPaths(parsed.excludedLibraryPaths);
    parsed.excludedKeywords=normalizeExcludedKeywords(parsed.excludedKeywords);
    for(const preference of parsed.libraryPreferences) {
      try {if(!(await fs.stat(preference.path)).isDirectory())throw new Error();}
      catch {throw new SfxError(`优先素材目录不存在或无法读取：${preference.path}`);}
    }
    if(parsed.reusePreserved) {
      const preserved=new PreservedSounds(path.join(this.root,"preserved"));
      const record=await preserved.find({...parsed,videoPath:video,libraryPath:library,musicLibraryPath:musicLibrary});
      if(record) {
        const existing=await this.readRun(record.runId);
        let selectedModel:string|undefined, selectedEffort:AiReasoningEffort|undefined;
        if(parsed.analysisMode==="auto") {
          try {const config=await new AiConfigService().resolve();selectedModel=config.model;selectedEffort=config.reasoningEffort || "high";}catch { /* accepted previews remain accessible offline */ }
        }
        const existingModel=existing.analysisReport?.model||existing.workflow?.requestedModel;
        if(!selectedModel||(selectedModel===existingModel && selectedEffort===(existing.workflow?.reasoningEffort || "high"))) {
          await preserved.verify(record,existing);return {runId:existing.id,reused:true};
        }
      }
    }
    // Fail before creating a run or scanning a large library. A preserved
    // accepted version above remains usable without a live model connection.
    const requestedModel = await assertAutomaticAiReady(parsed);
    const direction=await this.checkStyleDirection(parsed,requestedModel);
    const run = await this.store.createRun({ ...parsed, videoPath: video, libraryPath: library });
    Object.assign(run,{styleProfile:direction.styleProfile,referenceStyles:direction.referenceStyles,styleCompatibility:direction.styleCompatibility});
    if (parsed.parentRunId) {
      run.parentRunId = parsed.parentRunId;
      if (run.workflow) {
        run.workflow.operation = "reanalyze";
        run.workflow.timing = "fresh";
        run.workflow.selection = "fresh";
        run.workflow.source = "fresh";
        run.workflow.options = { ...run.workflow.options, reanalysisMode: parsed.reanalysisMode || "brief", parentRunId: parsed.parentRunId };
      }
      await this.store.save(run);
    }
    if (requestedModel && run.workflow) {
      run.workflow.requestedModel = requestedModel.model;
      run.workflow.reasoningEffort = requestedModel.reasoningEffort || "high";
      await this.store.save(run);
    }
    const controller = new AbortController();
    const taskTimer = setTimeout(() => controller.abort(new Error("分析超过 30 分钟，请查看当前处理阶段后重试。")), ANALYSIS_TIMEOUT_MS);
    this.launch(run, async () => { try { await withTimeout((async () => {
      run.progress = "建立或更新本地音效索引"; await this.store.save(run);
      const scanController = new AbortController();
      const scanSignal = AbortSignal.any([controller.signal, scanController.signal]);
      const scanTimer = setTimeout(() => scanController.abort(new Error("文件扫描超过 10 分钟，已取消扫描；其他任务可以继续。")), INDEX_TIMEOUT_MS);
      let lastProgress = 0;
      let index;
      try {
        const scan=async(directory:string)=>{
          const key=createHash("sha256").update(directory).digest("hex"),file=path.join(this.root,"indexes",`${key}.json`);
          let previous;
          try {previous=IndexSchema.parse(JSON.parse(await fs.readFile(file,"utf8")));}catch { /* first run or invalid cache */ }
          const result=await new AudioLibraryIndexer().indexDirectory(directory,previous,count=>{
            if(Date.now()-lastProgress>300){lastProgress=Date.now();run.progress=`建立文件索引：${directory} · 已扫描 ${count.toLocaleString()} 个音频（不逐条解码）`;}
          },scanSignal);
          scanSignal.throwIfAborted();await writeJson(file,result);return result;
        };
        index=await scan(library);
        for(const directory of additionalLibraryRoots(library,run.libraryPreferences)) {
          run.progress=`索引优先素材目录：${directory}`;
          const extra=await scan(directory),existing=new Set(index.assets.map(a=>a.id));
          index.assets.push(...extra.assets.filter(a=>!existing.has(a.id)).map(a=>({...a,relativePath:`[优先目录 ${path.basename(directory)}] ${a.relativePath}`})));
          index.warnings.push(...extra.warnings);
        }
        index.libraryPreferences=run.libraryPreferences;
        index.keywordPreferences=run.keywordPreferences;
        index.excludedLibraryPaths=run.excludedLibraryPaths;
        index.excludedKeywords=run.excludedKeywords;
      } finally { clearTimeout(scanTimer); }
      controller.signal.throwIfAborted();
      index.musicLibraryConfigured = Boolean(musicLibrary && musicLibrary !== library && parsed.musicEnabled);
      run.assets = index.assets; run.warnings = index.warnings;
      if (musicLibrary && musicLibrary !== library && parsed.musicEnabled) {
        run.progress = "索引单独选择的背景音乐目录";
        const musicIndex = await new AudioLibraryIndexer().indexDirectory(musicLibrary, undefined, undefined, controller.signal);
        const existing = new Set(index.assets.map(a => a.id));
        index.assets.push(...musicIndex.assets.filter(a => !existing.has(a.id)).map(a => ({ ...a, musicOnly: true, relativePath: `[music] ${a.relativePath}` })));
        index.warnings.push(...musicIndex.warnings);
      }
      if (!index.assets.some(a => a.usable)) run.warnings.push("素材库没有可用音效，可先编辑事件，再补充素材重新分析。");
      Object.assign(index,creativeFields(run));
      run.progress = parsed.analysisMode === "scene" ? "检测镜头边界并生成复核清单" : "分析画面动作、物体、环境和声音意图";
      await this.store.save(run);
      const useVision = parsed.analysisMode === "auto" || parsed.analysisMode === "ollama";
      if (parsed.analysisMode === "auto" && process.env.SFX_USE_CCSWITCH === "0" && (parsed.workflowPreset==="reference-v6" || !(process.env.SFX_USE_GEMINI === "1" && process.env.GEMINI_API_KEY?.trim()))) throw new SfxError("自动点位分析必须连接 Gemini。标准流程使用本机 CC Switch 专用配置，请检查连接。");
      const provider = !useVision ? undefined
        : parsed.analysisMode === "ollama" ? new OllamaVisionProvider()
        : parsed.workflowPreset==="reference-v6" ? new CcSwitchVisionProvider(run.workflow?.requestedModel, run.workflow?.reasoningEffort || "high")
        : process.env.SFX_USE_GEMINI === "1" && process.env.GEMINI_API_KEY?.trim() ? new GeminiVideoProvider()
        : process.env.SFX_USE_CCSWITCH !== "0" ? new CcSwitchVisionProvider(run.workflow?.requestedModel, run.workflow?.reasoningEffort || "high")
        : new OllamaVisionProvider();
      if (parsed.analysisMode === "auto" && provider?.kind === "gemini") run.progress = "上传视频到 Gemini，分析动作时间点和声音事件";
      if (parsed.analysisMode === "auto" && provider?.kind === "ccswitch") run.progress = "读取 CC Switch 本地配置，分析关键帧动作和声音事件";
      const result = await usagePhase("video-timing", () => new SfxVideoAnalyzer(new MediaTools(), provider).analyze(video, this.store.directory(run.id), { ...creativeFields(run),signal: controller.signal, musicEnabled: parsed.musicEnabled, progress: message => { run.progress = message; } }));
      if (parsed.analysisMode === "auto" && !["gemini", "ccswitch"].includes(result.mode)) throw new SfxError(`Gemini 未完成动作点位分析，请检查连接后重试。${result.warnings.slice(0, 2).join("；")}`);
      controller.signal.throwIfAborted();
      run.duration = result.duration; run.scenes = result.scenes; run.events = result.events.length ? result.events : buildEventTimeline({ duration: result.duration, scenes: result.scenes }, { includeReviewEvents: true, previous: run.events }); run.analysisMode = result.mode; run.warnings.push(...result.warnings);
      run.analysisReport = result.report; run.musicEnabled = parsed.musicEnabled; run.musicLibraryPath = musicLibrary;
      if (!parsed.musicEnabled) run.events = run.events.filter(e => e.category !== "music");
      if (parsed.analysisMode === "scene" || result.mode === "scene") run.events = buildEventTimeline({ duration: result.duration, scenes: result.scenes }, { includeReviewEvents: true, previous: run.events });
      planAllEventCandidates(run.events, index);
      await prepareCandidates(run.events, index, message => { run.progress = message; }, controller.signal);
      await usagePhase("candidate-diversity",()=>prepareDiverseCandidates(run.events,index,this.store.directory(run.id),controller.signal,message=>{run.progress=message;}));
      if (parsed.aiSelection && parsed.analysisMode === "auto") await this.selectAudio(run, controller.signal);
      const uncovered = run.events.filter(event => !["ambience", "music"].includes(event.category) && !(event.layers || []).some(layer => layer.candidates.length));
      if (uncovered.length) run.warnings.push(`有 ${uncovered.length} 个动作暂未找到同类素材，已保留事件供复核：${uncovered.slice(0, 8).map(e => e.description).join("；")}`);
      const musicEvents = run.events.filter(e => e.category === "music");
      if (musicEvents.some(e => !e.candidates.length)) run.warnings.push("背景音乐点位已列出，但未找到可用音乐素材；请选择音乐目录或在音乐点位搜索替换。");
      run.warnings.push(`已列动作 ${run.events.filter(e => !["ambience", "music"].includes(e.category)).length} 个；环境 ${run.events.filter(e => e.category === "ambience").length} 段；音乐 ${musicEvents.length} 段；缺少动作素材 ${uncovered.length} 个。事件数量不等于识别准确率，请复核试听。`);
      if (result.report) run.warnings.push(result.report.timingNote);
      run.placements = createPlacements(run.events, run.assets, run.duration,run);
      if(parsed.analysisMode==="auto") {
        const reviewed = await usagePhase("audio-source-edit",()=>reviewSourceEdits(run,this.audioProvider(run),new AudioCandidateClips(),this.store.directory(run.id),controller.signal));
        run.warnings.push(...reviewed.warnings);
      }
      await hydratePlacements(run);
      if (parsed.autoRender && run.placements.length) {
        run.progress = "已识别动作和声音层，正在生成带音效视频";
        run.render = await usagePhase("render-and-mix", () => new SfxRenderer().renderPreview(run, this.store.directory(run.id)));
      }
      run.status = "ready"; run.progress = "分析完成，请复核事件与贴片"; await exportTimeline(run, this.store.directory(run.id)); await this.saveProjectVersion(run, "create");
    })(), ANALYSIS_TIMEOUT_MS, "视频分析超过 30 分钟，已停止。请检查当前处理阶段。"); } finally { controller.abort(); clearTimeout(taskTimer); } });
    return { runId: run.id };
  }

  async reanalyze(id: string, body: unknown) {
    if (this.pending.has(id) || this.locks.has(id)) throw new SfxError("任务处理中，请稍后重新分析", 409);
    const source = await this.readRun(id);
    if (source.status !== "ready") throw new SfxError("请等待当前项目完成后再重新分析", 409);
    const input = z.object({
      mode: z.enum(["visual", "brief"]),
      videoDescription: z.string().trim().max(4000).optional(),
      soundRequirements: z.string().trim().max(4000).optional(),
      style: z.string().trim().max(120).optional(),
      referenceWorks:z.array(z.string().trim().min(1).max(120)).max(12).optional(),
      keywordPreferences: KeywordPreferencesSchema.optional()
    }).parse(body);
    const cleanName = source.name.replace(/ · (?:重新分析|编辑|定位|补声|自动混音|Gemini选材)(?:副本|\d+)?$/, "").slice(0, 100);
    const result = await this.create({
      projectId: source.projectId || this.projects.deriveProjectId(source),
      parentRunId: source.id,
      reanalysisMode: input.mode,
      name: `${cleanName} · 重新分析`,
      videoPath: source.videoPath,
      libraryPath: source.libraryPath,
      musicLibraryPath: source.musicLibraryPath,
      musicEnabled: source.musicEnabled !== false,
      aiSelection: true,
      autoMix: source.autoMix !== false,
      originalGainDb: source.originalGainDb,
      workflowPreset: source.workflow?.presetId || "reference-v6",
      selectionScope: source.selectionScope || "selective",
      libraryPreferences: source.libraryPreferences,
      keywordPreferences: input.keywordPreferences ?? source.keywordPreferences,
      excludedLibraryPaths: source.excludedLibraryPaths,
      excludedKeywords: source.excludedKeywords,
      videoDescription: input.mode === "visual" ? undefined : input.videoDescription,
      soundRequirements: input.soundRequirements,
      style: input.style,
      referenceWorks:input.referenceWorks??referenceWorksFrom(source),
      reusePreserved: false
    });
    return result;
  }
  async preserve(id:string,body:unknown) {
    if(this.pending.has(id)||this.locks.has(id))throw new SfxError("任务处理中",409);
    this.locks.add(id);
    try {
      const {revision}=z.object({revision:z.number().int().nonnegative()}).parse(body);
      const run=await this.readRun(id);
      if(revision!==run.revision)throw new SfxError("任务已更新，请重新打开后保留音效",409);
      return await new PreservedSounds(path.join(this.root,"preserved")).preserve(run);
    }finally {this.locks.delete(id);}
  }

  async renameProject(projectId: string, name: string) {
    return this.projects.rename(projectId, name);
  }

  async syncProject(projectId: string, includeMedia = false) {
    const project=await this.projects.project(projectId);
    const versions=await this.projects.listVersions(projectId);
    const runs=[];for(const version of versions)runs.push(await this.readRun(version.runId));
    const git=await this.projectGit.publish(project,runs,includeMedia);
    return {project:await this.projects.recordGitResult(projectId,git),git};
  }

  async importGitProject(projectId:string) {
    if((await this.projects.listProjects()).some(item=>item.projectId===projectId))throw new SfxError('本机已有同名 ID 项目，请先另存为，避免覆盖本机历史。',409);
    const downloaded=await this.projectGit.download(projectId,path.join(this.root,'imported-projects'));
    for(const run of downloaded.runs){try{await this.store.readRun(run.id);}catch(error){if(error instanceof SfxError&&error.status===404)continue;throw error;}throw new SfxError('本机已有相同版本 ID，已停止导入以保护现有项目。',409);}
    for(const run of downloaded.runs){await this.store.save(run);await this.projects.registerRun(run);}
    await this.projects.rename(projectId,downloaded.name);
    return {runId:downloaded.currentRunId,projectId};
  }

  async saveProjectAs(projectId: string, name: string) {
    const project = await this.projects.project(projectId);
    const source = await this.readRun(project.currentRunId);
    const newProjectId = randomUUID();
    const child = await this.store.createRun({
      projectId: newProjectId,
      name: name.trim(),
      videoPath: source.videoPath,
      libraryPath: source.libraryPath,
      libraryPreferences: source.libraryPreferences,
      keywordPreferences: source.keywordPreferences,
      excludedLibraryPaths: source.excludedLibraryPaths,
      excludedKeywords: source.excludedKeywords,
      workflowPreset: source.workflow?.presetId || "custom",
      musicLibraryPath: source.musicLibraryPath,
      musicEnabled: source.musicEnabled !== false,
      aiSelection: source.aiSelection === true,
      autoMix: source.autoMix !== false,
      originalGainDb: source.originalGainDb,
      selectionScope: source.selectionScope || "selective",
      reusePreserved: false
    });
    Object.assign(child, structuredClone(source), {
      id: child.id,
      projectId: newProjectId,
      name: name.trim(),
      createdAt: child.createdAt,
      revision: 0,
      parentRunId: undefined,
      status: source.status === "failed" ? "ready" : source.status,
      progress: "已另存为新项目",
      error: undefined
    });
    if (child.render) child.render = { ...child.render, revision: 0 };
    // The preview and source paths are intentionally reused locally. Git stores
    // only the project metadata; large media remains on the originating machine.
    await exportTimeline(child, this.store.directory(child.id));
    const result = await this.saveProjectVersion(child, "save-as");
    return { runId: child.id, projectId: newProjectId, project: await this.projects.project(newProjectId), git: result.git };
  }

  async restoreProjectVersion(projectId: string, targetRunId: string) {
    const project = await this.projects.project(projectId);
    const current = await this.readRun(project.currentRunId);
    const target = await this.readRun(targetRunId);
    if ((target.projectId || this.projects.deriveProjectId(target)) !== projectId) throw new SfxError("目标版本不属于当前项目", 409);
    const child = await this.store.createRun({
      projectId,
      name: `${project.name} · 回退${current.revision + 1}`.slice(0, 120),
      videoPath: target.videoPath,
      libraryPath: target.libraryPath,
      libraryPreferences: target.libraryPreferences,
      keywordPreferences: target.keywordPreferences,
      excludedLibraryPaths: target.excludedLibraryPaths,
      excludedKeywords: target.excludedKeywords,
      workflowPreset: target.workflow?.presetId || "custom",
      musicLibraryPath: target.musicLibraryPath,
      musicEnabled: target.musicEnabled !== false,
      aiSelection: target.aiSelection === true,
      autoMix: target.autoMix !== false,
      originalGainDb: target.originalGainDb,
      selectionScope: target.selectionScope || "selective",
      reusePreserved: false
    });
    Object.assign(child, structuredClone(target), {
      id: child.id,
      projectId,
      name: `${project.name} · 回退${current.revision + 1}`.slice(0, 120),
      createdAt: child.createdAt,
      revision: current.revision + 1,
      parentRunId: current.id,
      status: "ready",
      progress: `已从版本 ${target.revision} 回退`,
      error: undefined,
      render: target.render ? { ...target.render, revision: current.revision + 1 } : undefined
    });
    child.workflow = structuredClone(target.workflow || workflowSnapshot("custom", {
      analysisMode: target.analysisMode,
      selectionScope: target.selectionScope || "selective",
      musicEnabled: target.musicEnabled !== false,
      aiSelection: target.aiSelection === true,
      autoMix: target.autoMix === true,
      originalGainDb: target.originalGainDb
    }));
    Object.assign(child.workflow, { operation: "restore", timing: "reused", selection: "reused", source: "reused" });
    child.workflow.options = { ...child.workflow.options, restoredFromRunId: target.id };
    await exportTimeline(child, this.store.directory(child.id));
    const result = await this.saveProjectVersion(child, "restore");
    return { runId: child.id, projectId, git: result.git };
  }
  private async selectAudio(run: SfxRun, signal?: AbortSignal) {
    run.aiSelection = true;
    const scope = run.selectionScope || "full";
    const reviewed = selectReviewEvents(run.events, scope);
    await usagePhase("candidate-diversity",()=>prepareDiverseCandidates(reviewed,this.runIndex(run),this.store.directory(run.id),signal,message=>{run.progress=message;}));
    run.selectionReport = await usagePhase("audio-selection", () => this.selectorFactory(run.workflow?.requestedModel, run.workflow?.reasoningEffort || "high").select(reviewed,this.runIndex(run), { outputDir: this.store.directory(run.id), cacheDir: path.join(this.root, "audio-selection-cache"), signal, previousPlacements: run.placements, progress: message => { run.progress = message; } }));
    run.selectionReport.scope = scope;
    const assetMap=new Map(run.assets.map(a=>[a.id,a]));
    for(const event of run.events.filter(e=>!e.locked)) {
      for(const layer of event.layers||[]) {
        const distinct=diverseCandidates(layer.candidates.flatMap(c=>{const asset=assetMap.get(c.assetId);return asset?[{asset,...c}]:[];}),SFX_WORKFLOW.candidates.alternatives);
        layer.candidates=distinct.map(({asset,score,reason})=>({assetId:asset.id,score,reason}));
      }
      event.candidates=(event.layers||[]).flatMap(l=>l.candidates).slice(0,8);
    }
    const reviewedIds = new Set(reviewed.map(e => e.id));
    run.selectionReport.ruleRetainedLayers = run.events.filter(e => !e.locked && !reviewedIds.has(e.id)).reduce((sum, e) => sum + (e.layers?.length || 1), 0);
    run.warnings.push(...run.selectionReport.warnings);
    const r = run.selectionReport;
    run.warnings.push(`Gemini 音频选材：分析 ${r.analyzedAssets} 份素材片段（缓存 ${r.cachedAssets}），选用 ${r.selectedLayers} 层，拒选 ${r.rejectedLayers} 层，规则回退 ${r.fallbackLayers} 层。只分析候选片段，不代表听过整首音乐或整个素材库。`);
  }

  /** Run candidate selection only for events introduced by a described-event operation. */
  private async selectAudioForEvents(run: SfxRun, events: SfxRun["events"], signal?: AbortSignal) {
    if (!events.length) return;
    run.aiSelection = true;
    await usagePhase("candidate-diversity", () => prepareDiverseCandidates(events, this.runIndex(run), this.store.directory(run.id), signal, message => { run.progress = message; }));
    const report = await usagePhase("audio-selection", () => this.selectorFactory(run.workflow?.requestedModel, run.workflow?.reasoningEffort || "high").select(events, this.runIndex(run), {
      outputDir: this.store.directory(run.id),
      cacheDir: path.join(this.root, "audio-selection-cache"),
      signal,
      previousPlacements: [],
      progress: message => { run.progress = message; }
    }));
    if (run.selectionReport) {
      run.selectionReport = {
        ...run.selectionReport,
        model: report.model,
        status: report.status,
        analyzedAssets: run.selectionReport.analyzedAssets + report.analyzedAssets,
        cachedAssets: run.selectionReport.cachedAssets + report.cachedAssets,
        selectedLayers: run.selectionReport.selectedLayers + report.selectedLayers,
        rejectedLayers: run.selectionReport.rejectedLayers + report.rejectedLayers,
        fallbackLayers: run.selectionReport.fallbackLayers + report.fallbackLayers,
        warnings: [...run.selectionReport.warnings, ...report.warnings],
        decisions: [...run.selectionReport.decisions, ...report.decisions],
        audio: [...run.selectionReport.audio, ...report.audio]
      };
    } else run.selectionReport = report;
    run.selectionReport.scope = run.selectionScope || "selective";
    run.warnings.push(...report.warnings);
  }
  async reselect(id: string, body: unknown) {
    if (this.pending.has(id) || this.locks.has(id)) throw new SfxError("任务处理中", 409);
    this.locks.add(id);
    try {
      const input = z.object({ revision: z.number().int().nonnegative(), autoRender: z.boolean().default(true), selectionScope: z.enum(["selective", "full"]).default("full") }).parse(body);
      const source = await this.readRun(id);
      if (input.revision !== source.revision) throw new SfxError("任务已更新，请重新打开后再选材", 409);
      if (!source.duration || !source.events.length) throw new SfxError("请先完成视频动作分析");
      const run = await this.store.createRun({ projectId: source.projectId, name: `${source.name} · Gemini选材`.slice(0, 120), videoPath: source.videoPath, libraryPath: source.libraryPath, libraryPreferences:source.libraryPreferences,keywordPreferences:source.keywordPreferences,excludedLibraryPaths:source.excludedLibraryPaths,excludedKeywords:source.excludedKeywords,workflowPreset:"custom",musicLibraryPath: source.musicLibraryPath, musicEnabled: source.musicEnabled !== false, aiSelection: true, autoMix:source.autoMix,originalGainDb:source.originalGainDb,selectionScope: input.selectionScope });
      Object.assign(run, structuredClone({ ...creativeFields(source),duration: source.duration, originalGainDb: source.originalGainDb, originalMuted:source.originalMuted===true,assets: source.assets, events: source.events, placements: source.placements, scenes: source.scenes, analysisReport: source.analysisReport, analysisMode: source.analysisMode }));
      run.workflow=structuredClone(source.workflow||workflowSnapshot("custom",{analysisMode:source.analysisMode,selectionScope:input.selectionScope,musicEnabled:source.musicEnabled!==false,aiSelection:true,autoMix:source.autoMix===true,originalGainDb:source.originalGainDb}));
      if(input.selectionScope!=="selective") {run.workflow.presetId="custom";run.workflow.name="自定义流程";}
      Object.assign(run.workflow,{operation:"reselect",timing:"reused",selection:"fresh",source:"fresh"});
      Object.assign(run.workflow.options,{selectionScope:input.selectionScope,aiSelection:true});
      run.parentRunId = source.id;
      run.warnings = source.warnings.filter(w=>/动作查漏部分失败|部分短窗复查失败|局部接触复核失败/.test(w)); run.progress = "保留画面点位，使用 Gemini 分析候选音频并重新选材";
      const lockedIds = new Set(source.placements.filter(p => p.locked).map(p => p.eventId));
      const originalLocks = new Map(run.events.map(e => [e.id, e.locked]));
      for (const e of run.events) if (lockedIds.has(e.id)) e.locked = true;
      // Preserve the source report for export; the new run does not repeat visual model calls.
      try { await fs.copyFile(path.join(this.store.directory(source.id), "analysis-review.json"), path.join(this.store.directory(run.id), "analysis-review.json")); } catch { /* legacy run */ }
      await this.store.save(run);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("Gemini 选材超过30分钟，已停止；已分析的音频片段已缓存，可重新选材继续")), ANALYSIS_TIMEOUT_MS);
      this.launch(run, async () => {
        try {
          const index = this.runIndex(run);
          for (const event of run.events.filter(e => !e.locked)) {
            repairEventCandidates(event, index);
          }
          const candidateIds = new Set(run.events.filter(e => !e.locked).flatMap(e => [...e.candidates, ...(e.layers || []).flatMap(l => l.candidates)].map(c => c.assetId)));
          for (const asset of run.assets.filter(a => candidateIds.has(a.id))) {
            controller.signal.throwIfAborted();
            try {
              const stat = await fs.stat(asset.path);
              if (!stat.isFile()) throw new Error("不是音频文件");
              if (asset.size !== stat.size || asset.mtimeMs !== stat.mtimeMs) {
                Object.assign(asset, { size: stat.size, mtimeMs: stat.mtimeMs, usable: true });
                delete asset.duration; delete asset.onset; delete asset.peakDb; delete asset.rmsDb; delete asset.pitchSweep; delete asset.acoustics; delete asset.warning;
              }
            } catch { asset.usable = false; asset.warning = "候选素材已移动或无法访问"; run.warnings.push(`${asset.fileName}：${asset.warning}`); }
          }
          await this.selectAudio(run, controller.signal);
          for (const e of run.events) { const locked = originalLocks.get(e.id); if (locked === undefined) delete e.locked; else e.locked = locked; }
          const keep = source.placements.filter(p => lockedIds.has(p.eventId) || source.events.find(e => e.id === p.eventId)?.locked);
          const keepIds = new Set(keep.map(p => p.eventId));
          run.placements = [...createPlacements(run.events.filter(e => !keepIds.has(e.id)), run.assets, run.duration,run), ...structuredClone(keep)];
          await hydratePlacements(run);
          const reviewed = await usagePhase("audio-source-edit",()=>reviewSourceEdits(run,this.audioProvider(run),new AudioCandidateClips(),this.store.directory(run.id),controller.signal));
          run.warnings.push(...reviewed.warnings);
          if (input.autoRender && run.placements.length) { run.progress = "Gemini 选材完成，正在自动混音并生成新的视频预览"; run.render = await usagePhase("render-and-mix", () => new SfxRenderer().renderPreview(run, this.store.directory(run.id))); }
          run.status = "ready"; run.progress = "Gemini 选材及预览已完成，请试听复核";
          await exportTimeline(run, this.store.directory(run.id)); await this.saveProjectVersion(run, "reselect");
        } finally { clearTimeout(timer); controller.abort(); }
      }, "reselect-reused-timing");
      return { runId: run.id };
    } finally { this.locks.delete(id); }
  }

  async addDescribedEvent(id: string, body: unknown) {
    if (this.pending.has(id) || this.locks.has(id)) throw new SfxError("任务处理中", 409);
    this.locks.add(id);
    try {
      const input = z.object({ revision: z.number().int().nonnegative(), description: z.string().trim().min(1, "请描述需要补充的声音").max(2000) }).parse(body);
      const source = await this.readRun(id);
      if (input.revision !== source.revision) throw new SfxError("任务已更新，请重新打开后再补声", 409);
      if (!source.duration || !source.scenes.length) throw new SfxError("请先完成视频动作分析");
      const child = await this.store.createRun({
        projectId: source.projectId,
        name: `${source.name.replace(/ · (?:编辑|定位|补声)(?:副本|\d+)?$/, "").slice(0, 100)} · 补声${source.revision + 1}`,
        videoPath: source.videoPath,
        libraryPath: source.libraryPath,
        libraryPreferences: source.libraryPreferences,
        keywordPreferences: source.keywordPreferences,
        excludedLibraryPaths: source.excludedLibraryPaths,
        excludedKeywords: source.excludedKeywords,
        workflowPreset: "custom",
        musicLibraryPath: source.musicLibraryPath,
        musicEnabled: source.musicEnabled !== false,
        aiSelection: source.aiSelection === true,
        autoMix: source.autoMix !== false,
        originalGainDb: source.originalGainDb
      });
      Object.assign(child, structuredClone({
        ...creativeFields(source),duration: source.duration,
        originalGainDb: source.originalGainDb,
        originalMuted: source.originalMuted === true,
        assets: source.assets,
        events: source.events,
        placements: source.placements,
        scenes: source.scenes,
        analysisMode: source.analysisMode,
        analysisReport: source.analysisReport,
        selectionReport: source.selectionReport,
        selectionScope: source.selectionScope,
        sourceReview: source.sourceReview,
        autoMix: source.autoMix,
        musicEnabled: source.musicEnabled,
        musicLibraryPath: source.musicLibraryPath
      }));
      child.revision = source.revision + 1;
      child.parentRunId = source.id;
      child.workflow = structuredClone(source.workflow || workflowSnapshot("custom", {
        analysisMode: source.analysisMode,
        selectionScope: source.selectionScope || "selective",
        musicEnabled: source.musicEnabled !== false,
        aiSelection: source.aiSelection === true,
        autoMix: source.autoMix === true,
        originalGainDb: source.originalGainDb
      }));
      Object.assign(child.workflow, { operation: "augment", timing: "fresh", selection: "fresh", source: "reused" });
      child.workflow.options = { ...child.workflow.options, operation: "add-described-event", description: input.description };
      child.warnings = [...source.warnings, "本版本只为新增描述补充声音；原有事件、素材、剪辑和混音均沿用父版本。"];
      child.progress = "准备 Gemini 根据描述查找动作";
      delete child.render;
      await this.store.save(child);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("描述式补声超过 15 分钟，已停止；父版本仍保留")), 15 * 60 * 1000);
      this.launch(child, async () => {
        try {
          const media = this.mediaFactory();
          if (!media.sampleFrames) throw new SfxError("当前媒体工具不支持按描述扫描画面");
          const provider = this.timingFactory(child.workflow?.requestedModel, child.workflow?.reasoningEffort || "high");
          if (!provider.locateEvents) throw new SfxError("当前 Gemini 视觉配置不支持描述式补声");
          const frameDir = path.join(this.store.directory(child.id), "frames", "described-event");
          const sampleFrames = async (start: number, end: number, fps: number, name: string) => {
            let frames = await media.sampleFrames!(source.videoPath, start, end, fps, path.join(frameDir, name), controller.signal, 768);
            if (frames.length > 48) frames = frames.filter((_, index) => index % Math.ceil(frames.length / 48) === 0).slice(0, 48);
            if (!frames.length) throw new SfxError("描述式补声没有抽取到可分析的画面");
            return frames;
          };
          child.progress = `Gemini 正在全片查找：${input.description}`;
          await this.store.save(child);
          const overviewFrames = await sampleFrames(0, source.duration, Math.min(1.5, 48 / Math.max(1, source.duration)), "overview");
          const prompt = [
            "你是游戏视频声音导演。用户描述了一个缺失的声音，请扫描完整视频，只返回画面中真正出现该动作的所有候选时间段。",
            `缺失声音描述：${input.description}`,
            "不要因为镜头切换、静止或推测画外动作添加事件。每个可见动作单独返回，时间使用视频开头起算的绝对秒数。query必须是适合本地音效文件名检索的中英文关键词，包含动作、主体和材质；description写实际画面行为。",
            "category只能是foley/impact/whoosh/ambience/music/other；phase可用preparation/motion/contact/aftermath；返回JSON：{\"events\":[{\"start\":0,\"end\":1,\"type\":\"monster_bite\",\"description\":\"猩猩张嘴咬住角色\",\"query\":\"gorilla bite jaw attack\",\"category\":\"impact\",\"confidence\":0.9,\"evidence\":\"中文画面证据\",\"actor\":\"boss\",\"phase\":\"contact\"}]}。没有看到动作时返回空数组。"
          ].join("\n");
          const coarse = DescribedEventsResultSchema.parse(await provider.locateEvents(overviewFrames, prompt+creativeContext(child), controller.signal));
          if (!coarse.events.length) throw new SfxError(`Gemini 未找到“${input.description}”对应的可见动作`);
          const addedEvents: SfxRun["events"] = [];
          const locationReport: unknown[] = [];
          for (let i = 0; i < coarse.events.length; i++) {
            controller.signal.throwIfAborted();
            const candidate = coarse.events[i];
            const focusStart = Math.max(0, candidate.start - 1.2);
            const focusEnd = Math.min(source.duration, Math.max(candidate.end + 1.2, focusStart + .5));
            child.progress = `Gemini 正在精定位第 ${i + 1}/${coarse.events.length} 个“${input.description}”动作`;
            const frames = await sampleFrames(focusStart, focusEnd, SFX_WORKFLOW.timing.reviewFps, `refine-${i + 1}`);
            const refinePrompt = [
              "你是 Gemini 视频音效时间编辑器。请逐帧精定位下面这个已发现的动作，只修正它的真实开始、接触和结束时间。",
              `用户描述：${input.description}`,
              `候选事件：${JSON.stringify(candidate)}`,
              `检查范围：${focusStart.toFixed(3)}–${focusEnd.toFixed(3)} 秒。不要把镜头切换或静止当成动作。只返回JSON：{\"start\":0,\"end\":1,\"confidence\":0.0,\"evidence\":\"中文画面证据\",\"timingPrecision\":0.083}`
            ].join("\n");
            const timing = EventTimingResultSchema.parse(await provider.locateEvent(frames, refinePrompt, controller.signal));
            if (timing.start < focusStart - .001 || timing.end > focusEnd + .001) {
              locationReport.push({ candidate, rejected: "精定位结果超出检查窗口", timing, focus: { start: focusStart, end: focusEnd } });
              continue;
            }
            const refined = DescribedEventResultSchema.parse({ ...candidate, start: timing.start, end: timing.end, confidence: timing.confidence, evidence: timing.evidence, timingPrecision: timing.timingPrecision });
            if (refined.start < 0 || refined.end > source.duration + .001) continue;
            const event = EventSchema.parse({ ...refined, id: randomUUID(), start: round(refined.start), end: round(Math.min(source.duration, refined.end)), source: "vision", candidates: [], requiresHumanReview: refined.confidence < .8 });
            addedEvents.push(event);
            locationReport.push({ candidate, refined, eventId: event.id, focus: { start: focusStart, end: focusEnd } });
          }
          if (!addedEvents.length) throw new SfxError(`Gemini 未能确认“${input.description}”的有效动作点位`);
          child.events = [...source.events, ...addedEvents].sort((a, b) => a.start - b.start);
          const index = this.runIndex(child);
          planAllEventCandidates(addedEvents, index);
          await prepareCandidates(addedEvents, index, message => { child.progress = message; }, controller.signal);
          await this.selectAudioForEvents(child, addedEvents, controller.signal);
          const uncovered = addedEvents.filter(event => !(event.layers || []).some(layer => layer.candidates.length) && event.candidates.length === 0);
          if (uncovered.length) {
            for (const event of uncovered) event.requiresHumanReview = true;
            child.warnings.push(`新增描述事件暂未找到可用素材，已保留事件供人工复核：${uncovered.slice(0, 8).map(event => event.description).join("；")}`);
          }
          const newPlacements = createPlacements(addedEvents, child.assets, child.duration,child);
          child.placements = [...source.placements, ...newPlacements];
          const reviewRun = { ...child, events: addedEvents, placements: newPlacements };
          const reviewed = await usagePhase("audio-source-edit", () => reviewSourceEdits(reviewRun, this.audioProvider(child), new AudioCandidateClips(), this.store.directory(child.id), controller.signal));
          child.warnings.push(...reviewed.warnings);
          const reviewedIds = new Set(addedEvents.map(event => event.id));
          child.placements = [...source.placements, ...child.placements.filter(placement => reviewedIds.has(placement.eventId))];
          await hydratePlacements(child, { preserveEdits: false });
          await writeJson(path.join(this.store.directory(child.id), "described-event-report.json"), { version: 1, sourceRunId: source.id, description: input.description, events: locationReport, addedEventIds: addedEvents.map(event => event.id) });
          validateTimeline(child, child.events, child.placements);
          child.status = "rendering";
          child.progress = "描述动作已定位并匹配素材，正在自动混音生成新预览";
          await this.store.save(child);
          child.render = await usagePhase("render-and-mix", () => this.rendererFactory().renderPreview(child, this.store.directory(child.id), {
            preserveSavedMix: false,
            preserveSourceEdits: true,
            preservePlacementIds: new Set(source.placements.map(placement => placement.id)),
            videoSource: source.render?.revision === source.revision ? source.render.video : undefined
          }));
          child.status = "ready";
          child.progress = `已为“${input.description}”新增 ${addedEvents.length} 个音效点位并生成预览`;
          await exportTimeline(child, this.store.directory(child.id));
          await this.saveProjectVersion(child, "augment");
        } finally {
          clearTimeout(timer);
          controller.abort();
        }
      }, "add-described-event");
      return { runId: child.id };
    } finally { this.locks.delete(id); }
  }
  async automix(id: string, body: unknown) {
    if (this.pending.has(id) || this.locks.has(id)) throw new SfxError("任务处理中", 409);
    this.locks.add(id);
    try {
      const input = z.object({ revision: z.number().int().nonnegative(), autoRender: z.boolean().default(true), reviewSource: z.boolean().default(false), refreshAlternatives:z.boolean().default(false) }).parse(body);
      const source = await this.readRun(id);
      if (source.revision !== input.revision) throw new SfxError("任务已更新，请重新打开后再混音", 409);
      if (!source.placements.length) throw new SfxError("请先完成点位分析并选用音效");
      const run = await this.store.createRun({ projectId: source.projectId, name: `${source.name} · 自动混音`.slice(0, 120), videoPath: source.videoPath, libraryPath: source.libraryPath, libraryPreferences:source.libraryPreferences,keywordPreferences:source.keywordPreferences,excludedLibraryPaths:source.excludedLibraryPaths,excludedKeywords:source.excludedKeywords,workflowPreset:"custom",musicLibraryPath: source.musicLibraryPath, musicEnabled: source.musicEnabled !== false, aiSelection: source.aiSelection,originalGainDb:source.originalGainDb,autoMix: true });
      Object.assign(run, structuredClone({ ...creativeFields(source),duration: source.duration, originalGainDb: source.originalGainDb,originalMuted:source.originalMuted===true,assets: source.assets, events: source.events, placements: source.placements, scenes: source.scenes, analysisMode: source.analysisMode, analysisReport: source.analysisReport, selectionReport: source.selectionReport,selectionScope: source.selectionScope,sourceReview:source.sourceReview }));
      run.workflow=structuredClone(source.workflow||workflowSnapshot("custom",{analysisMode:source.analysisMode,selectionScope:source.selectionScope||"full",musicEnabled:source.musicEnabled!==false,aiSelection:source.aiSelection===true,autoMix:true,originalGainDb:source.originalGainDb}));
      Object.assign(run.workflow,{operation:"automix",timing:"reused",selection:"reused",source:input.reviewSource?"fresh":"reused"});
      run.workflow.options.autoMix=true;
      if(!input.reviewSource)try {await fs.copyFile(path.join(this.store.directory(source.id),"source-edit-report.json"),path.join(this.store.directory(run.id),"source-edit-report.json"));}catch { /* legacy source */ }
      run.parentRunId = source.id;
      run.warnings = ["复用上一版点位和选材；名称仅作匹配参考，本次保留实际已选素材并记录名称疑点。自动混音不新增模型请求，选材报告为继承记录。",...source.warnings.filter(w=>/动作查漏部分失败|部分短窗复查失败|局部接触复核失败/.test(w))];
      run.progress = input.reviewSource?"复核源音频段落并自动混音":"保留已选素材和截取范围，仅调整混音";
      try { await fs.copyFile(path.join(this.store.directory(id), "analysis-review.json"), path.join(this.store.directory(run.id), "analysis-review.json")); } catch { /* older manually edited timeline */ }
      await this.store.save(run);
      this.launch(run, async () => {
        const assets = new Map(run.assets.map(a => [a.id, a]));
        const events = new Map(run.events.map(e => [e.id, e]));
        const advisories: { eventId: string; start: number; fileName: string; warnings: string[] }[] = [];
        for (const p of run.placements) {
          const e = events.get(p.eventId), asset = assets.get(p.assetId);
          if (!e || !asset) continue;
          const advice = assetNameAdvice(e, p.role || p.category, asset);
          if (p.enabled && advice.warnings.length) advisories.push({ eventId: e.id, start: p.start, fileName: asset.fileName, warnings: advice.warnings });
        }
        await hydratePlacements(run,{preserveEdits:!input.reviewSource});
        if(input.refreshAlternatives) {
          for(const e of run.events.filter(e=>!e.locked))for(const layer of e.layers||[]) {
            const selected=run.placements.find(p=>p.enabled&&p.eventId===e.id&&p.layerId===layer.id);
            if(selected)layer.candidates=[{assetId:selected.assetId,score:layer.candidates[0]?.score||1,reason:"保留当前已选素材"},...layer.candidates.filter(c=>c.assetId!==selected.assetId)];
          }
          await usagePhase("candidate-diversity",()=>prepareDiverseCandidates(run.events,this.runIndex(run),this.store.directory(run.id),undefined,message=>{run.progress=message;}));
        }
        if(input.reviewSource) {
          run.warnings[0]="复用上一版Gemini画面点位与已选素材，重新复核角色发声的源音频区间，并比较不同音色备选；模型请求见本次用量报告。";
          const reviewed=await usagePhase("audio-source-edit",()=>reviewSourceEdits(run,this.audioProvider(run),new AudioCandidateClips(),this.store.directory(run.id)));
          run.warnings.push(...reviewed.warnings);
        }
        await writeJson(path.join(this.store.directory(run.id), "name-stage-review.json"), { sourceRunId: id, policy: "advisory", repairs: [], advisories });
        if (input.autoRender) run.render = await usagePhase("render-and-mix", () => new SfxRenderer().renderPreview(run, this.store.directory(run.id)));
        else { const mixed = planAutoMix(run,{preserveSourceEdits:!input.reviewSource}); run.placements = mixed.placements; run.mixReport = mixed.report; }
        run.status = "ready"; run.progress = "自动混音版本已生成，原版本已保留";
        await exportTimeline(run, this.store.directory(run.id)); await this.saveProjectVersion(run, "automix");
      }, "automix-reused-timing-selection");
      return { runId: run.id };
    } finally { this.locks.delete(id); }
  }
  private launch(run: SfxRun, work: () => Promise<void>, operation = "analyze-and-render") {
    this.active.set(run.id, run);
    const task = withModelUsage(run.id, this.store.directory(run.id), operation, work).catch(async e => {
      run.status = "failed"; run.progress = "处理失败，可查看原因后重试"; run.error = String(e instanceof Error ? e.message : e).slice(0, 1500);
      try { await this.store.save(run); }
      catch (storageError) {
        run.error += `；错误状态无法写盘：${String(storageError instanceof Error ? storageError.message : storageError).slice(0, 300)}`;
        this.failedWrites.set(run.id, structuredClone(run));
      }
    }).finally(async () => {
      try {const usage=JSON.parse(await fs.readFile(path.join(this.store.directory(run.id),"usage-report.json"),"utf8"));await writeJson(path.join(this.store.directory(run.id),"workflow-report.json"),buildWorkflowReport(run,usage));} catch { /* export route can reconstruct the report if a write was interrupted */ }
      this.pending.delete(run.id); this.active.delete(run.id);
    });
    this.pending.set(run.id, task);
  }
  async waitForIdle(id: string) { await this.pending.get(id); return this.readRun(id); }
  async search(id: string, query: string, category?: string,options:{eventId?:string;keywordPreferences?:KeywordPreference[]}&AssetExclusions={}) {
    if (this.locks.has(id) || this.pending.has(id)) throw new SfxError("任务处理中，请稍后搜索", 409);
    this.locks.add(id);
    try {
      const run = await this.readRun(id);
      // A manually added event may not have been saved yet; keep search available.
      const context=options.eventId?run.events.find(event=>event.id===options.eventId):undefined;
      const index=this.runIndex(run);
      if(options.keywordPreferences!==undefined)index.keywordPreferences=normalizeKeywordPreferences(KeywordPreferencesSchema.parse(options.keywordPreferences));
      const exclusions=z.object(ExclusionFields).parse(options);
      if(exclusions.excludedLibraryPaths!==undefined)index.excludedLibraryPaths=normalizeExcludedLibraryPaths(exclusions.excludedLibraryPaths);
      if(exclusions.excludedKeywords!==undefined)index.excludedKeywords=normalizeExcludedKeywords(exclusions.excludedKeywords);
      if (category === "music" && index.musicLibraryConfigured !== true) return [];
      const initial = new AudioLibraryIndexer().search(index, category === "music" ? `music ${query}` : query, 40,context);
      const shortlist=diverseCandidates(initial,8);
      for(let i=0;i<shortlist.length;i+=3) {
        const measured=await Promise.allSettled(shortlist.slice(i,i+3).map(r=>category==="music"?Promise.resolve():measureShortlist(r.asset,this.store.directory(run.id))));
        for(const result of measured)if(result.status==="rejected"){ /* retain filename evidence if metadata inspection is unavailable */ }
      }
      const results=diverseCandidates(shortlist.filter(r=>r.asset.usable),5);
      await Promise.all(results.map(async result => {
        if (result.asset.duration !== undefined) return;
        try { Object.assign(result.asset, await probeAudio(result.asset.path)); delete result.asset.warning; }
        catch (error) { result.asset.usable = false; result.asset.warning = "无法读取音频，请检查文件或 FFprobe：" + String(error instanceof Error ? error.message : error).slice(0, 200); }
      }));
      // Searching only returns candidate metadata. Saving new choices is an explicit edit.
      return results.map(r => ({ assetId: r.asset.id, score: r.score, reason: r.reason, asset: r.asset }));
    } finally { this.locks.delete(id); }
  }
  async exportReaper(id: string, body: unknown) {
    if (this.pending.has(id) || this.locks.has(id)) throw new SfxError("任务处理中，请稍后导出", 409);
    const input = ReaperExportSchema.parse(body);
    const run = await this.readRun(id);
    if (run.status !== "ready") throw new SfxError("请等待视频分析或预览生成完成后再导出 Reaper 工程", 409);
    if (!run.duration || !run.placements.length) throw new SfxError("当前项目没有可导出的音效贴片", 409);
    this.locks.add(id);
    try { return await new ReaperExporter(undefined, path.resolve(this.root, "..", "reaper-exports")).exportRun(run, input); }
    finally { this.locks.delete(id); }
  }
  async quickEdit(id:string,body:unknown) {
    const edit=QuickEditSchema.parse(body),run=await this.readRun(id);
    if(edit.revision!==run.revision)throw new SfxError("任务已更新，请重新打开后编辑",409);
    const target=edit.target==="event"?run.events.find(e=>e.id===edit.targetId):run.placements.find(p=>p.id===edit.targetId);
    if(!target)throw new SfxError("要编辑的事件或音效已不存在",404);
    if(edit.target==="event") {
      if(edit.action==="delete") {run.events=run.events.filter(e=>e.id!==edit.targetId);run.placements=run.placements.filter(p=>p.eventId!==edit.targetId);}
      else run.events.find(e=>e.id===edit.targetId)!.muted=edit.action==="mute";
    } else if(edit.action==="delete")run.placements=run.placements.filter(p=>p.id!==edit.targetId);
    else run.placements.find(p=>p.id===edit.targetId)!.enabled=edit.action==="unmute";
    return this.editPreview(id,{revision:edit.revision,events:run.events,placements:run.placements,originalGainDb:run.originalGainDb,originalMuted:run.originalMuted,musicEnabled:run.musicEnabled});
  }
  async locateEvent(id: string, body: unknown) {
    if (this.pending.has(id) || this.locks.has(id)) throw new SfxError("任务处理中", 409);
    this.locks.add(id);
    try {
      const input = z.object({
        revision: z.number().int().nonnegative(),
        eventId: z.string().min(1),
        description: z.string().trim().max(2000).optional(),
        startHint: z.number().finite().nonnegative().optional(),
        endHint: z.number().finite().positive().optional()
      }).refine(value => value.startHint === undefined || value.endHint === undefined || value.endHint > value.startHint, "时间提示的结束必须大于开始").parse(body);
      const source = await this.readRun(id);
      if (input.revision !== source.revision) throw new SfxError("任务已更新，请重新打开后再重新定位", 409);
      if (!source.duration || !source.events.length) throw new SfxError("请先完成视频动作分析");
      const event = source.events.find(item => item.id === input.eventId);
      if (!event) throw new SfxError("要重新定位的事件不存在", 404);
      const child = await this.store.createRun({
        projectId: source.projectId,
        name: `${source.name.replace(/ · (?:编辑|定位)(?:副本|\d+)?$/, "").slice(0, 100)} · 定位${source.revision + 1}`,
        videoPath: source.videoPath,
        libraryPath: source.libraryPath,
        libraryPreferences: source.libraryPreferences,
        keywordPreferences: source.keywordPreferences,
        excludedLibraryPaths: source.excludedLibraryPaths,
        excludedKeywords: source.excludedKeywords,
        workflowPreset: "custom",
        musicLibraryPath: source.musicLibraryPath,
        musicEnabled: source.musicEnabled !== false,
        aiSelection: source.aiSelection === true,
        autoMix: source.autoMix === true,
        originalGainDb: source.originalGainDb
      });
      Object.assign(child, structuredClone({
        ...creativeFields(source),duration: source.duration,
        originalGainDb: source.originalGainDb,
        originalMuted: source.originalMuted === true,
        assets: source.assets,
        events: source.events,
        placements: source.placements,
        scenes: source.scenes,
        analysisMode: source.analysisMode,
        analysisReport: source.analysisReport,
        selectionReport: source.selectionReport,
        selectionScope: source.selectionScope,
        sourceReview: source.sourceReview,
        autoMix: source.autoMix
      }));
      child.revision = source.revision + 1;
      child.parentRunId = source.id;
      child.workflow = structuredClone(source.workflow || workflowSnapshot("custom", {
        analysisMode: source.analysisMode,
        selectionScope: source.selectionScope || "selective",
        musicEnabled: source.musicEnabled !== false,
        aiSelection: source.aiSelection === true,
        autoMix: source.autoMix === true,
        originalGainDb: source.originalGainDb
      }));
      Object.assign(child.workflow, { operation: "reidentify", timing: "fresh", selection: "reused", source: "reused" });
      child.workflow.options = { ...child.workflow.options, operation: "reidentify-event", eventId: event.id };
      child.warnings = [...source.warnings, "本版本只重新定位一个事件的时间点；音效素材、源音频区间、增益、淡入淡出和混音均沿用上一版。"];
      child.progress = "准备 Gemini 重新定位当前事件";
      for (const file of ["analysis-review.json", "source-edit-report.json", "name-stage-review.json"]) {
        try { await fs.copyFile(path.join(this.store.directory(source.id), file), path.join(this.store.directory(child.id), file)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      await this.store.save(child);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("当前事件重新定位超过 10 分钟，已停止；原版本仍保留")), 10 * 60 * 1000);
      this.launch(child, async () => {
        try {
          const media = this.mediaFactory();
          if (!media.sampleFrames) throw new SfxError("当前媒体工具不支持按事件抽取画面帧");
          const hasHint = input.startHint !== undefined || input.endHint !== undefined;
          const hintStart = input.startHint ?? event.start;
          const hintEnd = input.endHint ?? event.end;
          const padding = hasHint ? .75 : 0;
          const focusStart = hasHint ? Math.max(0, hintStart - padding) : 0;
          const focusEnd = hasHint ? Math.min(source.duration, Math.max(hintEnd + padding, focusStart + .5)) : source.duration;
          child.progress = `Gemini 正在重新定位：${input.description?.trim() || event.description}`;
          await this.store.save(child);
          const frameDir = path.join(this.store.directory(child.id), "frames", "reidentify-event");
          const description = input.description?.trim() || event.description;
          const buildPrompt = (stage: "coarse" | "refine", rangeStart: number, rangeEnd: number) => [
            "你是 Gemini 视频音效时间编辑器。只重新定位一个已经存在的声音事件，不要重新分析整段视频，不要选择或评价音效素材。",
            `事件描述：${description}`,
            `原事件时间：${event.start.toFixed(3)}–${event.end.toFixed(3)} 秒。当前检查范围：${rangeStart.toFixed(3)}–${rangeEnd.toFixed(3)} 秒。`,
            stage === "coarse" ? "这是全片粗定位：请在所有画面中寻找与描述最匹配的动作，先返回最可能的实际时间范围。" : "这是局部精定位：请逐帧复核动作真正开始、接触或结束的画面，修正粗定位结果。",
            "start/end 使用视频开头起算的绝对秒数，精确到 0.001 秒。不要把镜头切换或静止画面当成动作。",
            "只返回 JSON：{\"start\":0.000,\"end\":0.000,\"confidence\":0.0,\"evidence\":\"中文画面证据\",\"timingPrecision\":0.033}。confidence 小于 0.8 时必须保留较低置信度，不能假装确认。"
          ].join("\n");
          const provider = this.timingFactory(child.workflow?.requestedModel, child.workflow?.reasoningEffort || "high");
          const sampleFrames = media.sampleFrames;
          if (!sampleFrames) throw new SfxError("当前媒体工具不支持按事件抽取画面帧");
          const sample = async (start: number, end: number, fps: number, name: string) => {
            let frames = await sampleFrames.call(media, source.videoPath, start, end, fps, path.join(frameDir, name), controller.signal, 768);
            if (frames.length > 48) {
              const stride = Math.ceil(frames.length / 48);
              frames = frames.filter((_, index) => index % stride === 0).slice(0, 48);
            }
            if (!frames.length) throw new SfxError("当前事件没有抽取到可分析的画面帧");
            return frames;
          };
          let result: z.infer<typeof EventTimingResultSchema>;
          if (hasHint) {
            const frames = await sample(focusStart, focusEnd, SFX_WORKFLOW.timing.reviewFps, "hint");
            result = EventTimingResultSchema.parse(await provider.locateEvent(frames, buildPrompt("refine", focusStart, focusEnd), controller.signal));
          } else {
            const coarseFrames = await sample(0, source.duration, Math.min(1.5, 48 / Math.max(1, source.duration)), "coarse");
            const coarse = EventTimingResultSchema.parse(await provider.locateEvent(coarseFrames, buildPrompt("coarse", 0, source.duration), controller.signal));
            const refineStart = Math.max(0, coarse.start - 1.5);
            const refineEnd = Math.min(source.duration, Math.max(coarse.end + 1.5, refineStart + .5));
            const refineFrames = await sample(refineStart, refineEnd, SFX_WORKFLOW.timing.reviewFps, "refine");
            result = EventTimingResultSchema.parse(await provider.locateEvent(refineFrames, buildPrompt("refine", refineStart, refineEnd), controller.signal));
          }
          const located = applyEventTiming(event, source.placements, { ...result, description: input.description?.trim() }, source.duration);
          child.events = child.events.map(item => item.id === event.id ? located.event : item);
          child.placements = located.placements;
          await writeJson(path.join(this.store.directory(child.id), "timing-reidentify.json"), {
            version: 1,
            sourceRunId: source.id,
            eventId: event.id,
            description: input.description?.trim() || event.description,
            focus: { start: focusStart, end: focusEnd },
            result
          });
          validateTimeline(child, child.events, child.placements);
          child.status = "rendering";
          child.progress = result.confidence < .8 ? "点位已重新识别，正在生成预览（待人工复核）" : "点位已重新识别，正在生成新预览";
          await this.store.save(child);
          try {
            child.render = await usagePhase("render-and-mix", () => this.rendererFactory().renderPreview(child, this.store.directory(child.id), {
              preserveSavedMix: true,
              videoSource: source.render?.revision === source.revision ? source.render.video : undefined
            }));
          } catch (error) {
            child.status = "failed";
            child.progress = "新预览未生成，原版本仍可播放";
            child.error = `新预览未生成，原版本仍可播放：${String(error instanceof Error ? error.message : error).slice(0, 900)}`;
            await this.store.save(child);
            return;
          }
          child.status = "ready";
          child.progress = result.confidence < .8 ? "点位已重新定位并生成预览，请人工复核" : "点位已重新定位并生成预览";
          await exportTimeline(child, this.store.directory(child.id));
          await this.saveProjectVersion(child, "reidentify");
        } finally {
          clearTimeout(timer);
          controller.abort();
        }
      }, "reidentify-event");
      return { runId: child.id };
    } finally { this.locks.delete(id); }
  }
  async editPreview(id:string,body:unknown) {
    const updated=await this.update(id,body,{fork:true,preview:true});
    return {runId:updated.id};
  }
  async update(id: string, body: unknown,options:{fork?:boolean;preview?:boolean}={}) {
    if (this.locks.has(id) || this.pending.has(id)) throw new SfxError("任务处理中，请稍后再保存", 409);
    this.locks.add(id);
    try {
      const edit = EditSchema.parse(body); let run = await this.readRun(id);
      if (edit.revision !== run.revision) throw new SfxError("任务已更新，请重新打开后编辑", 409);
      if(options.preview&&!run.duration)throw new SfxError("请先完成视频分析");
      const originalMuted=edit.originalMuted??(edit.originalGainDb!==run.originalGainDb?false:run.originalMuted===true);
      const keywordPreferences=normalizeKeywordPreferences(edit.keywordPreferences??run.keywordPreferences);
      if(edit.keywordPreferences!==undefined)edit.keywordPreferences=keywordPreferences;
      const referenceStyles=run.referenceStyles; // Material keyword edits do not change style research.
      const excludedLibraryPaths=normalizeExcludedLibraryPaths(edit.excludedLibraryPaths??run.excludedLibraryPaths);
      const excludedKeywords=normalizeExcludedKeywords(edit.excludedKeywords??run.excludedKeywords);
      if(edit.excludedLibraryPaths!==undefined)edit.excludedLibraryPaths=excludedLibraryPaths;
      if(edit.excludedKeywords!==undefined)edit.excludedKeywords=excludedKeywords;
      const unchanged=isDeepStrictEqual(edit.events,run.events)&&isDeepStrictEqual(edit.placements,run.placements)
        &&edit.originalGainDb===run.originalGainDb&&originalMuted===(run.originalMuted===true)
        &&isDeepStrictEqual(keywordPreferences,normalizeKeywordPreferences(run.keywordPreferences))
        &&isDeepStrictEqual(excludedLibraryPaths,normalizeExcludedLibraryPaths(run.excludedLibraryPaths))
        &&isDeepStrictEqual(excludedKeywords,normalizeExcludedKeywords(run.excludedKeywords))
        &&((edit.musicEnabled??run.musicEnabled)!==false)===(run.musicEnabled!==false);
      if(unchanged) {
        if(options.preview) {
          const record=await new PreservedSounds(path.join(this.root,"preserved")).findRun(id);
          if(record)await new PreservedSounds(path.join(this.root,"preserved")).verify(record,run);
          const media=run.render?.revision===run.revision?await Promise.allSettled([fs.access(run.render.video),fs.access(run.render.audio)]):[];
          if(media.length!==2||media.some(result=>result.status==="rejected"))await this.startSavedPreview(run);
        }
        return run;
      }
      // Retain existing placements, but never let stale candidates become new forbidden selections.
      const excluded=assetExclusionReasonResolver({excludedLibraryPaths,excludedKeywords});
      const oldPlacements=new Map(run.placements.map(p=>[p.id,p]));
      const byId=new Map(run.assets.map(a=>[a.id,a]));
      for(const placement of edit.placements) {
        const previous=oldPlacements.get(placement.id),asset=byId.get(placement.assetId);
        if(previous?.eventId===placement.eventId&&previous.assetId===placement.assetId)continue;
        const reason=asset&&excluded(asset);
        if(reason)throw new SfxError(`不能选用该素材。${reason}`);
      }
      // Search metadata stays read-only; measure newly saved selections before validating their ranges.
      for(const asset of run.assets.filter(a=>a.duration===undefined&&edit.placements.some(p=>p.assetId===a.id)))
        Object.assign(asset,await probeAudio(asset.path));
      for(const p of edit.placements) {
        const asset=run.assets.find(a=>a.id===p.assetId);
        const previous=run.placements.find(old=>old.id===p.id);
        // Candidate swaps and older clients retain the saved gain, including its distance component.
        if(!p.perspective&&previous?.perspective&&previous.eventId===p.eventId)p.perspective=structuredClone(previous.perspective);
        const changedSource=!previous||previous.assetId!==p.assetId||previous.sourceOffset!==p.sourceOffset||previous.duration!==p.duration;
        if(changedSource) p.sourceEdit={assetId:p.assetId,sourceOffset:p.sourceOffset,duration:p.duration,basis:"manual",reason:"用户编辑的源音频区间"};
        if((changedSource||previous?.fadeIn!==p.fadeIn||previous?.fadeOut!==p.fadeOut)&&!p.locked&&!edit.events.find(e=>e.id===p.eventId)?.locked)
          Object.assign(p,edgeFades(p.duration,p.sourceOffset>0||p.sourceOffset+p.duration<(asset?.duration??Infinity)-.001,p.fadeIn,p.fadeOut));
      }
      validateTimeline(run, edit.events, edit.placements);
      const preserved=new PreservedSounds(path.join(this.root,"preserved"));
      const record=await preserved.findRun(id);
      if(record||options.fork) {
        if(record)await preserved.verify(record,run);
        const source=run;
        const child=await this.store.createRun({projectId:source.projectId,name:`${source.name.replace(/ · 编辑(?:副本|\d+)$/,"").slice(0,100)} · 编辑${source.revision+1}`,videoPath:source.videoPath,libraryPath:source.libraryPath,libraryPreferences:source.libraryPreferences,keywordPreferences:source.keywordPreferences,excludedLibraryPaths:source.excludedLibraryPaths,excludedKeywords:source.excludedKeywords,workflowPreset:"custom"});
        run={...structuredClone(source),id:child.id,createdAt:child.createdAt,name:child.name,parentRunId:source.id};
        delete run.render;
        run.workflow=structuredClone(source.workflow||workflowSnapshot("custom",{analysisMode:source.analysisMode,selectionScope:source.selectionScope||"selective",musicEnabled:source.musicEnabled!==false,aiSelection:source.aiSelection===true,autoMix:source.autoMix===true,originalGainDb:source.originalGainDb}));
        Object.assign(run.workflow,{operation:"edit",timing:"reused",selection:"reused",source:"reused"});
        for(const file of ["analysis-review.json","source-edit-report.json","name-stage-review.json"])
          try{await fs.copyFile(path.join(this.store.directory(id),file),path.join(this.store.directory(run.id),file));}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
      }
      Object.assign(run, edit, { originalMuted,revision: run.revision + 1, status: "ready", progress: "修改已保存，请重新生成预览" });
      run.referenceStyles=referenceStyles;
      if(run.workflow)Object.assign(run.workflow.options,{keywordPreferences:run.keywordPreferences||[],excludedLibraryPaths:run.excludedLibraryPaths||[],excludedKeywords:run.excludedKeywords||[]});
      delete run.error;delete run.mixReport;
      await withModelUsage(run.id,this.store.directory(run.id),"save-manual-edits",async()=>{
        await exportTimeline(run,this.store.directory(run.id));
        await this.saveProjectVersion(run, "edit");
      });
      if(options.preview) {
        const parent=await this.readRun(id);
        const parentRender = parent.render?.revision===parent.revision ? parent.render : undefined;
        await this.startSavedPreview(run,parentRender?.video,parentRender);
      }
      this.failedWrites.delete(id);return run;
    } finally { this.locks.delete(id); }
  }
  async render(id: string) {
    if (this.pending.has(id) || this.locks.has(id)) throw new SfxError("任务处理中", 409);
    this.locks.add(id);
    try {
      const run = await this.readRun(id);
      if (!run.duration) throw new SfxError("请先完成视频分析");
      const preserved=new PreservedSounds(path.join(this.root,"preserved")),record=await preserved.findRun(id);
      if(record)await preserved.verify(record,run);
      if(run.status==="ready"&&run.render?.revision===run.revision) {
        const available=await Promise.allSettled([fs.access(run.render.video),fs.access(run.render.audio)]);
        if(available.every(result=>result.status==="fulfilled"))return {runId:id,reused:true};
      }
      const fallbackRender = run.render?.revision !== run.revision ? run.render : undefined;
      await this.startSavedPreview(run, undefined, fallbackRender);
      return { runId: id };
    } finally { this.locks.delete(id); }
  }
  private async startSavedPreview(run:SfxRun,videoSource?:string,fallbackRender?:SfxRun["render"]) {
    if(!run.duration)throw new SfxError("请先完成视频分析");
    run.status="rendering";run.progress="正在更新声音并生成新预览";delete run.error;
    if (fallbackRender) run.render = fallbackRender;
    else if (run.render?.revision !== run.revision) delete run.render;
    await this.store.save(run);this.failedWrites.delete(run.id);
    this.launch(run,async()=>{
      try {
        run.render=await usagePhase("render-and-mix",()=>new SfxRenderer().renderPreview(run,this.store.directory(run.id),{preserveSavedMix:true,videoSource}));
      } catch (error) {
        const detail = String(error instanceof Error ? error.message : error).slice(0, 900);
        if (fallbackRender) {
          run.render = fallbackRender;
          run.status = "failed";
          run.progress = "新预览未生成，已保留上一版预览";
          run.error = `新预览未生成，上一版预览仍可播放：${detail}`;
          await this.store.save(run);
          return;
        }
        throw error;
      }
      run.status="ready";run.progress="新预览已生成";await this.saveProjectVersion(run, run.workflow?.operation || "render");
    },"render-saved-timeline");
  }
}

function pathEqualForComparison(a: string, b: string): boolean {
  return a.trim().replaceAll("/", "\\").toLowerCase() === b.trim().replaceAll("/", "\\").toLowerCase();
}
