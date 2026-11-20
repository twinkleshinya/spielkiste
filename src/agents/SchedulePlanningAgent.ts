import path from "node:path";
import {
  SchedulePlan,
  SchedulePlanningInput,
  SchedulePlanningInputSchema,
  SchedulePlanSchema
} from "../schemas/index.js";
import { BaseAgent, AgentContext } from "./BaseAgent.js";
import { FeishuAdapter } from "../adapters/FeishuAdapter.js";
import { addDays, formatDate } from "../utils/text.js";

export class SchedulePlanningAgent extends BaseAgent<SchedulePlanningInput, SchedulePlan> {
  readonly name = "SchedulePlanningAgent" as const;

  async run(input: SchedulePlanningInput, context: AgentContext): Promise<SchedulePlan> {
    const parsed = SchedulePlanningInputSchema.parse(input);
    const items = parsed.audioDesignPlan.items;
    const people = parsed.schedule.outsourcingPeople ?? 1;
    const workUnits = items.reduce((sum, item) => sum + (item.complexity === "high" ? 1.4 : item.complexity === "medium" ? 0.8 : 0.4), 0);
    const productionDays = Math.max(3, Math.ceil(workUnits / people) + 2);
    const start = parsed.schedule.startDate ? new Date(parsed.schedule.startDate) : new Date();
    const due = parsed.schedule.dueDate ? new Date(parsed.schedule.dueDate) : addDays(start, productionDays + 6);
    const span = Math.max(7, Math.ceil((due.getTime() - start.getTime()) / 86400000));
    const milestones = [
      { name: "素材确认", offset: 0, deliverables: ["视频清单", "参考包", "时间轴确认"] },
      { name: "初版", offset: Math.round(span * 0.35), deliverables: ["高优先级资产初版", "PV/技能关键点样音"] },
      { name: "内部反馈", offset: Math.round(span * 0.48), deliverables: ["反馈清单", "返修范围确认"] },
      { name: "二版", offset: Math.round(span * 0.68), deliverables: ["全量资产二版", "loop/tail 检查"] },
      { name: "终版", offset: Math.round(span * 0.86), deliverables: ["全量 wav", "命名校验"] },
      { name: "入库", offset: Math.round(span * 0.94), deliverables: ["入库文件夹", "版本记录"] },
      { name: "验收", offset: span, deliverables: ["验收表", "遗留问题列表"] }
    ].map((milestone) => ({
      name: milestone.name,
      date: formatDate(addDays(start, milestone.offset)),
      owner: milestone.name === "内部反馈" || milestone.name === "验收" ? "项目侧音频负责人" : "外包团队",
      deliverables: milestone.deliverables,
      notes: milestone.name === "二版" ? ["已包含返修 buffer。"] : []
    }));

    const taskCreation = { attempted: false, supported: false, message: "未创建飞书任务。", taskResults: [] as unknown[] };
    if (!parsed.dryRun && process.env.FEISHU_AUTH_TYPE === "user") {
      const feishu = new FeishuAdapter();
      const availability = await feishu.checkAvailability();
      if (availability.available) {
        const tasksPath = path.join(context.runDir, "feishu_tasks.json");
        await context.fileAdapter.writeJson(tasksPath, { milestones });
        const result = await feishu.createTasks(tasksPath);
        taskCreation.attempted = true;
        taskCreation.supported = result.exitCode === 0;
        taskCreation.message = result.exitCode === 0 ? "已请求创建飞书任务。" : "飞书任务创建失败，详见命令结果。";
        taskCreation.taskResults = [result];
      }
    } else if (process.env.FEISHU_AUTH_TYPE !== "user") {
      taskCreation.message = "当前认证模式不是 user，任务/成员能力可能不可用；如需自动创建任务，请设置 FEISHU_AUTH_TYPE=user。";
    }

    return SchedulePlanSchema.parse({
      milestones,
      taskCreation,
      assumptions: [
        `按 ${items.length} 条资产、${people} 名外包人员估算，复杂资产已增加时间权重。`,
        "Boss、大招、PV 镜头冲击点和高优先级技能应优先制作并先审。"
      ]
    });
  }
}
