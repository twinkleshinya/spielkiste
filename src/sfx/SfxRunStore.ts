import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CreateRunSchema, RunSchema, SfxError, SfxRun, validateTimeline } from "./models.js";
import { z } from "zod";
import { workflowSnapshot } from "./WorkflowPolicy.js";
import { buildWorkflowReport } from "./WorkflowReport.js";
import {normalizeExcludedLibraryPaths,normalizeKeywordPreferences,normalizeLibraryPreferences} from "./LibraryPreferences.js";
import {normalizeExcludedKeywords} from "./AssetExclusions.js";

export async function writeJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(temporary, file);
}

const SummarySchema=RunSchema.pick({id:true,projectId:true,name:true,createdAt:true,status:true,revision:true,parentRunId:true,videoPath:true,libraryPath:true,musicLibraryPath:true,libraryPreferences:true,keywordPreferences:true,excludedLibraryPaths:true,excludedKeywords:true,workflow:true}).extend({
  eventCount:z.number().int().nonnegative(),placementCount:z.number().int().nonnegative(),hasPreview:z.boolean()
});
const SummaryCacheSchema=z.object({version:z.literal(1),source:z.object({size:z.number(),mtimeMs:z.number()}),project:SummarySchema});
type ProjectSummary=z.infer<typeof SummarySchema>;
function projectSummary(run:SfxRun):ProjectSummary {
  return {id:run.id,projectId:run.projectId,name:run.name,createdAt:run.createdAt,status:run.status,revision:run.revision,parentRunId:run.parentRunId,videoPath:run.videoPath,libraryPath:run.libraryPath,musicLibraryPath:run.musicLibraryPath,libraryPreferences:run.libraryPreferences,keywordPreferences:run.keywordPreferences,excludedLibraryPaths:run.excludedLibraryPaths,excludedKeywords:run.excludedKeywords,workflow:run.workflow,eventCount:run.events.length,placementCount:run.placements.length,hasPreview:Boolean(run.render)};
}

export class SfxRunStore {
  constructor(public root = path.resolve(".output/sfx-runs")) {}
  directory(id: string) {
    if (!/^[\da-f-]{36}$/i.test(id)) throw new SfxError("无效任务 ID");
    return path.join(this.root, id);
  }
  async createRun(input: z.input<typeof CreateRunSchema>): Promise<SfxRun> {
    const parsed = CreateRunSchema.parse(input);
    const run: SfxRun = { version: 1, id: randomUUID(), projectId: parsed.projectId, name: parsed.name, createdAt: new Date().toISOString(), revision: 0, status: "analyzing", progress: "等待分析", videoPath: path.resolve(parsed.videoPath), libraryPath: path.resolve(parsed.libraryPath), duration: 0, originalGainDb: parsed.originalGainDb, originalMuted:parsed.workflowPreset==="reference-v6",analysisMode: parsed.analysisMode, warnings: [], scenes: [], assets: [], events: [], placements: [] };
    run.workflow=workflowSnapshot(parsed.workflowPreset,parsed);
    run.musicEnabled = parsed.musicEnabled; run.musicLibraryPath = parsed.musicLibraryPath; run.aiSelection = parsed.aiSelection;
    run.autoMix = parsed.autoMix;
    run.videoDescription=parsed.videoDescription;run.soundRequirements=parsed.soundRequirements;run.style=parsed.style;run.referenceWorks=parsed.referenceWorks;
    Object.assign(run.workflow.options,{videoDescription:run.videoDescription,soundRequirements:run.soundRequirements,style:run.style,referenceWorks:run.referenceWorks});
    run.selectionScope = parsed.selectionScope;
    if(parsed.libraryPreferences?.length)run.libraryPreferences=normalizeLibraryPreferences(parsed.libraryPreferences);
    if(parsed.keywordPreferences?.length)run.keywordPreferences=normalizeKeywordPreferences(parsed.keywordPreferences);
    if(parsed.excludedLibraryPaths?.length)run.excludedLibraryPaths=normalizeExcludedLibraryPaths(parsed.excludedLibraryPaths);
    if(parsed.excludedKeywords?.length)run.excludedKeywords=normalizeExcludedKeywords(parsed.excludedKeywords);
    run.workflow.options.libraryPreferences=run.libraryPreferences||[];
    run.workflow.options.keywordPreferences=run.keywordPreferences||[];
    run.workflow.options.excludedLibraryPaths=run.excludedLibraryPaths||[];
    run.workflow.options.excludedKeywords=run.excludedKeywords||[];
    await this.save(run); return run;
  }
  async save(run: SfxRun) {
    RunSchema.parse(run); validateTimeline(run, run.events, run.placements);
    const file=path.join(this.directory(run.id), "run.json");
    await writeJson(file, run);
    // A summary is a rebuildable cache; its failure must not undo a committed project save.
    try {await this.cacheSummary(run.id,projectSummary(run),await fs.stat(file));}catch { /* rebuilt on next list */ }
  }
  async readRun(id: string): Promise<SfxRun> {
    try { return RunSchema.parse(JSON.parse(await fs.readFile(path.join(this.directory(id), "run.json"), "utf8"))); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new SfxError("未找到任务", 404); throw e; }
  }
  private async cacheSummary(id:string,project:ProjectSummary,source:{size:number;mtimeMs:number}) {
    await writeJson(path.join(this.directory(id),"summary.json"),{version:1,source:{size:source.size,mtimeMs:source.mtimeMs},project});
  }
  private async readSummary(id:string):Promise<ProjectSummary> {
    const directory=this.directory(id),file=path.join(directory,"run.json"),source=await fs.stat(file);
    try {
      const cached=SummaryCacheSchema.parse(JSON.parse(await fs.readFile(path.join(directory,"summary.json"),"utf8")));
      if(cached.project.id===id&&cached.source.size===source.size&&cached.source.mtimeMs===source.mtimeMs)return cached.project;
    }catch { /* older project or stale/corrupt summary */ }
    // Legacy projects may embed 100,000+ library assets. Only validate their summary here;
    // full timeline and asset validation stays in readRun when the project is actually opened.
    const run=JSON.parse(await fs.readFile(file,"utf8"));
    if(run.id!==id||!Array.isArray(run.events)||!Array.isArray(run.placements)||!Array.isArray(run.assets))throw new SfxError("项目记录不完整");
    const summary=SummarySchema.parse(projectSummary(run));
    try {await this.cacheSummary(id,summary,source);}catch { /* listing remains usable on read-only storage */ }
    return summary;
  }
  async list():Promise<ProjectSummary[]> {
    await fs.mkdir(this.root, { recursive: true });
    const entries=(await fs.readdir(this.root)).filter(entry=>/^[\da-f-]{36}$/i.test(entry));
    const result:ProjectSummary[]=[];let next=0;
    // Bound legacy migrations so several very large library snapshots cannot fill memory.
    await Promise.all(Array.from({length:Math.min(2,entries.length)},async()=>{
      while(next<entries.length){const id=entries[next++];try{result.push(await this.readSummary(id));}catch { /* skip incomplete files */ }}
    }));
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async workspace():Promise<{runId:string|null;projectId?:string}> {
    try {
      const saved=z.object({runId:z.string().uuid(),projectId:z.string().uuid().optional()}).parse(JSON.parse(await fs.readFile(path.join(this.root,"workspace.json"),"utf8")));
      await this.readSummary(saved.runId);return {runId:saved.runId,projectId:saved.projectId};
    }catch { /* absent, corrupt, or removed project; recover from saved projects */ }
    const projects=await this.list();
    const latest=projects.find(project=>project.status==="ready"&&project.hasPreview)||projects.find(project=>project.status==="ready")||projects[0];
    return {runId:latest?.id||null,projectId:latest?.projectId};
  }
  async rememberOpenRun(id:string, projectId?:string):Promise<{runId:string;projectId?:string}> {
    const parsed=z.string().uuid().parse(id);
    try {await this.readSummary(parsed);}
    catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")throw new SfxError("未找到项目",404);throw error;}
    const summary=await this.readSummary(parsed);
    const resolvedProjectId=projectId||summary.projectId;
    await writeJson(path.join(this.root,"workspace.json"),{version:1,runId:parsed,projectId:resolvedProjectId,openedAt:new Date().toISOString()});
    return {runId:parsed,projectId:resolvedProjectId};
  }
}

/**
 * Build the run representation needed by the browser editor without copying the
 * complete indexed library. The full index stays on the service for search,
 * rendering and validation; the client only needs candidates and selected clips.
 */
export function clientRunPayload(run: SfxRun): SfxRun {
  const referenced = new Set<string>();
  for (const placement of run.placements) referenced.add(placement.assetId);
  for (const event of run.events) {
    for (const candidate of event.candidates) referenced.add(candidate.assetId);
    for (const layer of event.layers || []) for (const candidate of layer.candidates) referenced.add(candidate.assetId);
  }
  for (const decision of run.selectionReport?.decisions || []) if (decision.assetId) referenced.add(decision.assetId);
  for (const audio of run.selectionReport?.audio || []) referenced.add(audio.assetId);
  return { ...run, assets: run.assets.filter(asset => referenced.has(asset.id)) };
}

export async function exportTimeline(run: SfxRun, outputDir: string) {
  await writeJson(path.join(outputDir,"workflow-report.json"),buildWorkflowReport(run));
  const placements = run.placements.map(p => {
    const asset = run.assets.find(a => a.id === p.assetId)!;
    return { ...p, eventMuted:run.events.find(e=>e.id===p.eventId)?.muted===true, end: Number((p.start + p.duration).toFixed(3)), assetPath: asset.path, assetRelativePath: asset.relativePath };
  });
  await writeJson(path.join(outputDir, "events.json"), run.events);
  const actionEvents = run.events.filter(event => !event.muted && !["ambience", "music"].includes(event.category));
  const enabled = run.placements.filter(p => p.enabled && !run.events.find(e=>e.id===p.eventId)?.muted && (p.category !== "music" || run.musicEnabled !== false));
  const coveredEventIds = new Set(enabled.map(placement => placement.eventId));
  await writeJson(path.join(outputDir, "coverage-report.json"), {
    version: 1,
    generatedAt: new Date().toISOString(),
    analysisMode: run.analysisMode,
    totalEvents: run.events.length,
    mutedEvents:run.events.filter(e=>e.muted).length,
    actionEvents: actionEvents.length,
    ambienceEvents: run.events.filter(e => e.category === "ambience").length,
    musicEvents: run.events.filter(e => e.category === "music").length,
    placements: enabled.length,
    coveredActionEvents: actionEvents.filter(event => coveredEventIds.has(event.id)).length,
    uncoveredActionEvents: actionEvents.filter(event => !coveredEventIds.has(event.id)).map(event => ({ id: event.id, start: event.start, end: event.end, type: event.type, description: event.description, query: event.query })),
    lowConfidenceEvents: run.events.filter(event => event.confidence < 0.6).map(event => ({ id: event.id, start: event.start, end: event.end, type: event.type, confidence: event.confidence, description: event.description }))
  });
  await writeJson(path.join(outputDir, "music-cues.json"), { musicEnabled: run.musicEnabled !== false, cues: run.events.filter(e => e.category === "music").map(e => ({ ...e, placements: placements.filter(p => p.eventId === e.id) })) });
  if (run.selectionReport) await writeJson(path.join(outputDir, "selection-report.json"), run.selectionReport);
  if (run.mixReport) await writeJson(path.join(outputDir, "mix-report.json"), run.mixReport);
  await writeJson(path.join(outputDir, "placements.json"), { version: 1, timeUnit: "seconds", videoDescription:run.videoDescription,soundRequirements:run.soundRequirements,style:run.style,referenceWorks:run.referenceWorks,styleProfile:run.styleProfile,referenceStyles:run.referenceStyles, revision: run.revision, videoPath: run.videoPath, libraryPath:run.libraryPath,libraryPreferences:run.libraryPreferences||[],keywordPreferences:run.keywordPreferences||[],excludedLibraryPaths:run.excludedLibraryPaths||[],excludedKeywords:run.excludedKeywords||[],originalGainDb: run.originalGainDb, originalMuted:run.originalMuted,workflow:run.workflow,musicEnabled: run.musicEnabled !== false, analysisReport: run.analysisReport, selectionReport: run.selectionReport,events:run.events,mixReport:run.mixReport,placements });
  const quote = (v: unknown) => `"${String(v).replace(/"/g, '""')}"`;
  const header = "eventId,layerId,role,start,end,assetPath,gainDb,fadeIn,fadeOut,category,enabled,locked,sourceOffset,duration,loop,musicStage,intensity,evidence,sourceEditBasis,sourceEditReason,eventMuted,distance,distanceConfidence,distanceEvidence,importance,distanceGainDb";
  const rows = placements.map(p => { const event = run.events.find(e => e.id === p.eventId); return [p.eventId, p.layerId, p.role, p.start, p.end, p.assetPath, p.gainDb, p.fadeIn, p.fadeOut, p.category, p.enabled && !event?.muted && (p.category !== "music" || run.musicEnabled !== false), p.locked, p.sourceOffset, p.duration, p.loop || false, event?.musicStage || "", event?.intensity ?? "", event?.evidence || "",p.sourceEdit?.basis||"",p.sourceEdit?.reason||"",p.eventMuted,event?.distance?.range||"",event?.distance?.confidence??"",event?.distance?.evidence||"",p.perspective?.importance||event?.importance||"",p.perspective?.distanceGainDb??""].map(quote).join(","); });
  await fs.writeFile(path.join(outputDir, "placements.csv"), "\uFEFF" + [header, ...rows].join("\r\n"), "utf8");
}
