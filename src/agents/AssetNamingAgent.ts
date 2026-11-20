import {
  AssetNamingInput,
  AssetNamingInputSchema,
  AssetNamingRules,
  AssetNamingRulesSchema
} from "../schemas/index.js";
import { BaseAgent, AgentContext } from "./BaseAgent.js";
import { normalizeTerm } from "../utils/text.js";

export class AssetNamingAgent extends BaseAgent<AssetNamingInput, AssetNamingRules> {
  readonly name = "AssetNamingAgent" as const;

  async run(input: AssetNamingInput, _context: AgentContext): Promise<AssetNamingRules> {
    const parsed = AssetNamingInputSchema.parse(input);
    const terms = parsed.audioDesignPlan.items.map((item) => ({
      source: item.assetId,
      normalized: normalizeTerm(item.assetId)
    }));
    return AssetNamingRulesSchema.parse({
      projectName: parsed.projectName,
      rules: [
        {
          category: "角色/技能音效",
          pattern: "SFX_{Character}_{Skill}_{Phase}_{Variation}_v001.wav",
          example: `SFX_Character_Skill_Release_A_v001.wav`,
          notes: ["Phase 使用 cast/charge/release/hit/loop/end 等固定词。"]
        },
        {
          category: "PV 声音设计",
          pattern: "PV_{Project}_{Scene}_{HitPoint}_{Layer}_v001.wav",
          example: `PV_${normalizeTerm(parsed.projectName)}_Opening_HP01_Impact_v001.wav`,
          notes: ["Layer 使用 Impact/Whoosh/Foley/Ambience/Logo 等。"]
        },
        {
          category: "UI 音效",
          pattern: "UI_{Menu}_{Action}_{State}_v001.wav",
          example: "UI_Main_Confirm_Default_v001.wav",
          notes: ["State 可用 Default/Hover/Disabled/Reward/Error。"]
        }
      ],
      normalizedTerms: terms
    });
  }
}
