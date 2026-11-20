import { z } from "zod";
import { CategorySchema, DistanceSchema, ImportanceSchema, type Scene, type SoundEvent, type SoundPlacement } from "./models.js";
import { round } from "./models.js";

/** Result returned by the timing-only Gemini request. */
export const EventTimingResultSchema = z.object({
  start: z.number().finite().nonnegative(),
  end: z.number().finite().positive(),
  confidence: z.number().finite().min(0).max(1),
  evidence: z.string().max(2000),
  timingPrecision: z.number().finite().positive().optional()
}).refine(value => value.end > value.start, "重新定位的结束时间必须大于开始时间");
export type EventTimingResult = z.infer<typeof EventTimingResultSchema>;

/** A candidate returned when a user describes a missing sound without giving a time. */
export const DescribedEventResultSchema = z.object({
  start: z.number().finite().nonnegative(),
  end: z.number().finite().positive(),
  type: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(2000),
  query: z.string().trim().max(2000).default(""),
  category: CategorySchema,
  confidence: z.number().finite().min(0).max(1),
  evidence: z.string().max(2000),
  actor: z.string().max(200).optional(),
  phase: z.string().max(100).optional(),
  timingPrecision: z.number().finite().positive().optional(),
  distance: DistanceSchema.optional(),
  importance: ImportanceSchema.optional()
}).refine(value => value.end > value.start, "描述式补声事件的结束时间必须大于开始时间");
export type DescribedEventResult = z.infer<typeof DescribedEventResultSchema>;

export const DescribedEventsResultSchema = z.object({
  events: z.array(DescribedEventResultSchema).max(60)
});
export type DescribedEventsResult = z.infer<typeof DescribedEventsResultSchema>;

/** A timing-only provider. It must not select audio or mutate a run. */
export interface EventTimingProvider {
  locateEvent(scenes: Scene[], prompt: string, signal?: AbortSignal): Promise<unknown>;
  locateEvents?(scenes: Scene[], prompt: string, signal?: AbortSignal): Promise<unknown>;
}

/**
 * Move one event and the clips attached to it while preserving the selected
 * recordings, source offsets, levels, perspective and edge fades.
 */
export function applyEventTiming(
  event: SoundEvent,
  placements: SoundPlacement[],
  timing: EventTimingResult & { description?: string },
  videoDuration: number
) {
  const start = round(timing.start);
  const end = round(timing.end);
  if (start < 0 || end > videoDuration + .001 || end <= start) throw new Error("重新定位结果超出视频范围");
  const nextEvent: SoundEvent = structuredClone({
    ...event,
    start,
    end,
    description: timing.description?.trim() || event.description,
    confidence: timing.confidence,
    evidence: timing.evidence,
    timingPrecision: timing.timingPrecision,
    source: "vision" as const,
    requiresHumanReview: timing.confidence < .8
  });
  const delta = start - event.start;
  const nextPlacements = placements.map(placement => {
    if (placement.eventId !== event.id) return structuredClone(placement);
    const maxStart = Math.max(0, videoDuration - placement.duration);
    const movedStart = round(Math.min(maxStart, Math.max(0, placement.start + delta)));
    let duration = placement.duration;
    if (nextEvent.category === "music" || nextEvent.category === "ambience") {
      duration = round(Math.max(.001, Math.min(nextEvent.end - movedStart, videoDuration - movedStart)));
    }
    const next = structuredClone({ ...placement, start: movedStart, duration });
    if (duration !== placement.duration) {
      next.fadeIn = Math.min(next.fadeIn, duration / 3);
      next.fadeOut = Math.min(next.fadeOut, duration / 3);
      if (next.sourceEdit) next.sourceEdit.duration = duration;
    }
    return next;
  });
  return { event: nextEvent, placements: nextPlacements };
}
