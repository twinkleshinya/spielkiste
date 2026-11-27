import { randomUUID } from "node:crypto";
import { SoundEvent, SoundLayer } from "./models.js";
import { SFX_WORKFLOW } from "./WorkflowPolicy.js";

export class LayerPlanner {
  planLayers(event: SoundEvent): SoundLayer[] {
    if (event.layers?.length) return event.layers;
    const query = event.query || event.description;
    const text = `${event.type} ${event.description} ${query}`;
    const boss = event.actor === "boss" || /ape|gorilla|猩猩|巨猿|boss/i.test(text);
    const modestContact = /land|foot|(?:^|_)step(?:_|$)|chest.?pound|chest.?beat/.test(event.type) || event.intensity !== undefined && event.intensity < .5;
    if (event.category === "impact" && modestContact) return [{ id: randomUUID(), role: "impact", query, offset: 0, candidates: [] }];
    if (event.category === "music") return [{ id: randomUUID(), role: "music", query: `music ${query}`, offset: 0, candidates: [] }];
    if (event.category === "impact") {
      const main: SoundLayer = { id: randomUUID(), role: "impact", query: `${query} impact`, offset: 0, candidates: [] };
      // Boss contacts must read as one clear hit. Add only one secondary layer,
      // and reserve it for a material cue that is visible in the action.
      if (boss) {
        if (/debris|rubble|fragment|shatter|碎石|碎屑|飞石|飞溅|崩裂|崩碎/i.test(`${event.description} ${query} ${event.evidence || ''}`)) {
          const tail: SoundLayer = { id: randomUUID(), role: "tail", query: "rock debris tail", offset: .12, candidates: [] };
          return [main, tail].slice(0, 1 + SFX_WORKFLOW.mix.density.bossSecondaryLayers);
        }
        return [main];
      }
      if (/rock|stone|ground|earth|石|地/i.test(query)) return [main, { id: randomUUID(), role: "tail", query: "rock debris tail", offset: .18, candidates: [] }];
      if (/sword|metal|刀|剑/i.test(query)) return [main, { id: randomUUID(), role: "texture", query: "metal spark", offset: .08, candidates: [] }];
      return [main, { id: randomUUID(), role: "tail", query: "impact tail resonance", offset: .18, candidates: [] }];
    }
    if (event.category === "ambience") return [{ id: randomUUID(), role: "ambience", query, offset: 0, candidates: [] }];
    return [{ id: randomUUID(), role: event.category === "whoosh" ? "whoosh" : "foley", query, offset: 0, candidates: [] }];
  }
}
