import {
  ReferenceCollectorInput,
  ReferenceCollectorInputSchema,
  ReferencePack,
  ReferencePackSchema
} from "../schemas/index.js";
import { FeishuAdapter } from "../adapters/FeishuAdapter.js";
import { BaseAgent, AgentContext } from "./BaseAgent.js";
import { compactText, splitKeywords, truncate } from "../utils/text.js";

export class ReferenceCollectorAgent extends BaseAgent<ReferenceCollectorInput, ReferencePack> {
  readonly name = "ReferenceCollectorAgent" as const;

  async run(input: ReferenceCollectorInput, context: AgentContext): Promise<ReferencePack> {
    const parsed = ReferenceCollectorInputSchema.parse(input);
    const sources: string[] = [];
    const localTexts: string[] = [];

    const files = [
      ...parsed.referenceFiles,
      ...(parsed.references ? await context.fileAdapter.listReferenceFiles(parsed.references) : [])
    ];
    for (const file of [...new Set(files)]) {
      try {
        const text = file.toLowerCase().endsWith(".json")
          ? JSON.stringify(await context.fileAdapter.readJson(file), null, 2)
          : await context.fileAdapter.readMarkdown(file);
        localTexts.push(`来源 ${file}\n${truncate(text, 2400)}`);
        sources.push(file);
      } catch (error) {
        context.log.warn({ error, file }, "reference file read failed");
      }
    }

    const feishuNotes: string[] = [];
    if (parsed.referenceFeishuDocs.length > 0) {
      const feishu = new FeishuAdapter();
      const availability = await feishu.checkAvailability();
      if (availability.available) {
        for (const docToken of parsed.referenceFeishuDocs) {
          const result = await feishu.getDocumentBlocks(docToken);
          feishuNotes.push(`飞书文档 ${docToken}: ${truncate(result.stdout || result.stderr, 2400)}`);
          sources.push(`feishu:${docToken}`);
        }
      } else {
        feishuNotes.push("配置了 referenceFeishuDocs，但 feishu-tool 不可用，未读取飞书参考资料。");
      }
    }

    const rawText = compactText([
      parsed.projectDescription,
      parsed.requirementText,
      parsed.worldSetting,
      parsed.characterSetting,
      parsed.existingAudioDocs,
      ...localTexts,
      ...feishuNotes
    ]);
    const audioKeywords = splitKeywords(parsed.audioKeywords);
    const competitorReferences = parsed.competitorReferences.map((item) => item.trim()).filter(Boolean);
    const openQuestions: string[] = [];
    if (!parsed.worldSetting && !rawText.match(/世界观|题材|背景|faction|element/i)) openQuestions.push("需要确认世界观、题材和阵营/元素系统。");
    if (!parsed.characterSetting && !rawText.match(/角色|character|职业|weapon/i)) openQuestions.push("需要确认角色、武器、技能命名和性格标签。");
    if (audioKeywords.length === 0) openQuestions.push("需要补充音频风格关键词或反例。");
    if (competitorReferences.length === 0) openQuestions.push("需要补充竞品参考或明确不参考竞品。");

    return ReferencePackSchema.parse({
      projectSummary: truncate(compactText([parsed.projectDescription, parsed.requirementText || rawText], "项目描述待补充。"), 900),
      worldBackground: truncate(parsed.worldSetting || extractLine(rawText, /(世界观|题材|背景|world|setting)/i) || "待补充世界观/题材。", 700),
      characterProfiles: splitKeywords(parsed.characterSetting || extractLine(rawText, /(角色|character|职业|weapon)/i)),
      factionOrElementSystem: splitKeywords(extractLine(rawText, /(阵营|元素|faction|element)/i)),
      emotionalTone: splitKeywords(extractLine(rawText, /(情绪|氛围|tone|mood)/i)),
      visualStyleKeywords: splitKeywords(extractLine(rawText, /(视觉|美术|画面|visual)/i)),
      audioStyleKeywords: audioKeywords.length ? audioKeywords : splitKeywords(extractLine(rawText, /(音频|声音|sonic|audio|sound)/i)),
      competitorReferenceSummary: competitorReferences,
      existingAudioRules: splitKeywords(parsed.existingAudioDocs || extractLine(rawText, /(规范|响度|采样率|命名|loop|循环)/i)),
      reusableTerminology: collectTerms(rawText),
      riskNotes: sources.length === 0 ? ["未提供本地或飞书参考资料，风格判断需要人工复核。"] : [],
      openQuestions,
      confidence: Math.min(0.85, 0.35 + sources.length * 0.1 + audioKeywords.length * 0.03),
      sources
    });
  }
}

function extractLine(text: string, pattern: RegExp): string {
  return text
    .split(/\r?\n/g)
    .find((line) => pattern.test(line))
    ?.replace(/^#+\s*/, "")
    .trim() ?? "";
}

function collectTerms(text: string): string[] {
  const matches = text.match(/[A-Za-z][A-Za-z0-9_-]{2,}|[\u4e00-\u9fa5]{2,8}/g) ?? [];
  return [...new Set(matches)].slice(0, 30);
}
