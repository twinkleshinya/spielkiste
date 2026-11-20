import type { AudioAsset, SoundEvent, SoundPlacement } from "./models.js";
import { SFX_WORKFLOW } from "./WorkflowPolicy.js";

type EventIntent = Pick<SoundEvent, "type" | "category" | "description" | "start" | "end"> & Partial<Pick<SoundEvent, "phase" | "actor" | "query">>;
type ClipIntent = Pick<SoundPlacement, "category"> & Partial<Pick<SoundPlacement, "role">>;
type Source = Pick<AudioAsset, "fileName"> & Partial<Pick<AudioAsset, "duration" | "onset" | "acoustics">>;

/** Voice classification uses the selected recording as well as the current visible action. */
export function isCharacterVocal(event: Partial<EventIntent> | undefined, p: ClipIntent, asset?: Pick<AudioAsset, "fileName">) {
  if (["music", "ambience"].includes(p.category) || p.role === "texture" || p.role === "tail") return false;
  if (/(?:^|[^a-z])(?:vo|voice|vocal|roar|growl|grunt|scream)(?:[^a-z]|$)|吼叫|咆哮|怒吼|嘶吼/i.test(asset?.fileName || "")) return true;
  if (/roar|growl|vocal|scream|吼叫|咆哮|怒吼/i.test(event?.type || "")) return true;
  return p.role !== "impact" && p.category !== "impact" && /张嘴.*(?:咆哮|吼)|发出.*(?:咆哮|吼)|正在(?:咆哮|吼)/.test(event?.description || "")
    && !/咆哮后|吼叫后|怒吼后/.test(event?.description || "");
}

/** Micro fades avoid a discontinuity at a cut without smearing the action's attack. */
export function edgeFades(duration: number, cropped = true, fadeIn = 0, fadeOut = 0) {
  const minIn = Math.min(SFX_WORKFLOW.editing.fadeInSeconds, duration / 4), minOut = Math.min(SFX_WORKFLOW.editing.fadeOutSeconds, duration / 3);
  const max = duration / 3;
  return { fadeIn: Math.min(max, Math.max(minIn, fadeIn)), fadeOut: Math.min(max, Math.max(minOut, fadeOut)) };
}

/** Preserve a decay, not an unrelated continuation of the recording. No rate/pitch changes. */
export function planSourceEdit(event: EventIntent, role: string | undefined, asset: Source, videoDuration: number, start = event.start) {
  const roundDown = (value: number) => Math.floor((value + 1e-9) * 1000) / 1000;
  const loop = /(?:^|[^a-z])(?:loop|hold|sustain)(?:[^a-z]|$)|循环|持续/i.test(asset.fileName);
  const bed = ["music", "ambience"].includes(event.category) || event.actor !== "ui" && event.phase === "sustain" && /charge|charging|蓄力|充能/i.test(`${event.type} ${event.query || ""}`);
  const canLoop = ["music", "ambience"].includes(event.category) || bed && loop;
  const sourceOffset = Math.max(0, Math.min(asset.onset || 0, Math.max(0, (asset.duration ?? 1) - .01)));
  const available = Math.max(0, (asset.duration ?? Infinity) - sourceOffset);
  const intended = Math.max(.001, event.end - start);
  const vocal = isCharacterVocal(event, { category: event.category, role: role as SoundPlacement["role"] }, asset);
  const transient = !vocal && (event.category === "impact" || role === "impact" || role === "tail" || role === "texture" || event.phase === "contact" || /^ui_/.test(event.type));
  let length: number, reason: string;
  if (asset.duration === undefined) { length=intended; reason="素材时长尚未测量，先保留画面区间供复核"; }
  else if (bed || loop) { length = intended; reason = "持续声音跟随画面保持区间"; }
  else if (vocal) { length = Math.min(available, intended + Math.min(SFX_WORKFLOW.editing.vocalReleaseSeconds, intended * .35)); reason = "按可见发声区间保留短释放，避免播放后续不相关吼声"; }
  else if (transient) {
    const measuredEnd = asset.acoustics?.energyEnd;
    length = measuredEnd === undefined ? Math.min(available, Math.max(1.5, intended + 2)) : Math.max(.04, measuredEnd - sourceOffset + .06);
    length = Math.min(length, available, Math.max(3, intended + .5));
    reason = measuredEnd === undefined ? "接触瞬态保留有界衰减，待试听复核" : "接触瞬态保留测得的有效衰减尾音";
  } else { length = Math.min(available, intended + SFX_WORKFLOW.editing.movementReleaseSeconds); reason = "动作拟音跟随画面并保留短释放"; }
  const duration = Math.max(0, roundDown(Math.min(length, videoDuration - start, canLoop ? Infinity : available)));
  const fades = edgeFades(duration, duration + .001 < available);
  return { sourceOffset, duration, ...fades, reason, loop: Boolean(canLoop && sourceOffset + duration > (asset.duration ?? Infinity)) };
}
