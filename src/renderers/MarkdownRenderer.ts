import {
  AssetNamingRules,
  AudioDesignPlan,
  AudioReferenceAnalysis,
  AudioStyleProfile,
  DocumentModel,
  QaChecklist,
  ReferencePack,
  SchedulePlan,
  TemplateAnalysis,
  VideoAnalysisResult,
  VideoManifest
} from "../schemas/index.js";

export interface RenderInput {
  projectName: string;
  template: string;
  templateAnalysis?: TemplateAnalysis;
  templateFields?: Record<string, string>;
  referencePack: ReferencePack;
  videoManifest: VideoManifest;
  videoAnalysis: VideoAnalysisResult;
  audioReferenceAnalysis?: AudioReferenceAnalysis;
  audioStyleProfile: AudioStyleProfile;
  audioDesignPlan: AudioDesignPlan;
  assetNamingRules: AssetNamingRules;
  qaChecklist: QaChecklist;
  schedulePlan: SchedulePlan;
  appendix?: string;
}

export class MarkdownRenderer {
  render(input: RenderInput): DocumentModel {
    const riskAndOpenQuestions = [
      ...input.referencePack.riskNotes,
      ...input.referencePack.openQuestions,
      ...(input.audioReferenceAnalysis?.openQuestions ?? []),
      ...input.audioStyleProfile.openQuestions,
      ...input.audioDesignPlan.openQuestions,
      ...input.schedulePlan.assumptions
    ];
    const replacements: Record<string, string> = {
      projectName: input.projectName,
      templateAnalysis: renderTemplateAnalysis(input.templateAnalysis),
      templateSpecificInfo: renderTemplateSpecificInfo(input.templateAnalysis, input.templateFields ?? {}),
      assetCount: input.templateFields?.assetCount || String(input.audioDesignPlan.items.length),
      projectSummary: input.referencePack.projectSummary,
      referenceStyleGuide: renderReferenceStyleGuide(input.audioReferenceAnalysis, input.audioStyleProfile),
      referencePack: renderReferencePack(input.referencePack),
      videoManifestTable: renderVideoManifest(input.videoManifest),
      videoAnalysisSections: renderVideoAnalysis(input.videoAnalysis),
      audioStyleProfile: [renderAudioReferenceAnalysis(input.audioReferenceAnalysis), renderAudioStyleProfile(input.audioStyleProfile)]
        .filter(Boolean)
        .join("\n\n"),
      audioDesignTable: renderAudioDesignPlan(input.audioDesignPlan),
      assetNamingRules: renderNamingRules(input.assetNamingRules),
      qaChecklist: renderQaChecklist(input.qaChecklist),
      scheduleTable: renderSchedule(input.schedulePlan),
      riskAndOpenQuestions: renderList(riskAndOpenQuestions, "暂无明确风险，仍建议制作前确认素材范围、交付格式和审核责任人。"),
      appendix: input.appendix ?? "中间 JSON 位于本次运行目录，可人工修订后 resume。"
    };
    const markdown = Object.entries(replacements).reduce(
      (text, [key, value]) => text.replaceAll(`{{${key}}}`, value),
      input.template
    );
    return {
      title: `${input.projectName} 音频外包需求文档`,
      markdown,
      blocks: markdownToBlocks(markdown),
      riskAndOpenQuestions
    };
  }
}

function renderTemplateAnalysis(analysis?: TemplateAnalysis): string {
  if (!analysis) return "按默认模板字段填充。";
  return [
    `- 模板类型：${analysis.templateType}`,
    `- 模板来源：${analysis.sourceRead}`,
    `- 识别到的模板结构：${analysis.detectedSections.join("；") || "未识别到标题，按业务画像生成"}`,
    `- 需要生成的内容：${analysis.requiredGeneratedContent.join("；")}`,
    `- 生成前需要用户填写：${analysis.userInputFields.map((field) => `${field.label}${field.required ? "（必填）" : ""}`).join("；") || "无"}`,
    `- 参考风格放置：${analysis.referenceStylePlacement}`,
    `- 填充策略：${analysis.fillStrategy.join("；")}`
  ].join("\n");
}

function renderTemplateSpecificInfo(analysis: TemplateAnalysis | undefined, fields: Record<string, string>): string {
  const type = analysis?.templateType ?? "default";
  const common = [
    `- 发包时间：${fields.packageDate || "待填写"}`,
    ...(fields.demoDate ? [`- 初版 Demo 时间：${fields.demoDate}`] : []),
    `- 期望验收完成时间：${fields.acceptanceDate || "待填写"}`,
    `- 需求名称：${fields.demandName || fields.pvName || fields.systemName || fields.characterOrClass || "待填写"}`,
    `- 音效数量：${fields.assetCount || "按设计清单统计"}`
  ];
  if (type === "skill") {
    return [
      ...common,
      `- 角色/职业/技能组：${fields.characterOrClass || "待填写"}`,
      `- 技能设计重点：${fields.skillDesignFocus || "待填写"}`,
      `- 命名前缀：${fields.namingPrefix || "按命名规范生成"}`
    ].join("\n");
  }
  if (type === "ui") {
    return [
      ...common,
      `- 系统/界面名称：${fields.systemName || "待填写"}`,
      `- 系统说明：${fields.systemDescription || "待填写"}`,
      `- 功能/动效清单：${fields.uiFunctionList || "待填写"}`,
      `- 界面音效设计要点：${fields.uiDesignFocus || "待填写"}`,
      `- 命名前缀：${fields.namingPrefix || "按命名规范生成"}`
    ].join("\n");
  }
  if (type === "pv") {
    return [
      ...common,
      `- PV名称：${fields.pvName || "待填写"}`,
      `- PV剧情/画面说明：${fields.pvSummary || "待填写"}`,
      `- 关键点位：${fields.pvKeyPoints || "待填写"}`,
      `- 对白/语音：${fields.voiceOrDialogue || "待确认"}`,
      `- 音乐/氛围关系：${fields.musicRequirement || "待确认"}`,
      `- 命名前缀：${fields.namingPrefix || "按命名规范生成"}`
    ].join("\n");
  }
  return common.join("\n");
}

function renderReferenceStyleGuide(analysis: AudioReferenceAnalysis | undefined, profile: AudioStyleProfile): string {
  const palette = [...new Set(profile.sonicPalette.map((item) => item.replace(/：需要.*$/, "").trim()).filter(Boolean))].slice(0, 12);
  const lines = [
    `- 风格摘要：${analysis?.audioReferenceSummary ?? "未上传声音参考，依据文字需求和项目参考生成。"}`,
    `- 声音调色盘：${palette.join("；") || "待补充"}`,
    `- 保留方向：${analysis?.keepList.join("；") || profile.doList.join("；") || "待补充"}`,
    `- 避让方向：${analysis?.avoidList.join("；") || profile.dontList.join("；") || "待补充"}`,
    `- 冲击/瞬态规则：${profile.impactStyle}`,
    `- 魔法/能量质感：${profile.magicTexture}`,
    `- 武器/材质质感：${profile.weaponTexture}`,
    `- 音乐与混音关系：${profile.musicRelationship}`,
    `- 混音注意：${[...new Set([...(profile.loudnessAndMixingNotes ?? []), ...(analysis?.mixingNotes ?? [])])].join("；") || "待补充"}`
  ];
  if (analysis?.analyzedFiles.length) {
    lines.push(`- 声音参考文件：${analysis.analyzedFiles.map((item) => `${item.fileName}（置信度 ${item.confidence}）`).join("；")}`);
  }
  return lines.join("\n");
}

function renderAudioReferenceAnalysis(analysis?: AudioReferenceAnalysis): string {
  if (!analysis) return "";
  return [
    "### 声音参考分析",
    `- 状态：${analysis.enabled ? "已启用" : "未启用"}；MOSS-Audio：${analysis.adapterAvailable ? "可用" : "未配置"}`,
    `- 总结：${analysis.audioReferenceSummary}`,
    `- 保留方向：${analysis.keepList.join("；") || "待补充"}`,
    `- 避让方向：${analysis.avoidList.join("；") || "待补充"}`,
    `- 参考文件：${analysis.analyzedFiles.map((item) => item.fileName).join("；") || "无"}`
  ].join("\n");
}

function renderReferencePack(pack: ReferencePack): string {
  return [
    `- 世界观/题材：${pack.worldBackground}`,
    `- 角色设定：${pack.characterProfiles.length ? pack.characterProfiles.join("；") : "待补充"}`,
    `- 阵营/元素：${pack.factionOrElementSystem.length ? pack.factionOrElementSystem.join("；") : "待补充"}`,
    `- 情绪基调：${pack.emotionalTone.length ? pack.emotionalTone.join("；") : "待补充"}`,
    `- 视觉关键词：${pack.visualStyleKeywords.length ? pack.visualStyleKeywords.join("；") : "待补充"}`,
    `- 音频关键词：${pack.audioStyleKeywords.length ? pack.audioStyleKeywords.join("；") : "待补充"}`,
    `- 竞品参考：${pack.competitorReferenceSummary.length ? pack.competitorReferenceSummary.join("；") : "待补充"}`
  ].join("\n");
}

function renderVideoManifest(manifest: VideoManifest): string {
  const rows = manifest.videos.map((video) => {
    const duration = video.duration === undefined ? "待确认" : video.duration.toFixed(2);
    const resolution =
      video.resolution.width && video.resolution.height ? `${video.resolution.width}x${video.resolution.height}` : "待确认";
    return `| ${video.videoId} | ${video.fileName} | ${video.inferredType} | ${duration} | ${resolution} | ${video.fps ?? "待确认"} |`;
  });
  return ["| ID | 文件 | 类型 | 时长(s) | 分辨率 | FPS |", "|---|---|---|---:|---|---:|", ...rows].join("\n");
}

function renderVideoAnalysis(analysis: VideoAnalysisResult): string {
  return analysis.videos
    .map((video) => {
      if (video.analysisType === "pv") {
        return [
          `### ${video.videoId}`,
          `- 类型：PV/镜头段落`,
          `- 预计音效数量：${video.estimatedSfxCount}`,
          `- 音乐情绪：${video.musicMood}`,
          ...video.segmentList.map((segment) => `- ${segment.startTime}-${segment.endTime}s：${segment.description}；声音需求：${segment.soundNeeds.join("、")}`)
        ].join("\n");
      }
      const events = video.analysisType === "skill" ? video.timelineEvents : video.timelineEvents;
      return [`### ${video.videoId}`, ...events.map((event) => `- ${event.startTime}-${event.endTime}s [${event.eventType}] ${event.suggestedSfxIntent}（置信度 ${event.confidence}）`)].join("\n");
    })
    .join("\n\n");
}

function renderAudioStyleProfile(profile: AudioStyleProfile): string {
  return [
    `- 世界声音基调：${profile.worldTone}`,
    `- 声音调色盘：${profile.sonicPalette.join("；")}`,
    `- 角色声音身份：${profile.characterSonicIdentity.join("；") || "待补充"}`,
    `- 魔法质感：${profile.magicTexture}`,
    `- 武器质感：${profile.weaponTexture}`,
    `- 冲击风格：${profile.impactStyle}`,
    `- UI 风格：${profile.UIStyle}`,
    `- 音乐关系：${profile.musicRelationship}`,
    `- 环境方向：${profile.ambienceDirection}`,
    `- Do：${profile.doList.join("；")}`,
    `- Don't：${profile.dontList.join("；")}`
  ].join("\n");
}

function renderAudioDesignPlan(plan: AudioDesignPlan): string {
  const rows = plan.items.map((item) =>
    `| ${item.assetId} | ${item.videoId} | ${item.timeRange.startTime}-${item.timeRange.endTime}s | ${item.assetType} | ${item.priority} | ${item.complexity} | ${item.soundDescription.replace(/\|/g, "/")} | ${item.estimatedWorkload} |`
  );
  return [
    "| Asset ID | 视频 | 时间 | 类型 | 优先级 | 复杂度 | 制作描述 | 估时 |",
    "|---|---|---|---|---|---|---|---|",
    ...rows
  ].join("\n");
}

function renderNamingRules(rules: AssetNamingRules): string {
  return rules.rules.map((rule) => `- ${rule.category}：\`${rule.pattern}\`，例：\`${rule.example}\``).join("\n");
}

function renderQaChecklist(checklist: QaChecklist): string {
  return [
    `交付格式：${checklist.deliveryFormat}`,
    "",
    ...checklist.globalCriteria.map((item) => `- ${item}`)
  ].join("\n");
}

function renderSchedule(schedule: SchedulePlan): string {
  const rows = schedule.milestones.map((milestone) => `| ${milestone.name} | ${milestone.date} | ${milestone.owner} | ${milestone.deliverables.join("、")} |`);
  return ["| 里程碑 | 日期 | 负责人 | 交付物 |", "|---|---|---|---|", ...rows].join("\n");
}

function renderList(values: string[], fallback: string): string {
  const clean = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  return clean.length ? clean.map((value) => `- ${value}`).join("\n") : fallback;
}

export function markdownToBlocks(markdown: string): Array<Record<string, unknown>> {
  return markdown.split(/\n{2,}/g).map((chunk) => {
    const text = chunk.trim();
    if (text.startsWith("# ")) return { type: "heading1", text: text.slice(2) };
    if (text.startsWith("## ")) return { type: "heading2", text: text.slice(3) };
    if (text.startsWith("### ")) return { type: "heading3", text: text.slice(4) };
    if (text.includes("|---")) return { type: "table_markdown", text };
    if (text.startsWith("- ")) return { type: "bullets_markdown", text };
    return { type: "paragraph", text };
  });
}
