import type { AudioAsset, SfxRun, SoundEvent, SoundPlacement } from "./models.js";
import { isChargeSustain } from "./AssetIntent.js";
import { round } from "./models.js";
import { edgeFades, planSourceEdit, isCharacterVocal } from "./ClipEdit.js";
import { SFX_WORKFLOW } from "./WorkflowPolicy.js";
import { isOrdinaryFootstep, mixImportance, planPerspective, perspectiveSummary } from "./MixPerspective.js";
export { isCharacterVocal } from "./ClipEdit.js";

export type DuckWindow = { start: number; full: number; hold: number; end: number };
type MixInput = Pick<SfxRun, "duration" | "events" | "assets" | "placements" | "musicEnabled" | "audioOutputMode">;
export function isForeground(event: SoundEvent | undefined, p: SoundPlacement, asset?: Pick<AudioAsset, "fileName">) {
  if (["music","ambience"].includes(p.category) || mixImportance(event,p,asset)==="detail") return false;
  return mixImportance(event,p,asset)==="key" || p.role === "impact" || event?.phase === "contact" && p.category === "impact";
}
function targetLevel(event: SoundEvent | undefined, p: SoundPlacement, asset?: Pick<AudioAsset, "fileName">) {
  const levels=SFX_WORKFLOW.mix.levels;
  if (p.category === "music") return levels.musicBase + (event?.intensity ?? .5) * levels.musicIntensity;
  if (p.category === "ambience") return levels.ambience;
  if (isOrdinaryFootstep(event,asset)) return SFX_WORKFLOW.mix.footsteps.targetRmsDb;
  if (mixImportance(event,p,asset)==="detail") return levels.detail;
  if (isCharacterVocal(event, p, asset)) return levels.vocal;
  if (/warning|telegraph|预警/i.test(event?.type || "")) return levels.warning;
  if (/charge|charging|蓄力|充能/i.test(event?.type || "")) return levels.charge;
  if (event?.actor==="ui" || /^ui_/.test(event?.type || "")) return levels.ui;
  if (isForeground(event, p, asset)) return levels.foreground;
  if (p.category === "whoosh") return levels.whoosh;
  return levels.foley;
}

/** Timing remains visual; decays and level hierarchy are sound-editing decisions. */
export function planAutoMix(run: MixInput,options:{preserveSourceEdits?:boolean;preserveLevels?:boolean;preservePlacementIds?:ReadonlySet<string>}={}) {
  const events = new Map(run.events.map(e => [e.id, e]));
  const assets = new Map(run.assets.map(a => [a.id, a]));
  const placements = structuredClone(run.placements);
  const audible = (p:SoundPlacement) => p.enabled && !events.get(p.eventId)?.muted && (run.audioOutputMode === 'music' ? p.category === 'music' : run.audioOutputMode === 'sfx' ? p.category !== 'music' : p.category !== 'music' || run.musicEnabled !== false);
  const original = new Map(run.placements.map(p => [p.id, p]));
  let extendedTails = 0, naturalTailClips = 0;
  for (const p of placements.filter(p => audible(p) && !p.locked && !events.get(p.eventId)?.locked)) {
    const a = assets.get(p.assetId), event = events.get(p.eventId);
    if (!a || !event) continue;
    const preservePlacement = options.preservePlacementIds?.has(p.id) === true;
    const sustained = ["music", "ambience"].includes(p.category) || isChargeSustain(event) || p.loop;
    const approved = p.sourceEdit?.assetId === p.assetId && p.sourceEdit.sourceOffset === p.sourceOffset && p.sourceEdit.duration === p.duration;
    if (!options.preserveSourceEdits && !preservePlacement && !sustained && !approved) {
      const edit = planSourceEdit(event, p.role, { ...a, onset: p.sourceOffset }, run.duration, p.start);
      if (edit.duration > p.duration + .015) extendedTails++;
      if (edit.duration > event.end - p.start + .015) naturalTailClips++;
      p.duration = edit.duration;
      p.sourceEdit = { assetId:p.assetId,sourceOffset:p.sourceOffset,duration:p.duration,basis:"local-bounded",reason:edit.reason };
    }
    if(!options.preserveLevels && !preservePlacement) {
    const target = targetLevel(event, p, a);
    const footstep=isOrdinaryFootstep(event,a);
    const gain = a.rmsDb === undefined ? footstep ? SFX_WORKFLOW.mix.footsteps.fallbackGainDb : p.category === "music" ? -18 : p.category === "ambience" ? -24 : mixImportance(event,p,a)==="detail" ? -24 : isForeground(event, p, a) ? -9 : -15 : target - a.rmsDb;
    const peakCeiling = footstep ? SFX_WORKFLOW.mix.footsteps.peakCeilingDb : isForeground(event, p, a) ? -6 : -11;
    const baseGain=Math.max(-60, Math.min(6, gain, peakCeiling - (a.peakDb ?? 0)));
    const perspective=planPerspective(event,p,a);
    p.gainDb = round(Math.max(-60,baseGain+perspective.distanceGainDb));
    p.perspective={...perspective,distanceGainDb:round(p.gainDb-baseGain)};
    }
    if(!options.preserveSourceEdits && !preservePlacement)Object.assign(p, edgeFades(p.duration, p.sourceOffset+p.duration < (a.duration ?? Infinity)-.001, p.fadeIn, p.fadeOut));
  }
  const foreground = placements.filter(p => audible(p) && isForeground(events.get(p.eventId), p, assets.get(p.assetId)));
  // Preserve each action, but lower secondary detail during crowded main contacts.
  for (const p of placements.filter(p => audible(p) && !p.locked && !events.get(p.eventId)?.locked && !options.preservePlacementIds?.has(p.id) && !["music", "ambience"].includes(p.category) && !isForeground(events.get(p.eventId), p, assets.get(p.assetId)))) {
    const count = foreground.filter(main => main.start < p.start + p.duration && main.start + Math.min(main.duration, .5) > p.start).length;
    if (!options.preserveLevels && count >= 2) p.gainDb = round(Math.max(-60, p.gainDb - Math.min(8, 3 * Math.log2(count))));
  }
  const windows = foreground.map(p => {
    const phrase = isCharacterVocal(events.get(p.eventId), p, assets.get(p.assetId)) ? Math.min(p.duration, 4) : Math.min(p.duration, .45);
    return { start: Math.max(0, p.start - SFX_WORKFLOW.mix.duck.attackSeconds), full: p.start,
      hold: Math.min(run.duration, p.start + phrase + SFX_WORKFLOW.mix.duck.holdSeconds), end: Math.min(run.duration, p.start + phrase + SFX_WORKFLOW.mix.duck.releaseSeconds) };
  })
    .sort((a,b) => a.start - b.start);
  const ducks: DuckWindow[] = [];
  for (const w of windows) {
    const last = ducks.at(-1);
    if (last && w.start <= last.hold + .08) { last.hold = Math.max(last.hold, w.hold); last.end = Math.max(last.end, w.end); }
    else ducks.push(w);
  }
  let peakConcurrency = 0;
  for (const time of placements.filter(audible).flatMap(p => [p.start, p.start + .01])) {
    peakConcurrency = Math.max(peakConcurrency, placements.filter(p => audible(p) && !["music","ambience"].includes(p.category) && p.start <= time && p.start + p.duration > time).length);
  }
  const perspective=perspectiveSummary({...run,placements:placements.filter(audible)});
  return { placements, ducks, report: { workflow: "sound-aware-distance-priority-duck-v4", extendedTails, naturalTailClips,
    adjustedClips: placements.filter(p => p.gainDb !== original.get(p.id)?.gainDb || p.duration !== original.get(p.id)?.duration).length,
    peakConcurrency, duckWindows: ducks.length, targetLufs: round(SFX_WORKFLOW.mix.targetLufs+perspective.energyReserveDb), truePeakDb: SFX_WORKFLOW.mix.truePeakDb, perspective } };
}

function duckFloor(p: SoundPlacement) {
  return p.category === "music" ? SFX_WORKFLOW.mix.duck.music : p.category === "ambience" ? SFX_WORKFLOW.mix.duck.ambience : ["texture", "tail", "foley"].includes(p.role || p.category) ? SFX_WORKFLOW.mix.duck.detail : 1;
}
export function duckGainAt(p: SoundPlacement, absoluteTime: number, windows: DuckWindow[]) {
  if (p.locked) return 1;
  const floor = duckFloor(p);
  return windows.reduce((gain, w) => {
    if (absoluteTime <= w.start || absoluteTime >= w.end) return gain;
    const envelope = absoluteTime < w.full ? (absoluteTime-w.start)/Math.max(.001,w.full-w.start)
      : absoluteTime <= w.hold ? 1 : (w.end-absoluteTime)/Math.max(.001,w.end-w.hold);
    return Math.min(gain, 1 - (1-floor)*envelope);
  }, 1);
}
export function duckFilter(p: SoundPlacement, windows: DuckWindow[], foreground = false) {
  const floor = duckFloor(p);
  if (p.locked || foreground || floor === 1) return "";
  const overlapping = windows.filter(w => w.start < p.start+p.duration && w.end > p.start);
  const ramps = overlapping.map(w => {
    const [start,full,hold,end] = [w.start,w.full,w.hold,w.end].map(v => round(v-p.start));
    return `if(lt(t,${start}),1,if(lt(t,${full}),1-(1-${floor})*(t-(${start}))/${Math.max(.001,round(full-start))},if(lte(t,${hold}),${floor},if(lt(t,${end}),${floor}+(1-${floor})*(t-(${hold}))/${Math.max(.001,round(end-hold))},1))))`;
  });
  if (!ramps.length) return "";
  const expression = ramps.reduce((a,b) => `min(${a},${b})`);
  return `volume='${expression}':eval=frame`;
}
