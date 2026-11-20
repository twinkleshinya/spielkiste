import {
  DocumentModel,
  DocumentModelSchema,
  ReviewAndPolishInput,
  ReviewAndPolishInputSchema
} from "../schemas/index.js";
import { BaseAgent, AgentContext } from "./BaseAgent.js";
import { markdownToBlocks } from "../renderers/MarkdownRenderer.js";

export class ReviewAndPolishAgent extends BaseAgent<ReviewAndPolishInput, DocumentModel> {
  readonly name = "ReviewAndPolishAgent" as const;

  async run(input: ReviewAndPolishInput, _context: AgentContext): Promise<DocumentModel> {
    const parsed = ReviewAndPolishInputSchema.parse(input);
    const risks = [
      ...parsed.documentModel.riskAndOpenQuestions,
      ...parsed.referencePack.openQuestions,
      ...parsed.audioDesignPlan.openQuestions
    ];
    const reviewNotes = [
      "",
      "## 总编审稿备注",
      "- 所有低置信度视频时间轴需要制作前二次确认。",
      "- 模糊词已尽量转译为层次、瞬态、低频、尾音、空间和动态范围等制作语言。",
      "- 外包报价前建议锁定最终视频版本、命名词表、交付采样率/位深和返修轮次。"
    ];
    const openQuestionBlock =
      risks.length > 0 ? ["", "## 待确认问题汇总", ...[...new Set(risks)].map((risk) => `- ${risk}`)] : [];
    const markdown = [parsed.documentModel.markdown.trim(), ...reviewNotes, ...openQuestionBlock].join("\n");
    return DocumentModelSchema.parse({
      ...parsed.documentModel,
      markdown,
      blocks: markdownToBlocks(markdown),
      riskAndOpenQuestions: [...new Set(risks)]
    });
  }
}
