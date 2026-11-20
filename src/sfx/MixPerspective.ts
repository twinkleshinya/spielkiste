import type { AudioAsset, SoundEvent, SoundPlacement, SfxRun } from "./models.js";
import { round } from "./models.js";
import { isCharacterVocal } from "./ClipEdit.js";
import { SFX_WORKFLOW } from "./WorkflowPolicy.js";

type Importance = "key" | "support" | "detail";
export function isScreenOrBed(event: SoundEvent | undefined, p: Pick<SoundPlacement,"category">) {
  return ["music","ambience"].includes(p.category) || /^(?:ui|hud)$/i.test(event?.actor || "") || /^(?:ui|hud)_/i.test(event?.type || "");
}
export function trustedDistance(distance: SoundEvent["distance"]) {
  return distance && distance.range !== "unknown" && distance.confidence >= SFX_WORKFLOW.mix.perspective.minConfidence && distance.evidence.trim() ? distance : undefined;
}
export function mixImportance(event: SoundEvent | undefined, p: SoundPlacement, asset?: Pick<AudioAsset,"fileName">): Importance {
  if (p.role === "texture" || p.role === "tail") return "detail";
  // A mislabeled minor layer must not bury an actual vocal warning or held charge.
  if (isCharacterVocal(event,p,asset) || /warning|telegraph|charge|charging|预警|蓄力|充能/i.test(event?.type || "")) return "key";
  if (event?.importance) return event.importance;
  if (/footstep|footfall|debris|rubble|pebble|dust|recover_stance|weapon_handling|脚步|碎屑/i.test(event?.type || "")) return "detail";
  return "support";
}
export function planPerspective(event: SoundEvent, p: SoundPlacement, asset?: Pick<AudioAsset,"fileName">): NonNullable<SoundPlacement["perspective"]> {
  const importance=mixImportance(event,p,asset),distance=trustedDistance(event.distance);
  const basis=isScreenOrBed(event,p)?"exempt":distance?"visual":"unknown";
  const range=basis==="visual"?distance!.range:"unknown";
  const config=SFX_WORKFLOW.mix.perspective;
  return {version:1,range,importance,basis,distanceGainDb:basis==="visual"&&range!=="unknown"?round(config.distanceDb[range]*config.importanceScale[importance]):0};
}

/** Reserve the energy lost to distance; a master gain must not bring an all-far scene back to near loudness. */
export function perspectiveSummary(run: Pick<SfxRun,"duration"|"events"|"assets"|"placements"|"musicEnabled">) {
  const events=new Map(run.events.map(e=>[e.id,e])),assets=new Map(run.assets.map(a=>[a.id,a]));
  let actualEnergy=0,referenceEnergy=0,knownClips=0,attenuatedClips=0,unknownClips=0,exemptClips=0,lockedClips=0;
  for(const p of run.placements.filter(p=>p.enabled&&!events.get(p.eventId)?.muted&&(p.category!=="music"||run.musicEnabled!==false))) {
    const event=events.get(p.eventId),spatial=p.perspective;
    if(p.locked||event?.locked)lockedClips++;
    const exempt=isScreenOrBed(event,p);
    if(exempt)exemptClips++;
    else if(spatial?.basis==="visual"){knownClips++;if(spatial.distanceGainDb<0)attenuatedClips++;}
    else unknownClips++;
    const reduction=!exempt&&spatial?.basis==="visual"?spatial.distanceGainDb:0;
    const energy=Math.max(0,Math.min(p.duration,run.duration-p.start))*10**(((assets.get(p.assetId)?.rmsDb??-24)+p.gainDb)/10);
    actualEnergy+=energy;referenceEnergy+=energy*10**(-reduction/10);
  }
  const energyReserveDb=actualEnergy>0&&referenceEnergy>0?round(Math.min(0,10*Math.log10(actualEnergy/referenceEnergy))):0;
  return {workflow:"visual-distance-priority-v1" as const,knownClips,attenuatedClips,unknownClips,exemptClips,lockedClips,energyReserveDb,baseTargetLufs:SFX_WORKFLOW.mix.targetLufs};
}
