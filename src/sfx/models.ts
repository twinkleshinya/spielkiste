import { z } from "zod";
import {CreativeFields,StyleProfileSchema} from "./CreativeBrief.js";
import { SFX_WORKFLOW } from "./WorkflowPolicy.js";

export const CategorySchema = z.enum(["foley", "impact", "whoosh", "ambience", "music", "other"]);
export const AcousticSchema = z.object({ version: z.literal(1), fingerprint: z.string(), sampledStart: z.number(), sampledDuration: z.number(), energyEnd: z.number(), activeDuration: z.number(), centroid: z.number(), bands: z.array(z.number()), envelope: z.array(z.number()), label: z.string() });
export const AssetSchema = z.object({
  id: z.string(), path: z.string(), relativePath: z.string(), fileName: z.string(),
  size: z.number(), mtimeMs: z.number(), tags: z.array(z.string()),
  musicOnly: z.boolean().optional(),
  duration: z.number().positive().optional(), channels: z.number().optional(), sampleRate: z.number().optional(),
  usable: z.boolean(), warning: z.string().optional()
  , onset: z.number().nonnegative().optional(), peakDb: z.number().optional(), rmsDb: z.number().optional(), pitchSweep: z.boolean().optional(), acoustics: AcousticSchema.optional()
});
export type AudioAsset = z.infer<typeof AssetSchema>;
export const LibraryPreferenceSchema=z.object({path:z.string().trim().min(1).max(2000),weight:z.number().finite().min(1).max(10)});
export type LibraryPreference=z.infer<typeof LibraryPreferenceSchema>;
export const KeywordPreferenceSchema=z.object({keyword:z.string().trim().min(1).max(120).refine(value=>/[\p{L}\p{N}]/u.test(value),"关键词需要包含文字或数字"),weight:z.number().finite().min(1).max(10),scope:z.enum(["all","boss","player","ui","ambience","music"]).default("all")});
export const KeywordPreferencesSchema=z.array(KeywordPreferenceSchema).max(12);
export type KeywordPreference=z.infer<typeof KeywordPreferenceSchema>;
export const ExclusionFields = {
  excludedLibraryPaths:z.array(z.string().trim().min(1).max(2000).refine(value=>Boolean(value.replace(/^"|"$/g,"").trim()),"排除目录不能为空")).max(12).optional(),
  excludedKeywords:z.array(z.string().trim().min(1).max(120)).max(50).optional()
};
export const IndexSchema = z.object({...CreativeFields,styleProfile:StyleProfileSchema.optional(), version: z.literal(1), root: z.string(), generatedAt: z.string(), assets: z.array(AssetSchema), warnings: z.array(z.string()),libraryPreferences:z.array(LibraryPreferenceSchema).max(12).optional(),keywordPreferences:KeywordPreferencesSchema.optional(),...ExclusionFields });
export type AudioLibraryIndex = z.infer<typeof IndexSchema>;
export const CandidateSchema = z.object({ assetId: z.string(), score: z.number(), reason: z.string() });
export const LayerRoleSchema = z.enum(["ambience", "music", "foley", "impact", "whoosh", "texture", "tail"]);
export const MusicStageSchema = z.enum(["enter", "build", "climax", "release", "exit"]);
export const DistanceSchema = z.object({range:z.enum(["near","mid","far","unknown"]),confidence:z.number().min(0).max(1),evidence:z.string().max(2000)});
export const ImportanceSchema = z.enum(["key","support","detail"]);
export const PerspectiveSchema = z.object({version:z.literal(1),range:DistanceSchema.shape.range,importance:ImportanceSchema,
  basis:z.enum(["visual","unknown","exempt"]),distanceGainDb:z.number().finite().min(-24).max(0)});
export const SoundLayerSchema = z.object({
  id: z.string(), role: LayerRoleSchema, query: z.string().max(2000), offset: z.number().finite().nonnegative(),
  candidates: z.array(CandidateSchema).default([])
});
export type SoundLayer = z.infer<typeof SoundLayerSchema>;
export const EventSchema = z.object({
  id: z.string().min(1), start: z.number().finite().nonnegative(), end: z.number().finite().positive(),
  type: z.string().min(1), description: z.string().max(2000), query: z.string().max(2000),
  category: CategorySchema, confidence: z.number().min(0).max(1), source: z.enum(["vision", "scene", "manual"]),
  groupMuteWasMuted: z.boolean().optional(),
  candidates: z.array(CandidateSchema), requiresHumanReview: z.boolean(), locked: z.boolean().optional(), muted: z.boolean().optional(),
  layers: z.array(SoundLayerSchema).optional(), actor: z.string().max(200).optional(), phase: z.string().max(100).optional(),
  evidence: z.string().max(2000).optional(), timingPrecision: z.number().positive().optional(),
  musicStage: MusicStageSchema.optional(), intensity: z.number().min(0).max(1).optional(),
  distance: DistanceSchema.optional(), importance: ImportanceSchema.optional()
}).refine(v => v.end > v.start, "事件结束时间必须大于开始时间");
export type SoundEvent = z.infer<typeof EventSchema>;
export const PlacementSchema = z.object({
  id: z.string().min(1), eventId: z.string().min(1), layerId: z.string().optional(), role: LayerRoleSchema.optional(), locked: z.boolean().optional(), assetId: z.string().min(1),
  start: z.number().finite().nonnegative(), duration: z.number().finite().positive(),
  sourceOffset: z.number().finite().nonnegative(), gainDb: z.number().finite().min(-60).max(12),
  fadeIn: z.number().finite().nonnegative(), fadeOut: z.number().finite().nonnegative(),
  category: CategorySchema, enabled: z.boolean(), loop: z.boolean().optional(),
  sourceEdit: z.object({ assetId: z.string(), sourceOffset: z.number().nonnegative(), duration: z.number().positive(), basis: z.enum(["gemini-audio", "local-bounded", "manual"]), reason: z.string().max(2000) }).optional(),
  perspective: PerspectiveSchema.optional()
});
export type SoundPlacement = z.infer<typeof PlacementSchema>;
export const SceneSchema = z.object({ start: z.number(), end: z.number(), thumbnail: z.string().optional() });
export type Scene = z.infer<typeof SceneSchema>;
export const SelectionReportSchema = z.object({
  elapsedMs: z.number().nonnegative().optional(),
  scope: z.enum(["selective", "full"]).optional(), ruleRetainedLayers: z.number().int().nonnegative().optional(),
  model: z.string(), status: z.enum(["complete", "partial", "fallback", "skipped"]), analyzedAssets: z.number().int().nonnegative(), cachedAssets: z.number().int().nonnegative(), selectedLayers: z.number().int().nonnegative(), rejectedLayers: z.number().int().nonnegative(), fallbackLayers: z.number().int().nonnegative(), warnings: z.array(z.string()),
  decisions: z.array(z.object({ eventIds: z.array(z.string()), taskId: z.string(), assetId: z.string().nullable(), reason: z.string(), basis: z.enum(["audio-context", "fallback"]) })),
  audio: z.array(z.object({ assetId: z.string(), summary: z.string(), tags: z.array(z.string()), energy: z.number(), hasMusic: z.boolean(), hasSpeech: z.boolean() }))
});
export const RunSchema = z.object({...CreativeFields,styleProfile:StyleProfileSchema.optional(),
  ...ExclusionFields,
  version: z.literal(1), id: z.string(), projectId: z.string().uuid().optional(), name: z.string(), createdAt: z.string(), revision: z.number().int().nonnegative(),
  status: z.enum(["analyzing", "ready", "rendering", "failed"]), progress: z.string(), error: z.string().optional(),
  videoPath: z.string(), libraryPath: z.string(), libraryPreferences:z.array(LibraryPreferenceSchema).max(12).optional(),keywordPreferences:KeywordPreferencesSchema.optional(),duration: z.number().nonnegative(), originalGainDb: z.number().min(-60).max(6),
  analysisMode: z.enum(["auto", "scene", "ollama", "gemini", "ccswitch"]), warnings: z.array(z.string()), scenes: z.array(SceneSchema),
  assets: z.array(AssetSchema), events: z.array(EventSchema), placements: z.array(PlacementSchema),
  musicEnabled: z.boolean().optional(), musicLibraryPath: z.string().optional(), aiSelection: z.boolean().optional(), selectionReport: SelectionReportSchema.optional(),
  autoMix: z.boolean().optional(),
  selectionScope: z.enum(["selective", "full"]).optional(),
  parentRunId: z.string().optional(),
  workflow: z.object({presetId:z.enum(["reference-v6","custom"]),version:z.string(),name:z.string(),requestedModel:z.string(),reasoningEffort:z.enum(["high","xhigh"]).optional(),operation:z.enum(["create","reselect","automix","edit","reidentify","augment","reanalyze","restore"]),timing:z.enum(["fresh","reused"]),selection:z.enum(["fresh","reused"]),source:z.enum(["fresh","reused"]).optional(),referenceRunId:z.string(),config:z.record(z.string(),z.unknown()),options:z.record(z.string(),z.unknown())}).optional(),
  originalMuted:z.boolean().optional(),
  sourceReview: z.object({model:z.string(),status:z.enum(["skipped","complete","partial","fallback"]),reviewed:z.number().int().nonnegative()}).optional(),
  mixReport: z.object({ workflow: z.string(), extendedTails: z.number(), naturalTailClips: z.number().optional(), adjustedClips: z.number(), peakConcurrency: z.number(), duckWindows: z.number(), targetLufs: z.number(), truePeakDb: z.number(), measuredLufs: z.number().nullable().optional(), measuredTruePeakDb: z.number().nullable().optional(),
    perspective:z.object({workflow:z.literal("visual-distance-priority-v1"),knownClips:z.number(),attenuatedClips:z.number(),unknownClips:z.number(),exemptClips:z.number(),lockedClips:z.number(),energyReserveDb:z.number(),baseTargetLufs:z.number()}).optional(),
    mastering:z.enum(["linear-distance-headroom","loudnorm-two-pass","peak-only"]).optional()
  }).optional(),
  analysisReport: z.object({ workflow: z.string(), model: z.string(), windows: z.number(), refinedContacts: z.number(), timingNote: z.string() }).optional(),
  render: z.object({ video: z.string(), audio: z.string(), revision: z.number() }).optional()
});
export type SfxRun = z.infer<typeof RunSchema>;
export const CreateRunSchema = z.object({...CreativeFields,
  ...ExclusionFields,
  videoPath: z.string().trim().min(1), libraryPath: z.string().trim().min(1),libraryPreferences:z.array(LibraryPreferenceSchema).max(12).optional(),keywordPreferences:KeywordPreferencesSchema.optional(),
  projectId: z.string().uuid().optional(),
  name: z.string().trim().max(120).default("视频音效贴片"), analysisMode: z.enum(["auto", "scene", "ollama"]).default("auto"), autoRender: z.boolean().default(true),
  musicEnabled: z.boolean().default(true), musicLibraryPath: z.string().trim().optional(), aiSelection: z.boolean().default(true), autoMix: z.boolean().default(true), selectionScope: z.enum(["selective", "full"]).default("selective"),
  workflowPreset:z.enum(["reference-v6","custom"]).optional(),originalGainDb:z.number().min(-60).max(6).default(0),reusePreserved:z.boolean().default(true),
  parentRunId:z.string().optional(), reanalysisMode:z.enum(["visual","brief"]).optional()
}).transform(input=>{
  const workflowPreset=input.workflowPreset||(input.analysisMode==="auto"?"reference-v6":"custom");
  return workflowPreset==="reference-v6"?{...input,workflowPreset,analysisMode:"auto" as const,autoRender:true,aiSelection:true,autoMix:true,musicEnabled:true,selectionScope:"selective" as const,originalGainDb:SFX_WORKFLOW.mix.originalGainDb}:{...input,workflowPreset};
});
export class SfxError extends Error { constructor(message: string, public status = 400) { super(message); } }
export const round = (n: number) => Math.round(n * 1000) / 1000;

export function validateTimeline(run: Pick<SfxRun, "duration" | "assets">, events: SoundEvent[], placements: SoundPlacement[]) {
  if (events.length > 1000 || placements.length > 1000) throw new SfxError("最多支持 1000 个事件或贴片");
  if (new Set(events.map(e => e.id)).size !== events.length || new Set(placements.map(p => p.id)).size !== placements.length) throw new SfxError("事件或贴片 ID 重复");
  const assetMap = new Map(run.assets.map(a => [a.id, a]));
  const eventIds = new Set(events.map(e => e.id));
  for (const e of events) if (e.end > run.duration + 0.001) throw new SfxError("事件超出视频时长");
  for (const p of placements) {
    const a = assetMap.get(p.assetId);
    if (!a?.usable || !eventIds.has(p.eventId)) throw new SfxError("贴片引用了无效素材或事件");
    if (p.start + p.duration > run.duration + 0.001 || a.duration !== undefined && (p.loop ? p.sourceOffset >= a.duration : p.sourceOffset + p.duration > a.duration + 0.001)) throw new SfxError("贴片超出视频或素材时长");
    if (p.fadeIn + p.fadeOut > p.duration + 0.001) throw new SfxError("淡入淡出总时长不能超过贴片时长");
  }
}

