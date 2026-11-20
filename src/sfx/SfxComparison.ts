import type { SfxRun, SoundPlacement } from "./models.js";

export type SelectionMethod = {
  kind: "local-rule" | "gemini" | "unknown";
  label: string;
  model: string;
  detail: string;
};

export type ComparisonAsset = {
  assetId: string;
  fileName: string;
  relativePath: string;
  start: number;
  duration: number;
  gainDb: number;
  reason: string;
};

export type PlacementComparison = {
  key: string;
  eventId: string;
  event: {
    description: string;
    type: string;
    category: string;
    start: number;
    end: number;
  };
  role: string;
  layerId: string;
  local?: ComparisonAsset;
  gemini?: ComparisonAsset;
  changeType: "same" | "changed" | "local-only" | "gemini-only";
  timingChanged: boolean;
  reason: string;
};

export type ComparisonRun = {
  id: string;
  name: string;
  createdAt: string;
  duration: number;
  videoPath: string;
  libraryPath: string;
  previewAvailable: boolean;
  analysisModel: string;
  selection: SelectionMethod;
};

export type SfxComparison = {
  generatedAt: string;
  local: ComparisonRun;
  gemini: ComparisonRun;
  source: {
    sameVideo: boolean;
    sameLibrary: boolean;
    sameEventTimeline: boolean;
    eventCount: { local: number; gemini: number };
    videoAnalysisModel: string;
  };
  stats: {
    localEnabledPlacements: number;
    geminiEnabledPlacements: number;
    localActionCoverage: number;
    geminiActionCoverage: number;
    actionEvents: number;
    musicEvents: number;
    ambienceEvents: number;
    changedSelections: number;
    unchangedSelections: number;
    localOnlySelections: number;
    geminiOnlySelections: number;
    changedTimings: number;
    localDistinctAssets: number;
    geminiDistinctAssets: number;
  };
  rows: PlacementComparison[];
  evaluation: {
    local: { strengths: string[]; weaknesses: string[]; bestFor: string };
    gemini: { strengths: string[]; weaknesses: string[]; bestFor: string };
    recommended: string;
  };
};

export function describeSelection(run: SfxRun): SelectionMethod {
  if (run.selectionReport?.model) {
    return {
      kind: "gemini",
      label: "Gemini 音频选材",
      model: run.selectionReport.model,
      detail: `本地规则先缩小候选，再分析 ${run.selectionReport.analyzedAssets} 份音频片段并重排。`
    };
  }
  if (run.assets.length || run.events.length) {
    return {
      kind: "local-rule",
      label: "本地规则选材",
      model: "无独立音频模型",
      detail: "AudioLibraryIndexer.search + 文件名/目录名/动作阶段规则排序，候选由本地确定。"
    };
  }
  return { kind: "unknown", label: "未知选材方式", model: "未知", detail: "运行记录没有足够的选材元数据。" };
}

export function compareRuns(local: SfxRun, gemini: SfxRun): SfxComparison {
  const localSelection = describeSelection(local);
  const geminiSelection = describeSelection(gemini);
  const geminiEvents = new Map(gemini.events.map(event => [event.id, event]));
  const events = new Map([...local.events, ...gemini.events].map(event => [event.id, event]));
  const localPlacements = activePlacements(local);
  const geminiPlacements = activePlacements(gemini);
  const localMap = groupPlacements(localPlacements);
  const geminiMap = groupPlacements(geminiPlacements);
  const keys = [...new Set([...localMap.keys(), ...geminiMap.keys()])].sort((a, b) => {
    const ea = events.get(a.split("::")[0]);
    const eb = events.get(b.split("::")[0]);
    return (ea?.start ?? 0) - (eb?.start ?? 0) || a.localeCompare(b);
  });
  const rows = keys.map(key => {
    const [eventId, layerId, role] = key.split("::");
    const event = events.get(eventId) || { id: eventId, description: "未知事件", type: "unknown", category: "other", start: 0, end: 0 };
    const localPlacement = localMap.get(key)?.[0];
    const geminiPlacement = geminiMap.get(key)?.[0];
    const localAsset = localPlacement ? toComparisonAsset(local, localPlacement, localReason(local, localPlacement), "规则候选") : undefined;
    const geminiAsset = geminiPlacement ? toComparisonAsset(gemini, geminiPlacement, geminiSelectionReason(gemini, eventId, layerId), "Gemini 选材") : undefined;
    const assetSame = Boolean(localAsset && geminiAsset && localAsset.assetId === geminiAsset.assetId);
    const timingChanged = Boolean(localPlacement && geminiPlacement && (
      Math.abs(localPlacement.start - geminiPlacement.start) > 0.005 ||
      Math.abs(localPlacement.duration - geminiPlacement.duration) > 0.005
    ));
    const changeType = !localAsset ? "gemini-only" : !geminiAsset ? "local-only" : assetSame && !timingChanged ? "same" : "changed";
    return {
      key,
      eventId,
      event: { description: event.description, type: event.type, category: event.category, start: event.start, end: event.end },
      role,
      layerId,
      local: localAsset,
      gemini: geminiAsset,
      changeType,
      timingChanged,
      reason: geminiSelectionReason(gemini, eventId, layerId) || "Gemini 未提供该层的单独说明。"
    } satisfies PlacementComparison;
  });
  const actionEvents = [...events.values()].filter(event => !["music", "ambience"].includes(event.category));
  const localCovered = new Set(localPlacements.filter(placement => placement.category !== "music").map(placement => placement.eventId));
  const geminiCovered = new Set(geminiPlacements.filter(placement => placement.category !== "music").map(placement => placement.eventId));
  const sameTimeline = local.events.length === gemini.events.length && local.events.every(event => {
    const other = geminiEvents.get(event.id);
    return Boolean(other && Math.abs(event.start - other.start) <= 0.005 && Math.abs(event.end - other.end) <= 0.005 && event.type === other.type);
  });
  return {
    generatedAt: new Date().toISOString(),
    local: toComparisonRun(local, localSelection),
    gemini: toComparisonRun(gemini, geminiSelection),
    source: {
      sameVideo: pathEqual(local.videoPath, gemini.videoPath),
      sameLibrary: pathEqual(local.libraryPath, gemini.libraryPath),
      sameEventTimeline: sameTimeline,
      eventCount: { local: local.events.length, gemini: gemini.events.length },
      videoAnalysisModel: local.analysisReport?.model || gemini.analysisReport?.model || local.analysisMode
    },
    stats: {
      localEnabledPlacements: localPlacements.length,
      geminiEnabledPlacements: geminiPlacements.length,
      localActionCoverage: localCovered.size,
      geminiActionCoverage: geminiCovered.size,
      actionEvents: actionEvents.length,
      musicEvents: [...events.values()].filter(event => event.category === "music").length,
      ambienceEvents: [...events.values()].filter(event => event.category === "ambience").length,
      changedSelections: rows.filter(row => row.changeType === "changed").length,
      unchangedSelections: rows.filter(row => row.changeType === "same").length,
      localOnlySelections: rows.filter(row => row.changeType === "local-only").length,
      geminiOnlySelections: rows.filter(row => row.changeType === "gemini-only").length,
      changedTimings: rows.filter(row => row.timingChanged).length,
      localDistinctAssets: new Set(localPlacements.map(placement => placement.assetId)).size,
      geminiDistinctAssets: new Set(geminiPlacements.map(placement => placement.assetId)).size
    },
    rows,
    evaluation: {
      local: {
        strengths: ["速度快、成本低、结果可复现", "文件名和目录命名规范时定位直接", "适合全库批量初筛和离线运行"],
        weaknesses: ["只理解文件名/目录和阶段规则，无法真正判断音频听感", "容易把 chargeatk、charge_loop、charge_guard 等相近命名混在一起", "素材命名混乱时需要人工改检索词"],
        bestFor: "命名规范、候选量很大、需要稳定批处理的项目"
      },
      gemini: {
        strengths: ["能比较实际音频片段的持续性、脉冲、频段、扫频和能量", "能在同一动作阶段的候选中按听感重排", "适合命名不稳定、同名素材较多的本地库"],
        weaknesses: ["速度更慢，需要把候选片段发送到 CC Switch 网关", "声学描述仍可能误判材质或用途，不能替代试听", "候选范围过大时会增加耗时和模型调用量"],
        bestFor: "候选音色接近、命名不可靠、需要比较真实听感的动作层"
      },
      recommended: "本地规则负责阶段和语义初筛，Gemini 只在有限候选内比较实际声音，关键蓄力、预警、命中保留本地保底并人工试听确认。"
    }
  };
}

function toComparisonRun(run: SfxRun, selection: SelectionMethod): ComparisonRun {
  return {
    id: run.id,
    name: run.name,
    createdAt: run.createdAt,
    duration: run.duration,
    videoPath: run.videoPath,
    libraryPath: run.libraryPath,
    previewAvailable: Boolean(run.render?.video),
    analysisModel: run.analysisReport?.model || run.analysisMode,
    selection
  };
}

function activePlacements(run: SfxRun): SoundPlacement[] {
  return run.placements.filter(placement => placement.enabled && (placement.category !== "music" || run.musicEnabled !== false));
}

function groupPlacements(placements: SoundPlacement[]) {
  const groups = new Map<string, SoundPlacement[]>();
  for (const placement of placements) {
    const key = `${placement.eventId}::${placement.layerId || "default"}::${placement.role || ""}`;
    const list = groups.get(key) || [];
    list.push(placement);
    groups.set(key, list);
  }
  return groups;
}

function toComparisonAsset(run: SfxRun, placement: SoundPlacement, reason: string | undefined, fallbackReason: string): ComparisonAsset {
  const asset = run.assets.find(item => item.id === placement.assetId);
  return {
    assetId: placement.assetId,
    fileName: asset?.fileName || placement.assetId,
    relativePath: asset?.relativePath || asset?.path || placement.assetId,
    start: placement.start,
    duration: placement.duration,
    gainDb: placement.gainDb,
    reason: reason || fallbackReason
  };
}

function localReason(run: SfxRun, placement: SoundPlacement): string | undefined {
  const event = run.events.find(item => item.id === placement.eventId);
  const layer = event?.layers?.find(item => item.id === placement.layerId);
  return layer?.candidates.find(item => item.assetId === placement.assetId)?.reason;
}

function geminiSelectionReason(run: SfxRun, eventId: string, layerId: string): string | undefined {
  const decision = run.selectionReport?.decisions.find(item => item.taskId === `${eventId}:${layerId}` || item.eventIds.includes(eventId));
  return decision?.reason;
}

function pathEqual(a: string, b: string): boolean {
  return a.trim().replaceAll("/", "\\").toLowerCase() === b.trim().replaceAll("/", "\\").toLowerCase();
}
