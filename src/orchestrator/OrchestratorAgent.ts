import { appResource } from "../sfx/RuntimePaths.js";
import path from "node:path";
import { FileAdapter } from "../adapters/FileAdapter.js";
import { FeishuAdapter } from "../adapters/FeishuAdapter.js";
import { VideoIngestionAgent } from "../agents/VideoIngestionAgent.js";
import { ReferenceCollectorAgent } from "../agents/ReferenceCollectorAgent.js";
import { RequirementUnderstandingAgent } from "../agents/RequirementUnderstandingAgent.js";
import { VideoContentAnalysisAgent } from "../agents/VideoContentAnalysisAgent.js";
import { AudioReferenceAnalysisAgent } from "../agents/AudioReferenceAnalysisAgent.js";
import { AudioStyleProfilerAgent } from "../agents/AudioStyleProfilerAgent.js";
import { AudioDesignPlanAgent } from "../agents/AudioDesignPlanAgent.js";
import { AssetNamingAgent } from "../agents/AssetNamingAgent.js";
import { QualityGateAgent } from "../agents/QualityGateAgent.js";
import { SchedulePlanningAgent } from "../agents/SchedulePlanningAgent.js";
import { TemplateManagerAgent, TemplateManagerOutput } from "../agents/TemplateManagerAgent.js";
import { ReviewAndPolishAgent } from "../agents/ReviewAndPolishAgent.js";
import { FeishuDocumentAgent } from "../agents/FeishuDocumentAgent.js";
import { AgentContext, BaseAgent } from "../agents/BaseAgent.js";
import { MarkdownRenderer } from "../renderers/MarkdownRenderer.js";
import {
  AgentName,
  AgentRunRecord,
  AnalysisPlan,
  AudioReferenceAnalysis,
  AssetNamingRules,
  AudioDesignPlan,
  AudioStyleProfile,
  DocumentModel,
  FeishuDocumentResult,
  ProjectConfig,
  ProjectConfigSchema,
  QaChecklist,
  ReferencePack,
  SchedulePlan,
  VideoAnalysisResult,
  VideoManifest
} from "../schemas/index.js";
import { createRunId } from "../utils/ids.js";
import { createLogger } from "../utils/logger.js";
import { serializeError } from "../utils/errors.js";

type State = {
  template?: TemplateManagerOutput;
  videoManifest?: VideoManifest;
  referencePack?: ReferencePack;
  analysisPlan?: AnalysisPlan;
  videoAnalysis?: VideoAnalysisResult;
  audioReferenceAnalysis?: AudioReferenceAnalysis;
  audioStyleProfile?: AudioStyleProfile;
  audioDesignPlan?: AudioDesignPlan;
  assetNamingRules?: AssetNamingRules;
  qaChecklist?: QaChecklist;
  schedulePlan?: SchedulePlan;
  documentModel?: DocumentModel;
  polishedDocumentModel?: DocumentModel;
  feishuResult?: FeishuDocumentResult;
};

const OUTPUTS: Record<AgentName, string> = {
  VideoIngestionAgent: "video_manifest.json",
  ReferenceCollectorAgent: "reference_pack.json",
  RequirementUnderstandingAgent: "analysis_plan.json",
  VideoContentAnalysisAgent: "video_analysis.json",
  AudioReferenceAnalysisAgent: "audio_reference_analysis.json",
  AudioStyleProfilerAgent: "audio_style_profile.json",
  AudioDesignPlanAgent: "audio_design_plan.json",
  AssetNamingAgent: "asset_naming_rules.json",
  QualityGateAgent: "qa_checklist.json",
  SchedulePlanningAgent: "schedule_plan.json",
  TemplateManagerAgent: "template_registry.json",
  ReviewAndPolishAgent: "polished_document_model.json",
  FeishuDocumentAgent: "feishu_doc_result.json"
};

export class OrchestratorAgent {
  private readonly fileAdapter = new FileAdapter(process.cwd());
  private readonly log = createLogger("orchestrator");

  async run(rawConfig: Partial<ProjectConfig>): Promise<{ runId: string; runDir: string; state: State; records: AgentRunRecord[] }> {
    const config = ProjectConfigSchema.parse({
      ...rawConfig,
      referenceFiles: rawConfig.referenceFiles ?? [],
      referenceFeishuDocs: rawConfig.referenceFeishuDocs ?? [],
      dryRun: rawConfig.dryRun ?? false
    });
    const runId = config.runId ?? createRunId(config.projectName);
    const runDir = path.join(process.cwd(), ".output", "runs", runId);
    await this.fileAdapter.ensureDir(runDir);
    await this.fileAdapter.writeJson(path.join(runDir, "config.json"), config);
    const context: AgentContext = {
      runId,
      runDir,
      projectName: config.projectName,
      dryRun: config.dryRun,
      fileAdapter: this.fileAdapter,
      log: this.log
    };
    const records: AgentRunRecord[] = [];
    const state: State = await this.loadState(runDir);
    const only = config.only ? new Set<AgentName>(config.only) : undefined;
    const shouldRun = (name: AgentName) => !only || only.has(name);

    const templateFieldText = renderTemplateFieldText(config.templateFields);
    const requirementText = [
      await this.readOptionalText(config.requirement, config.requirementText, config.requirementFeishuDocs),
      templateFieldText
    ].filter(Boolean).join("\n\n");
    const styleText = await this.readOptionalText(config.style, config.styleText, config.styleFeishuDocs);

    if (shouldRun("TemplateManagerAgent")) {
      state.template = await this.execute(new TemplateManagerAgent(), { projectName: config.projectName, templateName: config.template, action: "render" }, context, records);
    } else {
      state.template ??= await this.tryLoadAgentOutput<TemplateManagerOutput>(runDir, "TemplateManagerAgent");
    }

    if (shouldRun("VideoIngestionAgent")) {
      if (!config.input) throw new Error("VideoIngestionAgent 需要 --input。");
      state.videoManifest = await this.execute(new VideoIngestionAgent(), { inputDir: config.input, projectName: config.projectName }, context, records);
    }
    state.videoManifest ??= await this.tryLoadAgentOutput<VideoManifest>(runDir, "VideoIngestionAgent");

    if (shouldRun("ReferenceCollectorAgent")) {
      state.referencePack = await this.execute(
        new ReferenceCollectorAgent(),
        { ...config, requirementText },
        context,
        records
      );
    }
    state.referencePack ??= await this.tryLoadAgentOutput<ReferencePack>(runDir, "ReferenceCollectorAgent");

    if (shouldRun("RequirementUnderstandingAgent")) {
      state.analysisPlan = await this.execute(
        new RequirementUnderstandingAgent(),
        {
          projectName: config.projectName,
          requirementText,
          videoManifest: requireState(state.videoManifest, "video_manifest.json"),
          referencePack: requireState(state.referencePack, "reference_pack.json")
        },
        context,
        records
      );
    }
    state.analysisPlan ??= await this.tryLoadAgentOutput<AnalysisPlan>(runDir, "RequirementUnderstandingAgent");

    if (shouldRun("VideoContentAnalysisAgent")) {
      state.videoAnalysis = await this.execute(
        new VideoContentAnalysisAgent(),
        {
          videoManifest: requireState(state.videoManifest, "video_manifest.json"),
          analysisPlan: requireState(state.analysisPlan, "analysis_plan.json")
        },
        context,
        records
      );
    }
    state.videoAnalysis ??= await this.tryLoadAgentOutput<VideoAnalysisResult>(runDir, "VideoContentAnalysisAgent");

    if (shouldRun("AudioReferenceAnalysisAgent")) {
      state.audioReferenceAnalysis = await this.execute(
        new AudioReferenceAnalysisAgent(),
        {
          projectName: config.projectName,
          enabled: config.enableMossAudioAnalysis,
          audioReferenceFiles: config.audioReferenceFiles,
          requirementText,
          styleText,
          referencePack: requireState(state.referencePack, "reference_pack.json")
        },
        context,
        records
      );
    }
    state.audioReferenceAnalysis ??= await this.tryLoadAgentOutput<AudioReferenceAnalysis>(runDir, "AudioReferenceAnalysisAgent");

    if (shouldRun("AudioStyleProfilerAgent")) {
      state.audioStyleProfile = await this.execute(
        new AudioStyleProfilerAgent(),
        {
          referencePack: requireState(state.referencePack, "reference_pack.json"),
          requirementText,
          styleText,
          projectDescription: config.projectDescription,
          competitorReferences: config.competitorReferences,
          audioReferenceAnalysis: state.audioReferenceAnalysis
        },
        context,
        records
      );
    }
    state.audioStyleProfile ??= await this.tryLoadAgentOutput<AudioStyleProfile>(runDir, "AudioStyleProfilerAgent");

    if (shouldRun("AudioDesignPlanAgent")) {
      state.audioDesignPlan = await this.execute(
        new AudioDesignPlanAgent(),
        {
          videoAnalysis: requireState(state.videoAnalysis, "video_analysis.json"),
          audioStyleProfile: requireState(state.audioStyleProfile, "audio_style_profile.json")
        },
        context,
        records
      );
    }
    state.audioDesignPlan ??= await this.tryLoadAgentOutput<AudioDesignPlan>(runDir, "AudioDesignPlanAgent");

    if (shouldRun("AssetNamingAgent")) {
      state.assetNamingRules = await this.execute(
        new AssetNamingAgent(),
        { projectName: config.projectName, audioDesignPlan: requireState(state.audioDesignPlan, "audio_design_plan.json") },
        context,
        records
      );
    }
    state.assetNamingRules ??= await this.tryLoadAgentOutput<AssetNamingRules>(runDir, "AssetNamingAgent");

    if (shouldRun("QualityGateAgent")) {
      state.qaChecklist = await this.execute(
        new QualityGateAgent(),
        { audioDesignPlan: requireState(state.audioDesignPlan, "audio_design_plan.json"), deliveryFormat: "wav 48kHz/24bit" },
        context,
        records
      );
    }
    state.qaChecklist ??= await this.tryLoadAgentOutput<QaChecklist>(runDir, "QualityGateAgent");

    if (shouldRun("SchedulePlanningAgent")) {
      state.schedulePlan = await this.execute(
        new SchedulePlanningAgent(),
        { audioDesignPlan: requireState(state.audioDesignPlan, "audio_design_plan.json"), schedule: config.schedule, dryRun: config.dryRun },
        context,
        records
      );
    }
    state.schedulePlan ??= await this.tryLoadAgentOutput<SchedulePlan>(runDir, "SchedulePlanningAgent");

    if (!only || shouldRun("ReviewAndPolishAgent") || shouldRun("FeishuDocumentAgent")) {
      const renderer = new MarkdownRenderer();
      state.template ??= await this.tryLoadAgentOutput<TemplateManagerOutput>(runDir, "TemplateManagerAgent");
      state.documentModel = renderer.render({
        projectName: config.projectName,
        template: state.template?.selectedTemplate ?? (await this.fileAdapter.readMarkdown(appResource("src", "templates", "default.md"))),
        templateAnalysis: state.template?.templateAnalysis,
        templateFields: config.templateFields,
        referencePack: requireState(state.referencePack, "reference_pack.json"),
        videoManifest: requireState(state.videoManifest, "video_manifest.json"),
        videoAnalysis: requireState(state.videoAnalysis, "video_analysis.json"),
        audioReferenceAnalysis: state.audioReferenceAnalysis,
        audioStyleProfile: requireState(state.audioStyleProfile, "audio_style_profile.json"),
        audioDesignPlan: requireState(state.audioDesignPlan, "audio_design_plan.json"),
        assetNamingRules: requireState(state.assetNamingRules, "asset_naming_rules.json"),
        qaChecklist: requireState(state.qaChecklist, "qa_checklist.json"),
        schedulePlan: requireState(state.schedulePlan, "schedule_plan.json")
      });
      await this.fileAdapter.writeJson(path.join(runDir, "document_model.json"), state.documentModel);
    }

    if (shouldRun("ReviewAndPolishAgent")) {
      state.polishedDocumentModel = await this.execute(
        new ReviewAndPolishAgent(),
        {
          documentModel: requireState(state.documentModel, "document_model.json"),
          referencePack: requireState(state.referencePack, "reference_pack.json"),
          audioDesignPlan: requireState(state.audioDesignPlan, "audio_design_plan.json"),
          qaChecklist: requireState(state.qaChecklist, "qa_checklist.json")
        },
        context,
        records
      );
    }
    state.polishedDocumentModel ??= await this.tryLoadAgentOutput<DocumentModel>(runDir, "ReviewAndPolishAgent");

    if (!only || shouldRun("FeishuDocumentAgent")) {
      state.feishuResult = await this.execute(
        new FeishuDocumentAgent(),
        {
          documentModel: state.polishedDocumentModel ?? requireState(state.documentModel, "document_model.json"),
          folderToken: config.folderToken,
          docToken: config.docToken,
          dryRun: config.dryRun,
          skillSheet: {
            enabled: isSkillTemplate(config.template),
            templateUrl: "https://leiting.feishu.cn/wiki/LYi2wa7KKiOEJgkl768cjCgdnOb",
            projectName: config.projectName,
            vendorName: config.templateFields.vendorName,
            demandName: config.templateFields.demandName,
            packageDate: config.templateFields.packageDate,
            demoDate: config.templateFields.demoDate,
            acceptanceDate: config.templateFields.acceptanceDate,
            skillDocumentFiles: config.skillDocumentFiles,
            skillDocumentFeishuDocs: config.skillDocumentFeishuDocs
          }
        },
        context,
        records
      );
    }

    await this.fileAdapter.writeJson(path.join(runDir, "run_manifest.json"), { runId, runDir, records });
    await this.fileAdapter.writeJson(path.join(runDir, "final_summary.json"), {
      runId,
      projectName: config.projectName,
      markdownPath: state.feishuResult?.localMarkdownPath,
      blocksPath: state.feishuResult?.blocksJsonPath,
      feishu: state.feishuResult
    });
    return { runId, runDir, state, records };
  }

  async resume(runId: string, overrides: Partial<ProjectConfig> = {}) {
    const runDir = path.join(process.cwd(), ".output", "runs", runId);
    const configPath = path.join(runDir, "config.json");
    if (!(await this.fileAdapter.exists(configPath))) {
      throw new Error(`未找到 run config：${configPath}`);
    }
    const prior = await this.fileAdapter.readJson<ProjectConfig>(configPath);
    return this.run({ ...prior, ...overrides, runId });
  }

  private async execute<TInput, TOutput>(
    agent: BaseAgent<TInput, TOutput>,
    input: TInput,
    context: AgentContext,
    records: AgentRunRecord[]
  ): Promise<TOutput> {
    const startedAt = new Date().toISOString();
    try {
      const output = await agent.execute(input, context, OUTPUTS[agent.name]);
      records.push({
        agentName: agent.name,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: "success",
        inputPath: path.join(context.runDir, "agents", agent.name, "input.json"),
        outputPath: path.join(context.runDir, "agents", agent.name, OUTPUTS[agent.name])
      });
      return output;
    } catch (error) {
      records.push({
        agentName: agent.name,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: "failed",
        inputPath: path.join(context.runDir, "agents", agent.name, "input.json"),
        errorPath: path.join(context.runDir, "agents", agent.name, "error.json"),
        message: error instanceof Error ? error.message : String(error)
      });
      await this.fileAdapter.writeJson(path.join(context.runDir, "run_manifest.json"), { runId: context.runId, runDir: context.runDir, records });
      throw error;
    }
  }

  private async loadState(runDir: string): Promise<State> {
    return {
      template: await this.tryLoadAgentOutput<TemplateManagerOutput>(runDir, "TemplateManagerAgent"),
      videoManifest: await this.tryLoadAgentOutput<VideoManifest>(runDir, "VideoIngestionAgent"),
      referencePack: await this.tryLoadAgentOutput<ReferencePack>(runDir, "ReferenceCollectorAgent"),
      analysisPlan: await this.tryLoadAgentOutput<AnalysisPlan>(runDir, "RequirementUnderstandingAgent"),
      videoAnalysis: await this.tryLoadAgentOutput<VideoAnalysisResult>(runDir, "VideoContentAnalysisAgent"),
      audioReferenceAnalysis: await this.tryLoadAgentOutput<AudioReferenceAnalysis>(runDir, "AudioReferenceAnalysisAgent"),
      audioStyleProfile: await this.tryLoadAgentOutput<AudioStyleProfile>(runDir, "AudioStyleProfilerAgent"),
      audioDesignPlan: await this.tryLoadAgentOutput<AudioDesignPlan>(runDir, "AudioDesignPlanAgent"),
      assetNamingRules: await this.tryLoadAgentOutput<AssetNamingRules>(runDir, "AssetNamingAgent"),
      qaChecklist: await this.tryLoadAgentOutput<QaChecklist>(runDir, "QualityGateAgent"),
      schedulePlan: await this.tryLoadAgentOutput<SchedulePlan>(runDir, "SchedulePlanningAgent"),
      polishedDocumentModel: await this.tryLoadAgentOutput<DocumentModel>(runDir, "ReviewAndPolishAgent")
    };
  }

  private async tryLoadAgentOutput<T>(runDir: string, agentName: AgentName): Promise<T | undefined> {
    const outputPath = path.join(runDir, "agents", agentName, OUTPUTS[agentName]);
    if (await this.fileAdapter.exists(outputPath)) {
      return this.fileAdapter.readJson<T>(outputPath);
    }
    return undefined;
  }

  private async readOptionalText(filePath?: string, inlineText?: string, feishuDocs: string[] = []): Promise<string> {
    const parts: string[] = [];
    if (inlineText) parts.push(inlineText);
    if (filePath) {
      try {
        parts.push(await this.fileAdapter.readMarkdown(filePath));
      } catch (error) {
        this.log.warn({ error: serializeError(error), filePath }, "optional text read failed");
        parts.push(filePath);
      }
    }
    if (feishuDocs.length > 0) {
      parts.push(await this.readFeishuDocs(feishuDocs));
    }
    return parts.filter(Boolean).join("\n\n");
  }

  private async readFeishuDocs(docTokens: string[]): Promise<string> {
    const feishu = new FeishuAdapter();
    const availability = await feishu.checkAvailability();
    if (!availability.available) {
      return `配置了飞书文档，但 feishu-tool 不可用：${availability.message}`;
    }
    const outputs: string[] = [];
    for (const docToken of docTokens) {
      const result = await feishu.getDocumentBlocks(docToken);
      outputs.push(`飞书文档 ${docToken}\n${result.stdout || result.stderr}`);
    }
    return outputs.join("\n\n");
  }
}

function isSkillTemplate(template?: string): boolean {
  return Boolean(template?.includes("技能"));
}

function requireState<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`缺少 ${name}。如果你在 only/resume 模式运行，请先生成或人工补充对应 JSON。`);
  }
  return value;
}

function renderTemplateFieldText(fields: Record<string, string> = {}): string {
  const rows = Object.entries(fields).filter(([, value]) => value?.trim());
  if (!rows.length) return "";
  const labels: Record<string, string> = {
    demandName: "需求名称",
    packageDate: "发包时间",
    demoDate: "初版 Demo 时间",
    acceptanceDate: "期望验收完成时间",
    characterOrClass: "角色/职业/技能组",
    assetCount: "音效数量",
    skillDesignFocus: "技能设计重点",
    systemName: "系统/界面名称",
    systemDescription: "系统说明",
    uiFunctionList: "功能/动效清单",
    uiDesignFocus: "界面音效设计要点",
    pvName: "PV名称",
    pvSummary: "PV剧情/画面说明",
    pvKeyPoints: "关键点位",
    voiceOrDialogue: "对白/语音",
    musicRequirement: "音乐/氛围关系",
    namingPrefix: "命名前缀"
  };
  return ["# 用户填写的模板信息", ...rows.map(([key, value]) => `- ${labels[key] ?? key}：${value}`)].join("\n");
}
