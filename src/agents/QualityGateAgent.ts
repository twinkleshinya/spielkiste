import {
  QaChecklist,
  QaChecklistSchema,
  QualityGateInput,
  QualityGateInputSchema
} from "../schemas/index.js";
import { BaseAgent, AgentContext } from "./BaseAgent.js";

export class QualityGateAgent extends BaseAgent<QualityGateInput, QaChecklist> {
  readonly name = "QualityGateAgent" as const;

  async run(input: QualityGateInput, _context: AgentContext): Promise<QaChecklist> {
    const parsed = QualityGateInputSchema.parse(input);
    return QaChecklistSchema.parse({
      deliveryFormat: parsed.deliveryFormat,
      globalCriteria: [
        "文件命名符合命名规范，包含版本号 v001/v002。",
        `交付格式符合 ${parsed.deliveryFormat}，无损坏、无多余静音头。`,
        "关键瞬态与画面时间点同步，技能命中/释放类误差不超过 2 帧。",
        "loop 类资产循环点无缝，必要时提供 loop 与 tail 两个版本。",
        "尾音长度符合动作节奏，不遮挡下一事件。",
        "层次包含主体、材质、低频/空间等必要信息，但给音乐和对白留混音空间。",
        "动态范围适合游戏内混音，不使用过度砖墙限制。",
        "素材来源清晰，无竞品采样、商业曲库违规和版权风险。"
      ],
      perAssetCriteria: parsed.audioDesignPlan.items.map((item) => ({
        assetId: item.assetId,
        criteria: item.reviewCriteria,
        riskNotes:
          item.complexity === "high"
            ? ["高复杂度资产建议拆层交付或至少提供 stem，方便项目侧混音调整。"]
            : []
      }))
    });
  }
}
