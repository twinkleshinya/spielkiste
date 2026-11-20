import {
  TimelineEvent,
  VideoAnalysisResult,
  VideoAnalysisResultSchema,
  VideoContentAnalysisInput,
  VideoContentAnalysisInputSchema
} from "../schemas/index.js";
import { BaseAgent, AgentContext } from "./BaseAgent.js";

export class VideoContentAnalysisAgent extends BaseAgent<VideoContentAnalysisInput, VideoAnalysisResult> {
  readonly name = "VideoContentAnalysisAgent" as const;

  async run(input: VideoContentAnalysisInput, _context: AgentContext): Promise<VideoAnalysisResult> {
    const parsed = VideoContentAnalysisInputSchema.parse(input);
    const videos = parsed.videoManifest.videos.map((video) => {
      const type = video.inferredType === "boss" ? "skill" : video.inferredType;
      if (type === "pv") {
        const duration = video.duration ?? 30;
        const thirds = splitDuration(duration, 3);
        return {
          videoId: video.videoId,
          analysisType: "pv" as const,
          segmentList: thirds.map((range, index) => ({
            startTime: range[0],
            endTime: range[1],
            description: `第 ${index + 1} 段画面需要人工根据缩略图确认镜头内容。`,
            soundNeeds: index === 0 ? ["开场氛围", "角色/场景引入"] : index === 1 ? ["节奏推进", "转场冲击"] : ["收束", "logo 或强调点"],
            confidence: 0.32
          })),
          hitPoints: [makeEvent(thirds[1][0], Math.min(thirds[1][0] + 0.35, duration), "hit_point", "镜头冲击点待确认", "PV 节奏强调", "短促冲击、空气压缩和尾音控制", "high")],
          transitions: [makeEvent(thirds[0][1], Math.min(thirds[0][1] + 0.25, duration), "transition", "转场待确认", "段落切换", "whoosh、反向吸入或材质化转场", "medium")],
          characterMoments: [],
          logoMoments: [makeEvent(Math.max(0, duration - 2), duration, "logo", "片尾标识待确认", "品牌/项目落点", "低频落点、短尾空间和标识性音色", "high")],
          estimatedSfxCount: Math.max(6, Math.ceil(duration / 4)),
          musicMood: "需根据参考包确认音乐情绪；当前建议预留音乐节奏点与音效冲击错位空间。",
          ambienceNeeds: ["根据场景建立低强度环境床，避免覆盖对白/主题音乐。"],
          foleyNeeds: ["角色动作、布料、武器、脚步按镜头可见性补充。"],
          specialSoundDesignNeeds: ["关键转场和 logo 点需要独立声音标识。"]
        };
      }
      if (type === "skill") {
        const duration = video.duration ?? 6;
        const ranges = splitDuration(duration, 4);
        const events = [
          makeEvent(ranges[0][0], ranges[0][1], "cast", "起手/施法动作待人工确认", "技能预备与角色意图", "起手手势、能量聚集或武器摩擦层", "high"),
          makeEvent(ranges[1][0], ranges[1][1], "charge", "蓄力/运动轨迹待人工确认", "能量增长或动作推进", "上升能量层、颗粒运动、轻微低频张力", "high"),
          makeEvent(ranges[2][0], ranges[2][1], "release", "释放瞬间待人工确认", "技能核心释放", "瞬态、空气撕裂、主体材质和短尾空间", "critical"),
          makeEvent(ranges[3][0], ranges[3][1], "hit", "命中/收尾待人工确认", "伤害反馈或动作结束", "低频冲击、材质碎裂、魔法尾音和衰减", "critical")
        ];
        return {
          videoId: video.videoId,
          analysisType: "skill" as const,
          abilityName: video.fileName.replace(/\.[^.]+$/, ""),
          timelineEvents: events,
          castEvents: events.filter((event) => event.eventType === "cast"),
          damageEvents: events.filter((event) => event.eventType === "hit"),
          movementEvents: events.filter((event) => ["charge", "release"].includes(event.eventType)),
          loopEvents: [],
          specialNotes: ["未配置视觉模型时，此分析为可人工补充的时间轴框架。"]
        };
      }
      const duration = video.duration ?? 8;
      return {
        videoId: video.videoId,
        analysisType: "generic" as const,
        timelineEvents: [makeEvent(0, duration, "review_needed", "画面内容待人工补充", "素材类型不确定", "先标注主动作、转场、反馈和收尾", "medium")],
        notes: ["类型不确定，建议人工编辑 video_analysis.json 后 resume。"]
      };
    });
    return VideoAnalysisResultSchema.parse({
      videos,
      generatedAt: new Date().toISOString(),
      requiresHumanReview: true
    });
  }
}

function makeEvent(
  startTime: number,
  endTime: number,
  eventType: string,
  visualDescription: string,
  gameplayMeaning: string,
  suggestedSfxIntent: string,
  priority: TimelineEvent["priority"]
): TimelineEvent {
  return {
    startTime: round(startTime),
    endTime: round(Math.max(endTime, startTime + 0.1)),
    eventType,
    visualDescription,
    gameplayMeaning,
    suggestedSfxIntent,
    priority,
    confidence: 0.35
  };
}

function splitDuration(duration: number, parts: number): Array<[number, number]> {
  const step = duration / parts;
  return Array.from({ length: parts }, (_, index) => [round(index * step), round(index === parts - 1 ? duration : (index + 1) * step)]);
}

function round(value: number): number {
  return Number(value.toFixed(2));
}
