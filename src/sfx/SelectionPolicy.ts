import type { SoundEvent } from "./models.js";
import { SFX_WORKFLOW } from "./WorkflowPolicy.js";

/** Use model time on perceptually important or similarly ranked filename candidates. */
export function selectReviewEvents(events: SoundEvent[], scope: "selective" | "full") {
  const unlocked = events.filter(e => !e.locked);
  if (scope === "full") return unlocked;
  const key = (event: SoundEvent) => ["music", "impact"].includes(event.category) || /^ui_|charge|cast|warning|telegraph|roar|预警|蓄力|施法/.test(event.type)
    || /张嘴.*(?:咆哮|吼)|发出.*(?:咆哮|吼)/.test(event.description);
  const ambiguous = unlocked.filter(event => {
    if (key(event)) return false;
    const layers = event.layers?.length ? event.layers : [{ candidates: event.candidates }];
    return layers.some(layer => {
      const [first, second] = layer.candidates;
      return first && second && Math.abs(first.score - second.score) <= Math.max(1, Math.abs(first.score) * .15);
    });
  }).sort((a,b) => a.confidence-b.confidence || a.start-b.start).slice(0,SFX_WORKFLOW.selection.ambiguousEvents);
  const reviewIds = new Set(ambiguous.map(e => e.id));
  return unlocked.filter(e => key(e) || reviewIds.has(e.id));
}
