import path from "node:path";
import {
  AudioReferenceAnalysis,
  AudioReferenceAnalysisInput,
  AudioReferenceAnalysisInputSchema,
  AudioReferenceAnalysisSchema
} from "../schemas/index.js";
import { MossAudioAdapter } from "../adapters/MossAudioAdapter.js";
import { splitKeywords } from "../utils/text.js";
import { AgentContext, BaseAgent } from "./BaseAgent.js";

export class AudioReferenceAnalysisAgent extends BaseAgent<AudioReferenceAnalysisInput, AudioReferenceAnalysis> {
  readonly name = "AudioReferenceAnalysisAgent" as const;

  async run(input: AudioReferenceAnalysisInput, context: AgentContext): Promise<AudioReferenceAnalysis> {
    const parsed = AudioReferenceAnalysisInputSchema.parse(input);
    const adapter = new MossAudioAdapter();
    const availability = await adapter.checkAvailability();
    const files = parsed.audioReferenceFiles.filter(Boolean);
    const prompt = [
      "Analyze this audio as a senior game audio director.",
      "Focus on sonic palette, impact style, transient design, low-frequency usage, magic/energy texture, weapon/material texture, rhythm density, music relationship, mixing space, what to keep, and what to avoid.",
      "Return concise Chinese notes that can guide game audio outsourcing."
    ].join(" ");

    const analyzedFiles =
      parsed.enabled && files.length > 0
        ? await adapter.analyzeAudioFiles(files, prompt)
        : files.map((filePath) => ({
            filePath,
            fileName: path.basename(filePath),
            analysisText: parsed.enabled
              ? `待 MOSS-Audio 分析：${path.basename(filePath)}。${availability.message}`
              : `已上传声音参考但未启用 MOSS-Audio：${path.basename(filePath)}。`,
            confidence: 0.2
          }));

    const keywords = [
      ...parsed.referencePack.audioStyleKeywords,
      ...splitKeywords(parsed.styleText),
      ...splitKeywords(parsed.requirementText)
    ];
    const text = [parsed.styleText, parsed.requirementText, ...analyzedFiles.map((item) => item.analysisText)].join("\n");
    const profile = inferReferenceProfile(text, keywords, files.length, parsed.enabled, availability.message);

    const output = AudioReferenceAnalysisSchema.parse({
      enabled: parsed.enabled,
      adapterAvailable: availability.available,
      analyzedFiles,
      ...profile,
      generatedAt: new Date().toISOString()
    });
    context.log.info({ files: files.length, enabled: parsed.enabled, adapterAvailable: availability.available }, "audio reference analysis complete");
    return output;
  }
}

function inferReferenceProfile(
  text: string,
  keywords: string[],
  fileCount: number,
  enabled: boolean,
  availabilityMessage: string
): Omit<AudioReferenceAnalysis, "enabled" | "adapterAvailable" | "analyzedFiles" | "generatedAt"> {
  const normalized = text.toLowerCase();
  const uniqueKeywords = [...new Set(keywords.map(cleanKeyword).filter(Boolean))].slice(0, 16);
  const hasMagic = hasAny(normalized, ["魔法", "能量", "magic", "元素", "粒子"]);
  const hasWeapon = hasAny(normalized, ["刀", "剑", "枪", "金属", "weapon", "weapon"]);
  const hasUi = hasAny(normalized, ["ui", "界面", "按钮", "点击", "奖励"]);
  const hasPv = hasAny(normalized, ["pv", "宣传片", "转场", "镜头", "logo"]);

  return {
    audioReferenceSummary:
      fileCount > 0
        ? `已收集 ${fileCount} 个声音参考文件。${enabled ? "已尝试调用 MOSS-Audio 进行风格理解。" : "当前未启用 MOSS-Audio，先保留人工补充框架。"}`
        : "未上传声音参考文件；本轮主要依赖需求说明、风格说明和文字参考资料。",
    sonicPalette: uniqueKeywords.length
      ? uniqueKeywords.map((keyword) => `${keyword}：需要落实为具体材质、瞬态、尾音或空间层。`)
      : ["参考音色不足，建议补充 2-5 个正向参考和 1-2 个反向参考。"],
    rhythmAndDensity: hasPv
      ? ["PV 类参考需记录镜头切点密度、转场音效频率和音乐主拍避让关系。"]
      : ["记录参考中每秒主要事件密度，避免把所有动作都做成满编层级。"],
    impactCharacteristics: [
      "拆分瞬态点击、主体冲击、低频短冲、材质破裂和空间尾音，分别判断哪些需要保留。",
      "低频只服务高优先级事件，普通动作保留中高频可读性。"
    ],
    magicOrEnergyTexture: hasMagic
      ? ["提取颗粒感、滤波运动、反向吸入、调制尾音等能量层规则。"]
      : ["未明确能量/魔法参考；如后续涉及技能，需要补充能量层正反例。"],
    weaponOrMaterialTexture: hasWeapon
      ? ["记录金属、空气撕裂、硬质接触、碎裂层的亮度和衰减边界。"]
      : ["未明确武器/材质参考；避免无画面依据地加入重金属或重武器质感。"],
    musicRelationship: hasPv
      ? ["音效贴镜头冲击点，但转场和落点需避让音乐主旋律、鼓点和对白空间。"]
      : ["技能/界面类参考优先同步动作，音乐关系作为空间和情绪辅助。"],
    mixingNotes: [
      "保留混音余量，避免参考分析直接等同于最终响度。",
      "循环和尾音类参考需要单独标记 loop 点、tail 长度和可裁切范围。"
    ],
    keepList: [
      "保留可识别的材质锚点，例如能量颗粒、武器摩擦、UI 短反馈或品牌落点。",
      "保留清楚的主瞬态和动作同步关系。"
    ],
    avoidList: [
      "避开版权不明的竞品原采样、旋律、logo 声纹或可识别音色组合。",
      "避免长混响、持续低频或过密层级遮挡后续动作。"
    ],
    openQuestions: [
      ...(fileCount === 0 ? ["需要上传已有声音参考，才能分析“保留/避让”的具体边界。"] : []),
      ...(enabled && !availabilityMessage.includes("已配置") ? [availabilityMessage] : []),
      ...(hasUi ? ["UI 声音层级需要确认：普通点击、确认、奖励、错误、弹窗是否各自独立。"] : [])
    ]
  };
}

function hasAny(text: string, words: string[]): boolean {
  return words.some((word) => text.includes(word.toLowerCase()));
}

function cleanKeyword(value: string): string {
  return value
    .replace(/^#+\s*/, "")
    .replace(/^[-*]\s*/, "")
    .replace(/：.*$/, "")
    .replace(/:.*$/, "")
    .trim()
    .slice(0, 24);
}
