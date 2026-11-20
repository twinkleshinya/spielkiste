import {
  AudioStyleProfile,
  AudioStyleProfileSchema,
  AudioStyleProfilerInput,
  AudioStyleProfilerInputSchema
} from "../schemas/index.js";
import { BaseAgent, AgentContext } from "./BaseAgent.js";
import { splitKeywords } from "../utils/text.js";

export class AudioStyleProfilerAgent extends BaseAgent<AudioStyleProfilerInput, AudioStyleProfile> {
  readonly name = "AudioStyleProfilerAgent" as const;

  async run(input: AudioStyleProfilerInput, _context: AgentContext): Promise<AudioStyleProfile> {
    const parsed = AudioStyleProfilerInputSchema.parse(input);
    const keywords = [
      ...parsed.referencePack.audioStyleKeywords,
      ...(parsed.audioReferenceAnalysis?.sonicPalette ?? []),
      ...splitKeywords(parsed.styleText),
      ...splitKeywords(parsed.requirementText)
    ]
      .map(cleanStyleKeyword)
      .filter(Boolean);
    const uniqueKeywords = [...new Set(keywords)].slice(0, 16);
    const hasMagic = textHas(uniqueKeywords, ["魔法", "能量", "元素", "magic"]);
    const hasWeapon = textHas(`${parsed.requirementText} ${parsed.referencePack.projectSummary}`, ["武器", "刀", "枪", "weapon", "melee"]);
    return AudioStyleProfileSchema.parse({
      worldTone:
        parsed.referencePack.worldBackground === "待补充世界观/题材。"
          ? "世界观信息不足，先采用中性可扩展声音语言，避免过度绑定具体文化乐器或地域符号。"
          : `声音应服务于该世界观：${parsed.referencePack.worldBackground}`,
      sonicPalette: uniqueKeywords.length
        ? uniqueKeywords.map((keyword) => `${keyword}：需要转译为可听的材质、动态或空间特征`)
        : ["中频主体清晰，低频只服务关键命中，尾音按场景空间收束。"],
      characterSonicIdentity: parsed.referencePack.characterProfiles.map((profile) => `${profile}：建立 1-2 个可复用识别层，例如材质层、能量层或动作层。`),
      elementOrFactionSoundRules: parsed.referencePack.factionOrElementSystem.map((item) => `${item}：定义独立瞬态、尾音和质感边界。`),
      magicTexture: hasMagic
        ? "魔法层使用可控颗粒、调制噪声、反向吸入和短尾空间，释放点保留清楚瞬态，避免长尾糊住命中。"
        : "若出现非现实能量，使用轻量颗粒与滤波运动补充，不抢主体动作瞬态。",
      weaponTexture: hasWeapon
        ? "武器层强调起手摩擦、运动 whoosh、命中材质和尾部空气扰动，金属层不宜持续尖锐。"
        : "实体动作以布料、空气、轻材质和接触反馈为主，避免无画面依据的重武器质感。",
      impactStyle: "命中点分为瞬态点击、低频短冲、材质破裂和空间尾音四层；低频只给高优先级事件，尾音不遮挡后续动作。",
      UIStyle: "UI 声音保持短、干净、分级明确；确认/奖励可增加上扬泛音，取消/错误使用更短衰减和较低音高。",
      musicRelationship: "PV 与过场需要先让位音乐节奏，冲击音效贴关键帧但避免每拍都堆满；技能展示以动作同步优先。",
      ambienceDirection: "环境床应低动态、可循环、少瞬态，作为空间和世界质感支撑，不替代关键事件音效。",
      loudnessAndMixingNotes: [
        "默认交付 wav 48kHz/24bit，峰值和响度规范需项目侧最终确认。",
        "重要命中保留混音空间，避免全频持续压满。",
        "循环类资产需要无缝 loop 点和单独 tail 版本。",
        ...(parsed.audioReferenceAnalysis?.mixingNotes ?? [])
      ],
      doList: [
        "为关键事件拆出瞬态、主体、低频、材质、尾音层，便于外包报价和返修。",
        "每个视频标出不确定时间点，交付前由项目侧确认关键帧。",
        "同一角色或元素复用一致的音色锚点。",
        ...(parsed.audioReferenceAnalysis?.keepList ?? [])
      ],
      dontList: [
        "不要用长混响掩盖动作同步。",
        "不要在低优先级动作上堆叠重低频。",
        "不要使用版权不明的竞品采样或音乐片段。",
        ...(parsed.audioReferenceAnalysis?.avoidList ?? [])
      ],
      referenceKeywords: uniqueKeywords,
      openQuestions:
        uniqueKeywords.length === 0
          ? ["需要补充音频风格关键词、竞品或反例。"]
          : [...parsed.referencePack.openQuestions, ...(parsed.audioReferenceAnalysis?.openQuestions ?? [])]
    });
  }
}

function textHas(input: string | string[], words: string[]): boolean {
  const text = Array.isArray(input) ? input.join(" ") : input;
  return words.some((word) => text.toLowerCase().includes(word.toLowerCase()));
}

function cleanStyleKeyword(value: string): string {
  return value
    .replace(/^#+\s*/, "")
    .replace(/^[-*]\s*/, "")
    .replace(/：需要.*$/, "")
    .replace(/: needs.*$/i, "")
    .replace(/本次外包内容为.*$/, "")
    .replace(/示例需求$/, "")
    .replace(/技能视频$/, "")
    .replace(/需要拆分\s*/g, "")
    .trim()
    .slice(0, 24);
}
