import { z } from "zod";

export const AgentNameSchema = z.enum([
  "VideoIngestionAgent",
  "ReferenceCollectorAgent",
  "RequirementUnderstandingAgent",
  "VideoContentAnalysisAgent",
  "AudioReferenceAnalysisAgent",
  "AudioStyleProfilerAgent",
  "AudioDesignPlanAgent",
  "AssetNamingAgent",
  "QualityGateAgent",
  "SchedulePlanningAgent",
  "TemplateManagerAgent",
  "ReviewAndPolishAgent",
  "FeishuDocumentAgent"
]);
export type AgentName = z.infer<typeof AgentNameSchema>;

export const ProjectConfigSchema = z.object({
  projectName: z.string().min(1),
  input: z.string().optional(),
  requirement: z.string().optional(),
  requirementText: z.string().optional(),
  requirementFeishuDocs: z.array(z.string()).default([]),
  references: z.string().optional(),
  referenceFiles: z.array(z.string()).default([]),
  referenceFeishuDocs: z.array(z.string()).default([]),
  style: z.string().optional(),
  styleText: z.string().optional(),
  styleFeishuDocs: z.array(z.string()).default([]),
  audioReferenceFiles: z.array(z.string()).default([]),
  skillDocumentFiles: z.array(z.string()).default([]),
  skillDocumentFeishuDocs: z.array(z.string()).default([]),
  enableMossAudioAnalysis: z.boolean().default(false),
  templateFields: z.record(z.string(), z.string()).default({}),
  template: z.string().optional(),
  templateSource: z.string().optional(),
  folderToken: z.string().optional(),
  docToken: z.string().optional(),
  dryRun: z.boolean().default(false),
  runId: z.string().optional(),
  only: z.array(AgentNameSchema).optional(),
  schedule: z
    .object({
      startDate: z.string().optional(),
      dueDate: z.string().optional(),
      outsourcingPeople: z.number().int().positive().optional(),
      deliveryRounds: z.number().int().positive().default(3),
      reviewNodes: z.array(z.string()).default([])
    })
    .default({ deliveryRounds: 3, reviewNodes: [] }),
  projectDescription: z.string().default(""),
  competitorReferences: z.array(z.string()).default([]),
  audioKeywords: z.array(z.string()).default([]),
  worldSetting: z.string().default(""),
  characterSetting: z.string().default(""),
  existingAudioDocs: z.string().default("")
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export const AgentRunRecordSchema = z.object({
  agentName: AgentNameSchema,
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  status: z.enum(["success", "failed", "skipped"]),
  inputPath: z.string().optional(),
  outputPath: z.string().optional(),
  errorPath: z.string().optional(),
  message: z.string().optional()
});
export type AgentRunRecord = z.infer<typeof AgentRunRecordSchema>;

export const AudioTrackInfoSchema = z.object({
  codec: z.string().optional(),
  channels: z.number().optional(),
  sampleRate: z.number().optional(),
  duration: z.number().optional()
});

export const VideoManifestItemSchema = z.object({
  videoId: z.string(),
  fileName: z.string(),
  filePath: z.string(),
  sizeBytes: z.number().nonnegative(),
  duration: z.number().nonnegative().optional(),
  fps: z.number().nonnegative().optional(),
  resolution: z
    .object({ width: z.number().optional(), height: z.number().optional() })
    .default({}),
  audioTrackInfo: z.array(AudioTrackInfoSchema).default([]),
  thumbnailPaths: z.array(z.string()).default([]),
  inferredType: z.enum(["skill", "pv", "ui", "cutscene", "boss", "unknown"]),
  confidence: z.number().min(0).max(1),
  notes: z.array(z.string()).default([])
});
export const VideoManifestSchema = z.object({
  videos: z.array(VideoManifestItemSchema),
  generatedAt: z.string(),
  source: z.string()
});
export type VideoManifest = z.infer<typeof VideoManifestSchema>;
export type VideoManifestItem = z.infer<typeof VideoManifestItemSchema>;

export const VideoIngestionInputSchema = z.object({
  inputDir: z.string(),
  projectName: z.string()
});
export type VideoIngestionInput = z.infer<typeof VideoIngestionInputSchema>;

export const ReferencePackSchema = z.object({
  projectSummary: z.string(),
  worldBackground: z.string(),
  characterProfiles: z.array(z.string()).default([]),
  factionOrElementSystem: z.array(z.string()).default([]),
  emotionalTone: z.array(z.string()).default([]),
  visualStyleKeywords: z.array(z.string()).default([]),
  audioStyleKeywords: z.array(z.string()).default([]),
  competitorReferenceSummary: z.array(z.string()).default([]),
  existingAudioRules: z.array(z.string()).default([]),
  reusableTerminology: z.array(z.string()).default([]),
  riskNotes: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
  sources: z.array(z.string()).default([])
});
export type ReferencePack = z.infer<typeof ReferencePackSchema>;

export const ReferenceCollectorInputSchema = ProjectConfigSchema.pick({
  projectName: true,
  projectDescription: true,
  requirement: true,
  requirementText: true,
  requirementFeishuDocs: true,
  references: true,
  referenceFiles: true,
  referenceFeishuDocs: true,
  competitorReferences: true,
  audioKeywords: true,
  worldSetting: true,
  characterSetting: true,
  existingAudioDocs: true
});
export type ReferenceCollectorInput = z.infer<typeof ReferenceCollectorInputSchema>;

export const AnalysisPlanSchema = z.object({
  projectType: z.enum(["skill", "pv", "ui", "boss", "cutscene", "mixed", "unknown"]),
  perTypeRules: z.record(z.string(), z.array(z.string())),
  videoPlans: z.array(
    z.object({
      videoId: z.string(),
      inferredType: z.string(),
      focus: z.array(z.string()),
      notes: z.array(z.string()).default([])
    })
  ),
  openQuestions: z.array(z.string()).default([])
});
export type AnalysisPlan = z.infer<typeof AnalysisPlanSchema>;

export const RequirementUnderstandingInputSchema = z.object({
  projectName: z.string(),
  requirementText: z.string().default(""),
  videoManifest: VideoManifestSchema,
  referencePack: ReferencePackSchema
});
export type RequirementUnderstandingInput = z.infer<typeof RequirementUnderstandingInputSchema>;

export const TimelineEventSchema = z.object({
  startTime: z.number().nonnegative(),
  endTime: z.number().nonnegative(),
  eventType: z.string(),
  visualDescription: z.string(),
  gameplayMeaning: z.string(),
  suggestedSfxIntent: z.string(),
  priority: z.enum(["low", "medium", "high", "critical"]),
  confidence: z.number().min(0).max(1)
});

export const SkillVideoAnalysisSchema = z.object({
  videoId: z.string(),
  analysisType: z.literal("skill"),
  abilityName: z.string(),
  timelineEvents: z.array(TimelineEventSchema),
  castEvents: z.array(TimelineEventSchema).default([]),
  damageEvents: z.array(TimelineEventSchema).default([]),
  movementEvents: z.array(TimelineEventSchema).default([]),
  loopEvents: z.array(TimelineEventSchema).default([]),
  specialNotes: z.array(z.string()).default([])
});

export const PvVideoAnalysisSchema = z.object({
  videoId: z.string(),
  analysisType: z.literal("pv"),
  segmentList: z.array(
    z.object({
      startTime: z.number().nonnegative(),
      endTime: z.number().nonnegative(),
      description: z.string(),
      soundNeeds: z.array(z.string()).default([]),
      confidence: z.number().min(0).max(1)
    })
  ),
  hitPoints: z.array(TimelineEventSchema).default([]),
  transitions: z.array(TimelineEventSchema).default([]),
  characterMoments: z.array(TimelineEventSchema).default([]),
  logoMoments: z.array(TimelineEventSchema).default([]),
  estimatedSfxCount: z.number().int().nonnegative(),
  musicMood: z.string(),
  ambienceNeeds: z.array(z.string()).default([]),
  foleyNeeds: z.array(z.string()).default([]),
  specialSoundDesignNeeds: z.array(z.string()).default([])
});

export const GenericVideoAnalysisSchema = z.object({
  videoId: z.string(),
  analysisType: z.literal("generic"),
  timelineEvents: z.array(TimelineEventSchema),
  notes: z.array(z.string()).default([])
});

export const VideoAnalysisResultSchema = z.object({
  videos: z.array(z.union([SkillVideoAnalysisSchema, PvVideoAnalysisSchema, GenericVideoAnalysisSchema])),
  generatedAt: z.string(),
  requiresHumanReview: z.boolean()
});
export type VideoAnalysisResult = z.infer<typeof VideoAnalysisResultSchema>;
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;

export const VideoContentAnalysisInputSchema = z.object({
  videoManifest: VideoManifestSchema,
  analysisPlan: AnalysisPlanSchema
});
export type VideoContentAnalysisInput = z.infer<typeof VideoContentAnalysisInputSchema>;

export const AudioReferenceAnalysisSchema = z.object({
  enabled: z.boolean(),
  adapterAvailable: z.boolean(),
  analyzedFiles: z.array(
    z.object({
      filePath: z.string(),
      fileName: z.string(),
      analysisText: z.string(),
      confidence: z.number().min(0).max(1),
      error: z.string().optional()
    })
  ),
  audioReferenceSummary: z.string(),
  sonicPalette: z.array(z.string()).default([]),
  rhythmAndDensity: z.array(z.string()).default([]),
  impactCharacteristics: z.array(z.string()).default([]),
  magicOrEnergyTexture: z.array(z.string()).default([]),
  weaponOrMaterialTexture: z.array(z.string()).default([]),
  musicRelationship: z.array(z.string()).default([]),
  mixingNotes: z.array(z.string()).default([]),
  keepList: z.array(z.string()).default([]),
  avoidList: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
  generatedAt: z.string()
});
export type AudioReferenceAnalysis = z.infer<typeof AudioReferenceAnalysisSchema>;

export const AudioReferenceAnalysisInputSchema = z.object({
  projectName: z.string(),
  enabled: z.boolean().default(false),
  audioReferenceFiles: z.array(z.string()).default([]),
  requirementText: z.string().default(""),
  styleText: z.string().default(""),
  referencePack: ReferencePackSchema
});
export type AudioReferenceAnalysisInput = z.infer<typeof AudioReferenceAnalysisInputSchema>;

export const AudioStyleProfileSchema = z.object({
  worldTone: z.string(),
  sonicPalette: z.array(z.string()).default([]),
  characterSonicIdentity: z.array(z.string()).default([]),
  elementOrFactionSoundRules: z.array(z.string()).default([]),
  magicTexture: z.string(),
  weaponTexture: z.string(),
  impactStyle: z.string(),
  UIStyle: z.string(),
  musicRelationship: z.string(),
  ambienceDirection: z.string(),
  loudnessAndMixingNotes: z.array(z.string()).default([]),
  doList: z.array(z.string()).default([]),
  dontList: z.array(z.string()).default([]),
  referenceKeywords: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([])
});
export type AudioStyleProfile = z.infer<typeof AudioStyleProfileSchema>;

export const AudioStyleProfilerInputSchema = z.object({
  referencePack: ReferencePackSchema,
  requirementText: z.string().default(""),
  styleText: z.string().default(""),
  projectDescription: z.string().default(""),
  competitorReferences: z.array(z.string()).default([]),
  audioReferenceAnalysis: AudioReferenceAnalysisSchema.optional()
});
export type AudioStyleProfilerInput = z.infer<typeof AudioStyleProfilerInputSchema>;

export const AudioDesignItemSchema = z.object({
  assetId: z.string(),
  videoId: z.string(),
  timeRange: z.object({ startTime: z.number().nonnegative(), endTime: z.number().nonnegative() }),
  assetType: z.enum(["sfx", "music", "ambience", "foley", "ui", "voice", "implementation_note"]),
  designIntent: z.string(),
  soundDescription: z.string(),
  layerSuggestion: z.array(z.string()).default([]),
  priority: z.enum(["low", "medium", "high", "critical"]),
  complexity: z.enum(["low", "medium", "high"]),
  estimatedWorkload: z.string(),
  deliveryFormat: z.string(),
  namingConvention: z.string(),
  reviewCriteria: z.array(z.string()).default([])
});
export const AudioDesignPlanSchema = z.object({
  items: z.array(AudioDesignItemSchema),
  summary: z.string(),
  openQuestions: z.array(z.string()).default([])
});
export type AudioDesignPlan = z.infer<typeof AudioDesignPlanSchema>;
export type AudioDesignItem = z.infer<typeof AudioDesignItemSchema>;

export const AudioDesignPlanInputSchema = z.object({
  videoAnalysis: VideoAnalysisResultSchema,
  audioStyleProfile: AudioStyleProfileSchema
});
export type AudioDesignPlanInput = z.infer<typeof AudioDesignPlanInputSchema>;

export const AssetNamingRulesSchema = z.object({
  projectName: z.string(),
  rules: z.array(
    z.object({
      category: z.string(),
      pattern: z.string(),
      example: z.string(),
      notes: z.array(z.string()).default([])
    })
  ),
  normalizedTerms: z.array(z.object({ source: z.string(), normalized: z.string() })).default([])
});
export type AssetNamingRules = z.infer<typeof AssetNamingRulesSchema>;

export const AssetNamingInputSchema = z.object({
  projectName: z.string(),
  audioDesignPlan: AudioDesignPlanSchema
});
export type AssetNamingInput = z.infer<typeof AssetNamingInputSchema>;

export const QaChecklistSchema = z.object({
  globalCriteria: z.array(z.string()),
  perAssetCriteria: z.array(
    z.object({
      assetId: z.string(),
      criteria: z.array(z.string()),
      riskNotes: z.array(z.string()).default([])
    })
  ),
  deliveryFormat: z.string()
});
export type QaChecklist = z.infer<typeof QaChecklistSchema>;

export const QualityGateInputSchema = z.object({
  audioDesignPlan: AudioDesignPlanSchema,
  deliveryFormat: z.string().default("wav 48kHz/24bit")
});
export type QualityGateInput = z.infer<typeof QualityGateInputSchema>;

export const SchedulePlanSchema = z.object({
  milestones: z.array(
    z.object({
      name: z.string(),
      date: z.string(),
      owner: z.string(),
      deliverables: z.array(z.string()),
      notes: z.array(z.string()).default([])
    })
  ),
  taskCreation: z.object({
    attempted: z.boolean(),
    supported: z.boolean(),
    message: z.string(),
    taskResults: z.array(z.unknown()).default([])
  }),
  assumptions: z.array(z.string()).default([])
});
export type SchedulePlan = z.infer<typeof SchedulePlanSchema>;

export const SchedulePlanningInputSchema = z.object({
  audioDesignPlan: AudioDesignPlanSchema,
  schedule: ProjectConfigSchema.shape.schedule,
  dryRun: z.boolean().default(false)
});
export type SchedulePlanningInput = z.infer<typeof SchedulePlanningInputSchema>;

export const TemplateRegistrySchema = z.object({
  templates: z.array(
    z.object({
      name: z.string(),
      source: z.enum(["local", "feishu", "default"]),
      path: z.string().optional(),
      docToken: z.string().optional(),
      url: z.string().optional(),
      docType: z.enum(["doc", "wiki", "sheet", "unknown"]).optional(),
      registeredAt: z.string()
    })
  )
});
export type TemplateRegistry = z.infer<typeof TemplateRegistrySchema>;

export const TemplateAnalysisSchema = z.object({
  templateName: z.string(),
  templateType: z.enum(["skill", "ui", "pv", "default", "custom"]),
  sourceRead: z.enum(["feishu", "local", "cache", "builtin_fallback", "default"]),
  detectedSections: z.array(z.string()).default([]),
  requiredGeneratedContent: z.array(z.string()).default([]),
  userInputFields: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      purpose: z.string(),
      required: z.boolean().default(false)
    })
  ).default([]),
  fillStrategy: z.array(z.string()).default([]),
  referenceStylePlacement: z.string(),
  notes: z.array(z.string()).default([])
});
export type TemplateAnalysis = z.infer<typeof TemplateAnalysisSchema>;

export const TemplateManagerInputSchema = z.object({
  projectName: z.string(),
  templateName: z.string().optional(),
  action: z.enum(["render", "add", "list"]).default("render"),
  add: z
    .object({
      name: z.string(),
      source: z.enum(["local", "feishu"]),
      path: z.string().optional(),
      docToken: z.string().optional(),
      url: z.string().optional(),
      docType: z.enum(["doc", "wiki", "sheet", "unknown"]).optional()
    })
    .optional()
});
export type TemplateManagerInput = z.infer<typeof TemplateManagerInputSchema>;

export const DocumentModelSchema = z.object({
  title: z.string(),
  markdown: z.string(),
  blocks: z.array(z.record(z.string(), z.unknown())),
  riskAndOpenQuestions: z.array(z.string()),
  localMarkdownPath: z.string().optional(),
  blocksJsonPath: z.string().optional()
});
export type DocumentModel = z.infer<typeof DocumentModelSchema>;

export const ReviewAndPolishInputSchema = z.object({
  documentModel: DocumentModelSchema,
  referencePack: ReferencePackSchema,
  audioDesignPlan: AudioDesignPlanSchema,
  qaChecklist: QaChecklistSchema
});
export type ReviewAndPolishInput = z.infer<typeof ReviewAndPolishInputSchema>;

export const FeishuDocumentResultSchema = z.object({
  dryRun: z.boolean(),
  available: z.boolean(),
  docToken: z.string().optional(),
  url: z.string().optional(),
  localMarkdownPath: z.string(),
  blocksJsonPath: z.string(),
  commandResults: z.array(z.unknown()).default([]),
  error: z.unknown().optional()
});
export type FeishuDocumentResult = z.infer<typeof FeishuDocumentResultSchema>;

export const FeishuDocumentInputSchema = z.object({
  documentModel: DocumentModelSchema,
  folderToken: z.string().optional(),
  docToken: z.string().optional(),
  dryRun: z.boolean().default(false),
  skillSheet: z
    .object({
      enabled: z.boolean().default(false),
      templateUrl: z.string().optional(),
      projectName: z.string(),
      vendorName: z.string().optional(),
      demandName: z.string().optional(),
      packageDate: z.string().optional(),
      demoDate: z.string().optional(),
      acceptanceDate: z.string().optional(),
      skillDocumentFiles: z.array(z.string()).default([]),
      skillDocumentFeishuDocs: z.array(z.string()).default([])
    })
    .optional()
});
export type FeishuDocumentInput = z.infer<typeof FeishuDocumentInputSchema>;
