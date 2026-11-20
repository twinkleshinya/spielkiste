import type {SoundEvent} from "./models.js";
import {isChargeSustain} from "./AssetIntent.js";

/** An advisory from observed audio text, never a filename veto or proof of audibility. */
export function chargeContinuityAdvice(event:Pick<SoundEvent,"type"|"query"|"actor"|"phase">,layerQuery:string,summary:string,tags:string[]=[]) {
  const removeNegated=(value:string)=>value.replace(/(?:不要|避免|禁止|没有|无明显|无|非|不含)\s*(?:重复瞬态|脉冲|脆裂|咔咔|连发)+|\b(?:without|no)\s+(?:repeated\s+)?(?:pulses?|pulsed|crackl\w*|staccato)\b/gi,"");
  const intent=removeNegated(`${event.query} ${layerQuery}`);
  const intentionalPulse=/脉冲|节奏化|咔咔|连发|\bpuls(?:e|es|ed|ing)\b|\bstaccato\b/i.test(intent);
  const audible=removeNegated([summary,...tags].join(" "));
  const pulseDescription=/多次脉冲|反复脉冲|密集脆裂|连续脆裂|连发|咔咔|\brepeated\s+pulses?\b|\bpulsed\b|\bcrackl\w*\b|\bstaccato\b/i.test(audible);
  const continuousBodyExpected=isChargeSustain(event)&&!intentionalPulse;
  return {continuousBodyExpected,warnings:continuousBodyExpected&&pulseDescription?["持续蓄力需要连续声体，候选片段描述含多次脉冲或脆裂；loop/charge名称不证明声体连续，需试听复核"]:[]};
}
