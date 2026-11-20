import { randomUUID } from "node:crypto";
import { EventSchema, Scene, SoundEvent } from "./models.js";
import { LayerPlanner } from "./LayerPlanner.js";

export function buildEventTimeline(input: { duration: number; scenes: Scene[] }, options: { includeReviewEvents?: boolean; previous?: SoundEvent[] } = {}): SoundEvent[] {
  const planner = new LayerPlanner(); const previous = new Map((options.previous || []).map(event => [event.id, event]));
  const events: SoundEvent[] = [];
  const ambience: SoundEvent = EventSchema.parse({ id: "ambience-0", start: 0, end: input.duration, type: "ambience", description: "全片环境层：待确认空间、天气和环境声", query: "ambience environment", category: "ambience", confidence: 0, source: "scene", candidates: [], requiresHumanReview: true, layers: [] });
  ambience.layers = planner.planLayers(ambience);
  const lockedAmbience = previous.get(ambience.id);
  if (lockedAmbience?.locked) { ambience.start = lockedAmbience.start; ambience.end = lockedAmbience.end; ambience.locked = true; ambience.layers = lockedAmbience.layers || ambience.layers; }
  events.push(ambience);
  input.scenes.forEach((scene, i) => {
    if (i === 0) return;
    const event = EventSchema.parse({ id: `transition-${i}`, start: scene.start, end: Math.min(input.duration, scene.start + .7), type: "transition", description: `镜头变化 ${i}：待确认运动、冲击或转场声音`, query: "whoosh transition", category: "whoosh", confidence: .25, source: "scene", candidates: [], requiresHumanReview: true, layers: [] });
    const locked = previous.get(event.id); if (locked?.locked) { event.start = locked.start; event.end = locked.end; event.locked = true; event.layers = locked.layers; }
    event.layers = event.layers?.length ? event.layers : planner.planLayers(event); events.push(event);
  });
  if (!options.includeReviewEvents) return [ambience];
  return events;
}
