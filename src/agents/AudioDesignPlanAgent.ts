import {
  AudioDesignItem,
  AudioDesignPlan,
  AudioDesignPlanInput,
  AudioDesignPlanInputSchema,
  AudioDesignPlanSchema,
  TimelineEvent
} from "../schemas/index.js";
import { BaseAgent, AgentContext } from "./BaseAgent.js";
import { stableId } from "../utils/ids.js";

export class AudioDesignPlanAgent extends BaseAgent<AudioDesignPlanInput, AudioDesignPlan> {
  readonly name = "AudioDesignPlanAgent" as const;

  async run(input: AudioDesignPlanInput, _context: AgentContext): Promise<AudioDesignPlan> {
    const parsed = AudioDesignPlanInputSchema.parse(input);
    const items: AudioDesignItem[] = [];
    for (const video of parsed.videoAnalysis.videos) {
      if (video.analysisType === "pv") {
        for (const segment of video.segmentList) {
          const assetId = stableId(["PV", video.videoId, segment.startTime, "SEG"]);
          items.push({
            assetId,
            videoId: video.videoId,
            timeRange: { startTime: segment.startTime, endTime: segment.endTime },
            assetType: "sfx",
            designIntent: `支撑 PV 段落：${segment.description}`,
            soundDescription: `按镜头内容配置 ${segment.soundNeeds.join("、")}；冲击点使用短瞬态和受控低频，转场使用方向性 whoosh 或反向吸入，尾音避让音乐主拍。`,
            layerSuggestion: ["镜头切点瞬态", "材质化转场层", "低强度空间/氛围层", "必要拟音层"],
            priority: "high",
            complexity: "medium",
            estimatedWorkload: "0.5-1.0 人日",
            deliveryFormat: "wav 48kHz/24bit",
            namingConvention: "PV_{Project}_{Scene}_{HitPoint}_{Layer}_v001.wav",
            reviewCriteria: ["关键帧同步误差不超过 2 帧", "不遮挡音乐主旋律或对白", "转场方向感与画面运动一致"]
          });
        }
      } else {
        for (const event of video.timelineEvents) {
          items.push(eventToDesignItem(video.videoId, event, parsed.audioStyleProfile.impactStyle));
        }
      }
    }
    return AudioDesignPlanSchema.parse({
      items,
      summary: `共生成 ${items.length} 条音频资产/实现项，需外包团队据视频帧确认最终时间点。`,
      openQuestions: parsed.videoAnalysis.requiresHumanReview ? ["视频内容分析为无 VLM 的框架结果，制作前需要人工确认事件时间轴。"] : []
    });
  }
}

function eventToDesignItem(videoId: string, event: TimelineEvent, impactStyle: string): AudioDesignItem {
  const assetType = event.eventType.includes("ui") ? "ui" : "sfx";
  const complexity = event.priority === "critical" ? "high" : event.priority === "high" ? "medium" : "low";
  const layers = getLayers(event.eventType);
  return {
    assetId: stableId(["SFX", videoId, event.eventType, event.startTime]),
    videoId,
    timeRange: { startTime: event.startTime, endTime: event.endTime },
    assetType,
    designIntent: `${event.gameplayMeaning}：${event.suggestedSfxIntent}`,
    soundDescription: `${event.eventType} 需要贴合 ${event.visualDescription}。制作上包含 ${layers.join("、")}。${event.eventType === "hit" ? impactStyle : "尾音长度根据下一个动作留白控制。"}`,
    layerSuggestion: layers,
    priority: event.priority,
    complexity,
    estimatedWorkload: complexity === "high" ? "0.75-1.5 人日" : complexity === "medium" ? "0.4-0.8 人日" : "0.2-0.4 人日",
    deliveryFormat: "wav 48kHz/24bit",
    namingConvention: "SFX_{Character}_{Skill}_{Phase}_{Variation}_v001.wav",
    reviewCriteria: [
      "与标注时间点同步，关键瞬态贴主要视觉帧。",
      "层次可辨认，主体动作、低频和尾音不互相糊成一团。",
      "符合项目音色方向，没有版权风险素材。"
    ]
  };
}

function getLayers(eventType: string): string[] {
  const map: Record<string, string[]> = {
    cast: ["轻瞬态起手", "能量预热", "动作材质"],
    charge: ["上升调制层", "颗粒运动", "低频张力"],
    release: ["空气撕裂", "主体释放瞬态", "短尾空间"],
    hit: ["低频冲击", "材质碎裂", "魔法/能量尾音", "空间反射"],
    transition: ["反向吸入", "方向性 whoosh", "切点点击"],
    logo: ["品牌瞬态", "短低频落点", "干净尾音"]
  };
  return map[eventType] ?? ["主体动作层", "辅助材质层", "可控尾音"];
}
