import {
  AnalysisPlan,
  AnalysisPlanSchema,
  RequirementUnderstandingInput,
  RequirementUnderstandingInputSchema
} from "../schemas/index.js";
import { BaseAgent, AgentContext } from "./BaseAgent.js";

const RULES: Record<string, string[]> = {
  skill: ["cast", "charge", "release", "hit", "damage", "buff", "debuff", "loop", "end", "movement", "impact", "whoosh", "magic", "weapon"],
  pv: ["画面段落", "转场", "镜头冲击点", "logo", "角色出场", "节奏点", "音效数量", "音乐", "氛围", "拟音", "特殊设计"],
  ui: ["点击", "确认", "取消", "弹窗", "奖励", "转场", "循环", "反馈层级"],
  cutscene: ["镜头段落", "叙事节奏", "情绪变化", "拟音", "环境", "音乐关系"],
  boss: ["蓄力", "范围预警", "释放", "命中", "弱点", "阶段转换", "大招", "怒气", "破防"]
};

export class RequirementUnderstandingAgent extends BaseAgent<RequirementUnderstandingInput, AnalysisPlan> {
  readonly name = "RequirementUnderstandingAgent" as const;

  async run(input: RequirementUnderstandingInput, _context: AgentContext): Promise<AnalysisPlan> {
    const parsed = RequirementUnderstandingInputSchema.parse(input);
    const text = `${parsed.requirementText}\n${parsed.referencePack.projectSummary}`.toLowerCase();
    const typeCounts = new Map<string, number>();
    for (const video of parsed.videoManifest.videos) {
      typeCounts.set(video.inferredType, (typeCounts.get(video.inferredType) ?? 0) + 1);
    }
    for (const [key, words] of Object.entries({
      skill: ["skill", "技能", "角色技能"],
      pv: ["pv", "角色 pv", "宣传", "trailer"],
      ui: ["ui", "界面", "按钮"],
      boss: ["boss", "首领", "大招"],
      cutscene: ["过场", "剧情", "cutscene"]
    })) {
      if (words.some((word) => text.includes(word))) typeCounts.set(key, (typeCounts.get(key) ?? 0) + 2);
    }
    const sorted = [...typeCounts.entries()].filter(([key]) => key !== "unknown").sort((a, b) => b[1] - a[1]);
    const projectType = sorted.length > 1 && sorted[0][1] === sorted[1][1] ? "mixed" : ((sorted[0]?.[0] as AnalysisPlan["projectType"]) ?? "unknown");
    return AnalysisPlanSchema.parse({
      projectType,
      perTypeRules: RULES,
      videoPlans: parsed.videoManifest.videos.map((video) => ({
        videoId: video.videoId,
        inferredType: video.inferredType,
        focus: RULES[video.inferredType] ?? RULES.skill,
        notes: video.inferredType === "unknown" ? ["类型不确定，先按通用事件框架拆分，等待人工确认。"] : []
      })),
      openQuestions: projectType === "unknown" ? ["需要确认本次外包类型：技能、PV、UI、Boss、过场或混合。"] : []
    });
  }
}
