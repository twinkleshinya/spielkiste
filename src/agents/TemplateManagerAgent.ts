import { appResource } from "../sfx/RuntimePaths.js";
import path from "node:path";
import {
  TemplateManagerInput,
  TemplateManagerInputSchema,
  TemplateAnalysis,
  TemplateAnalysisSchema,
  TemplateRegistry,
  TemplateRegistrySchema
} from "../schemas/index.js";
import { FeishuAdapter } from "../adapters/FeishuAdapter.js";
import { BaseAgent, AgentContext } from "./BaseAgent.js";

const BUILTIN_TEMPLATES = [
  {
    name: "技能音效",
    source: "feishu" as const,
    url: "https://leiting.feishu.cn/wiki/LYi2wa7KKiOEJgkl768cjCgdnOb",
    docToken: "LYi2wa7KKiOEJgkl768cjCgdnOb",
    docType: "sheet" as const
  },
  {
    name: "界面音效",
    source: "feishu" as const,
    url: "https://leiting.feishu.cn/wiki/EbmJw5LT7idcrzkCTEhcQw66nWg",
    docToken: "EbmJw5LT7idcrzkCTEhcQw66nWg",
    docType: "wiki" as const
  },
  {
    name: "PV音效",
    source: "feishu" as const,
    url: "https://leiting.feishu.cn/docx/Epf0dfxdDoTuHgxmIvachU1fnLc",
    docToken: "Epf0dfxdDoTuHgxmIvachU1fnLc",
    docType: "doc" as const
  }
];

export interface TemplateManagerOutput {
  registry: TemplateRegistry;
  selectedTemplate: string;
  selectedTemplateName: string;
  selectedTemplateSource?: string;
  templateReadStatus?: {
    attempted: boolean;
    success: boolean;
    message: string;
    rawTemplatePath?: string;
  };
  templateAnalysis: TemplateAnalysis;
}

export class TemplateManagerAgent extends BaseAgent<TemplateManagerInput, TemplateManagerOutput> {
  readonly name = "TemplateManagerAgent" as const;

  async run(input: TemplateManagerInput, context: AgentContext): Promise<TemplateManagerOutput> {
    const parsed = TemplateManagerInputSchema.parse(input);
    const registryPath = path.join(process.cwd(), ".output", "template_registry.json");
    const registry = await readRegistry(context, registryPath);

    if (parsed.action === "add" && parsed.add) {
      registry.templates = registry.templates.filter((template) => template.name !== parsed.add?.name);
      registry.templates.push({
        name: parsed.add.name,
        source: parsed.add.source,
        path: parsed.add.path,
        docToken: parsed.add.docToken,
        url: parsed.add.url,
        docType: parsed.add.docType,
        registeredAt: new Date().toISOString()
      });
      await context.fileAdapter.writeJson(registryPath, registry);
    }

    const selected = registry.templates.find((template) => template.name === parsed.templateName) ?? registry.templates.find((template) => template.source === "default");
    let selectedTemplate = await defaultTemplate(context);
    let selectedTemplateName = "default";
    let selectedTemplateSource: string | undefined = "default";
    let templateReadStatus: TemplateManagerOutput["templateReadStatus"] = { attempted: false, success: true, message: "使用默认模板。" };
    let sourceRead: TemplateAnalysis["sourceRead"] = "default";
    let rawTemplateForAnalysis = selectedTemplate;
    if (selected?.source === "local" && selected.path) {
      selectedTemplate = await context.fileAdapter.readMarkdown(selected.path);
      selectedTemplateName = selected.name;
      selectedTemplateSource = selected.path;
      templateReadStatus = { attempted: true, success: true, message: "已读取本地模板。" };
      sourceRead = "local";
      rawTemplateForAnalysis = selectedTemplate;
    } else if (selected?.source === "feishu" && (selected.docToken || selected.url)) {
      const cachedPath = cachedTemplatePath(selected.name);
      if (await context.fileAdapter.exists(cachedPath)) {
        const raw = await context.fileAdapter.readMarkdown(cachedPath);
        selectedTemplate = await fallbackTemplateFor(selected.name, context);
        selectedTemplateName = selected.name;
        selectedTemplateSource = selected.url ?? selected.docToken;
        sourceRead = "cache";
        rawTemplateForAnalysis = raw;
        templateReadStatus = {
          attempted: true,
          success: true,
          message: `已读取本地缓存的飞书模板：${cachedPath}`,
          rawTemplatePath: cachedPath
        };
      } else {
      const feishu = new FeishuAdapter();
      const availability = await feishu.checkAvailability();
      if (availability.available) {
        const reference = selected.url ?? selected.docToken ?? "";
        const result = await feishu.getContent(reference);
        if (result.exitCode === 0 && result.stdout.trim()) {
          const rawTemplatePath = path.join(context.runDir, "template_raw.md");
          await context.fileAdapter.writeMarkdown(rawTemplatePath, result.stdout);
          selectedTemplate = await fallbackTemplateFor(selected.name, context);
          selectedTemplateName = selected.name;
          selectedTemplateSource = reference;
          sourceRead = "feishu";
          rawTemplateForAnalysis = result.stdout;
          templateReadStatus = {
            attempted: true,
            success: true,
            message: "已通过 lark-cli 读取飞书模板，并与填充区合并。",
            rawTemplatePath
          };
        } else {
          selectedTemplateName = selected.name;
          selectedTemplateSource = reference;
          selectedTemplate = await fallbackTemplateFor(selected.name, context);
          sourceRead = "builtin_fallback";
          rawTemplateForAnalysis = selectedTemplate;
          templateReadStatus = {
            attempted: true,
            success: false,
            message: `飞书模板读取失败，已回退对应业务模板：${result.stderr || result.stdout || "无输出"}`
          };
        }
      } else {
        selectedTemplateName = selected.name;
        selectedTemplateSource = selected.url ?? selected.docToken;
        selectedTemplate = await fallbackTemplateFor(selected.name, context);
        sourceRead = "builtin_fallback";
        rawTemplateForAnalysis = selectedTemplate;
        templateReadStatus = {
          attempted: true,
          success: false,
          message: `${availability.message}；已回退对应业务模板。`
        };
      }
      }
    }
    const templateAnalysis = analyzeTemplate(selectedTemplateName, rawTemplateForAnalysis, sourceRead);
    await context.fileAdapter.writeJson(path.join(context.runDir, "template_analysis.json"), templateAnalysis);

    return {
      registry: TemplateRegistrySchema.parse(registry),
      selectedTemplate,
      selectedTemplateName,
      selectedTemplateSource,
      templateReadStatus,
      templateAnalysis
    };
  }
}

function cachedTemplatePath(templateName: string): string {
  const normalized = templateName.includes("技能")
    ? "skill"
    : templateName.includes("界面")
      ? "ui"
      : templateName.toLowerCase().includes("pv")
        ? "pv"
        : "default";
  return path.join(process.cwd(), ".output", "template_cache", `${normalized}.md`);
}

async function readRegistry(context: AgentContext, registryPath: string): Promise<TemplateRegistry> {
  const ensureBuiltins = async (registry: TemplateRegistry) => {
    for (const builtin of BUILTIN_TEMPLATES) {
      if (!registry.templates.some((template) => template.name === builtin.name)) {
        registry.templates.push({ ...builtin, registeredAt: new Date().toISOString() });
      }
    }
    if (!registry.templates.some((template) => template.source === "default")) {
      registry.templates.unshift({ name: "default", source: "default", registeredAt: new Date().toISOString() });
    }
    await context.fileAdapter.writeJson(registryPath, registry);
    return registry;
  };
  if (await context.fileAdapter.exists(registryPath)) {
    return ensureBuiltins(TemplateRegistrySchema.parse(await context.fileAdapter.readJson(registryPath)));
  }
  const registry = TemplateRegistrySchema.parse({
    templates: [{ name: "default", source: "default", registeredAt: new Date().toISOString() }, ...BUILTIN_TEMPLATES.map((template) => ({ ...template, registeredAt: new Date().toISOString() }))]
  });
  await context.fileAdapter.writeJson(registryPath, registry);
  return registry;
}

async function defaultTemplate(context: AgentContext): Promise<string> {
  const templatePath = appResource("src", "templates", "default.md");
  return context.fileAdapter.readMarkdown(templatePath);
}

async function fallbackTemplateFor(templateName: string, context: AgentContext): Promise<string> {
  const normalized = templateName.toLowerCase();
  if (normalized.includes("技能")) {
    return context.fileAdapter.readMarkdown(appResource("src", "templates", "skill.md"));
  }
  if (normalized.includes("界面")) {
    return context.fileAdapter.readMarkdown(appResource("src", "templates", "ui.md"));
  }
  if (normalized.includes("pv")) {
    return context.fileAdapter.readMarkdown(appResource("src", "templates", "pv.md"));
  }
  return defaultTemplate(context);
}

function analyzeTemplate(templateName: string, rawTemplate: string, sourceRead: TemplateAnalysis["sourceRead"]): TemplateAnalysis {
  const templateType = inferTemplateType(templateName, rawTemplate);
  const detectedSections = extractSections(rawTemplate);
  const profile = templateProfile(templateType);
  return TemplateAnalysisSchema.parse({
    templateName,
    templateType,
    sourceRead,
    detectedSections,
    requiredGeneratedContent: profile.requiredGeneratedContent,
    fillStrategy: profile.fillStrategy,
    referenceStylePlacement: profile.referenceStylePlacement,
    userInputFields: profile.userInputFields,
    notes: [
      sourceRead === "feishu"
        ? "已读取飞书模板原文，并按模板结构追加/填充自动生成内容。"
        : sourceRead === "cache"
          ? "已读取本地缓存的飞书模板原文，并按模板结构生成内容。"
        : "当前未读取到飞书模板原文，使用内置业务模板画像保证字段完整。",
      detectedSections.length ? "已识别模板标题结构。" : "未识别到明确标题，按业务模板画像生成。"
    ]
  });
}

function inferTemplateType(templateName: string, rawTemplate: string): TemplateAnalysis["templateType"] {
  const text = `${templateName}\n${rawTemplate}`.toLowerCase();
  if (text.includes("技能") || text.includes("skill") || text.includes("cast") || text.includes("release") || text.includes("hit")) return "skill";
  if (text.includes("pv") || text.includes("镜头") || text.includes("分镜") || text.includes("对白")) return "pv";
  if (text.includes("界面") || text.includes("ui") || text.includes("按钮") || text.includes("弹窗")) return "ui";
  if (templateName === "default") return "default";
  return "custom";
}

function extractSections(rawTemplate: string): string[] {
  const htmlHeadings = [...rawTemplate.matchAll(/<(?:title|h[1-4])[^>]*>([\s\S]*?)<\/(?:title|h[1-4])>/gi)]
    .map((match) => stripTags(match[1]).trim())
    .filter(Boolean);
  const markdownHeadings = rawTemplate
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^#{1,4}\s+/.test(line) || /^\d+[\.、]\s*/.test(line))
    .map((line) => line.replace(/^#{1,4}\s+/, "").trim())
    .slice(0, 24);
  return [...new Set([...htmlHeadings, ...markdownHeadings])].slice(0, 24);
}

function stripTags(value: string): string {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function templateProfile(templateType: TemplateAnalysis["templateType"]) {
  if (templateType === "skill") {
    return {
      requiredGeneratedContent: [
        "需求概览",
        "参考风格与避让说明",
        "素材与技能视频清单",
        "技能拆解与声音触发点",
        "技能音效设计清单",
        "项目音频风格规则",
        "命名规范",
        "交付与验收",
        "排期与风险"
      ],
      fillStrategy: [
        "将声音参考分析写入模板的参考风格/音频风格/制作方向区域。",
        "将技能视频按 cast、charge、release、hit、damage、movement、loop、end 拆成可报价事件。",
        "每条音效资产生成层次说明、优先级、复杂度、估时、命名与验收标准。"
      ],
      userInputFields: [
        { key: "packageDate", label: "发包时间", purpose: "填入模板的发包/初版/验收时间区域", required: false },
        { key: "demoDate", label: "初版 Demo 时间", purpose: "明确供应商首次反馈时间", required: false },
        { key: "acceptanceDate", label: "期望验收完成时间", purpose: "生成验收时间和排期", required: false },
        { key: "characterOrClass", label: "角色/职业/技能组", purpose: "填写技能所属对象和风格锚点", required: true },
        { key: "assetCount", label: "音效数量", purpose: "填入需求汇总和排期估算", required: false },
        { key: "skillDesignFocus", label: "技能设计重点", purpose: "补充 cast/release/hit 等阶段设计说明", required: true },
        { key: "namingPrefix", label: "命名前缀", purpose: "生成资源命名字段", required: false }
      ],
      referenceStylePlacement: "优先填入“参考风格与避让说明”，并同步影响“项目音频风格规则”和“技能音效设计清单”。"
    };
  }
  if (templateType === "ui") {
    return {
      requiredGeneratedContent: [
        "项目与需求概览",
        "参考风格、保留与避让",
        "素材列表",
        "界面完整流程说明",
        "系统说明",
        "音效设计要点",
        "需求详细说明",
        "参考视频/参考风格",
        "音频风格与混音关系",
        "资产命名与版本规则",
        "交付格式与验收标准",
        "排期与反馈节点"
      ],
      fillStrategy: [
        "将声音参考分析写入参考风格/保留/避让区域，明确哪些音色锚点可复用、哪些竞品声音不能照搬。",
        "UI 按点击、确认、取消、弹窗、奖励、转场、循环、反馈层级拆分。",
        "把用户填写的系统说明、功能清单、动效说明和资源命名写入需求详细说明表。"
      ],
      userInputFields: [
        { key: "packageDate", label: "发包时间", purpose: "填入发包时间", required: false },
        { key: "demoDate", label: "初听版本时间", purpose: "填入初版 demo 时间", required: false },
        { key: "acceptanceDate", label: "期望验收完成时间", purpose: "填入验收时间", required: false },
        { key: "systemName", label: "系统/界面名称", purpose: "填写系统说明标题和需求汇总", required: true },
        { key: "systemDescription", label: "系统说明", purpose: "生成系统说明段落", required: true },
        { key: "uiFunctionList", label: "功能/动效清单", purpose: "拆成需求详细说明表", required: true },
        { key: "uiDesignFocus", label: "界面音效设计要点", purpose: "生成音效设计要点", required: true },
        { key: "namingPrefix", label: "命名前缀", purpose: "生成资源名称", required: false }
      ],
      referenceStylePlacement: "优先填入“参考风格、保留与避让”，并同步影响“音频风格与混音关系”。"
    };
  }
  if (templateType === "pv") {
    return {
      requiredGeneratedContent: [
        "发包/验收时间",
        "音频需求汇总",
        "PV视频",
        "PV说明",
        "音效设计要点",
        "关键点位参考说明",
        "镜头/关键点位表",
        "音频风格与混音关系",
        "交付格式与验收标准"
      ],
      fillStrategy: [
        "将 PV 剧情说明、镜头节奏、对白关系和关键点位写入模板对应区域。",
        "PV 音效以镜头段落、转场、角色出场、logo/字幕、环境和音乐关系为主，不按技能阶段拆。",
        "声音参考分析写入风格保留/避让，尤其控制动态范围和对白避让。"
      ],
      userInputFields: [
        { key: "packageDate", label: "发包时间", purpose: "填入发包时间", required: false },
        { key: "acceptanceDate", label: "期望验收完成时间", purpose: "填入验收时间", required: false },
        { key: "pvName", label: "PV名称", purpose: "生成标题和 PV说明", required: true },
        { key: "pvSummary", label: "PV剧情/画面说明", purpose: "生成 PV说明", required: true },
        { key: "pvKeyPoints", label: "关键点位", purpose: "生成关键点位参考说明表", required: true },
        { key: "voiceOrDialogue", label: "是否有对白/语音", purpose: "决定音效动态和混音避让", required: false },
        { key: "musicRequirement", label: "音乐/氛围关系", purpose: "描述音效与音乐/氛围的关系", required: false },
        { key: "namingPrefix", label: "命名前缀", purpose: "生成资源名称", required: false }
      ],
      referenceStylePlacement: "优先填入“音效设计要点”和“音频风格与混音关系”，并影响关键点位表的制作说明。"
    };
  }
  return {
    requiredGeneratedContent: ["项目概述", "参考包", "素材列表", "视频内容拆解", "音频风格方向", "音频设计清单", "验收标准", "排期与风险"],
    userInputFields: [],
    fillStrategy: ["按默认外包文档结构填充所有生成结果。"],
    referenceStylePlacement: "填入“音频风格方向”。"
  };
}
