import type { AudioAsset, SoundEvent } from "./models.js";

const token = (text: string, words: string) => new RegExp(`(?:^|[^a-z])(?:${words})(?:[^a-z]|$)`, "i").test(text);
export function isChargeSustain(event: Pick<SoundEvent, "type" | "query" | "phase" | "actor">) {
  return event.actor !== "ui" && event.phase === "sustain" && /charge|charging|蓄力|充能/i.test(`${event.type} ${event.query}`);
}
export function isLoopAsset(asset: Pick<AudioAsset, "fileName">) { return token(asset.fileName, "loop|hold|sustain") || /循环|持续/.test(asset.fileName); }

/** The explicit visual phase outranks words mentioned incidentally in the description. */
export function actionNameStage(event: Pick<SoundEvent, "type" | "query" | "phase" | "description" | "category">) {
  if (["music", "ambience"].includes(event.category)) return "neutral";
  const phase = event.phase?.toLowerCase() || "";
  const type = event.type.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  if (/preparation|prepare|windup/.test(phase)) return "start";
  if (/sustain|hold/.test(phase)) return "sustain";
  if (token(type, "recover|recovery|end|finish|aftermath") || /收势|收招|攻击结束|施法结束|恢复待机|收刀/.test(event.description || "")) return "end";
  if (/contact|motion/.test(phase)) return "active";
  if (token(type, "cast|casting") || /施法/.test(event.description || "")) return "cast";
  // Aftermath alone can also be a reaction or debris; require evidence of actual recovery.
  return "neutral";
}

/** Advisory name compatibility; a false result is evidence for review, never a veto. */
export function fitsAssetIntent(event: Pick<SoundEvent, "type" | "query" | "phase" | "actor" | "category"> & Partial<Pick<SoundEvent, "description">>, role: string, asset: Pick<AudioAsset, "fileName" | "relativePath">) {
  const name = asset.fileName.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  if (!["music", "ambience"].includes(event.category)) {
    const stage = actionNameStage({ ...event, description: event.description || "" });
    const starts = token(name, "start(?:\\d+)?|begin|windup|prepare|ready") || /开始|起手|起势|起音|准备/.test(name);
    const ends = token(name, "end(?:\\d+)?|finish|recover|recovery|stop") || /结束|收势|收招|停止/.test(name);
    if (stage === "end" && starts && !ends) return false;
    if ((stage === "start" || stage === "sustain") && ends && !starts) return false;
    const explicitCast = token(event.type, "cast|casting") || /(?:^|_)cast(?:_|$)/i.test(event.type) || /施法/.test(event.description || "");
    const warning = event.actor === "ui" || /^ui_|warning|telegraph|预警/.test(`${event.type} ${event.description || ""}`);
    if (explicitCast && !warning && !["texture", "tail"].includes(role) && !token(name, "cast|casting|spellcast") && !/施法/.test(name)) return false;
  }
  if (/^ui_(?:scroll|select|button_hide|appear|parry_prompt)$/.test(event.type) && /gold|loot|reward|item.?drop|coin|金币|掉落/.test(name)) return false;
  if (isChargeSustain(event)) {
    return /charge|charging|蓄力|充能/.test(name)
      && !/chargesuc|chargefail|chargeend|chargeatk|chargestrike|chargeattack|charge_attack|chargeshot|shieldcharge|recharge|staminacharge|tackle|spinningcharger/.test(name)
      && !token(name, "impact|hit|hits|guard|shot|shoot|cast|attack|atk|success|done|end|fail|jump|swish|whoosh|vo")
      && !/命中|格挡|挥舞|爆炸|子弹|发力|完成|结束|成功|失败/.test(name);
  }
  if (role === "impact" && /whoosh|swish|挥舞/.test(name) && !/impact|hit|smash|slam|命中|砸地/.test(name)) return false;
  if (role === "whoosh" && /impact|命中|砸地/.test(name) && !/whoosh|swish|挥舞/.test(name)) return false;
  return true;
}

/** Prefer action/stage names locally while leaving acoustic judgement free to override. */
export function assetNameAdvice(event: Parameters<typeof fitsAssetIntent>[0], role: string, asset: Parameters<typeof fitsAssetIntent>[2]) {
  const name = asset.fileName.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  const stage = actionNameStage({ ...event, description: event.description || "" });
  const warnings: string[] = [];
  let score = 0;
  if (!fitsAssetIntent(event, role, asset)) { score -= 18; warnings.push("名称可能与动作阶段或声音意图不符，可根据实际声音选择并说明理由"); }
  if (stage === "end" && (token(name, "end(?:\\d+)?|finish|recover|stop") || /结束|收势|收招/.test(name))) score += 5;
  if (stage === "start" && (token(name, "start(?:\\d+)?|begin|prepare|ready|windup") || /开始|准备|起手/.test(name))) score += 5;
  if ((token(event.type, "cast|casting") || /施法/.test(event.description || "")) && (token(name, "cast|casting|spellcast") || /施法/.test(name))) score += 5;
  if (isChargeSustain(event) && isLoopAsset(asset) && /charge|charging|蓄力|充能/i.test(name)) score += 8;
  if (event.category === "foley" && event.phase !== "contact" && !/land|foot|chest.?pound|chest.?beat|hit|impact|debris|rubble/.test(event.type)
    && (token(name, "impact|hit|smash|slam|land|chargesuc|chargeend") || /命中|落地|砸地/.test(name))) {
    score -= 15; warnings.push("普通动作拟音候选名称偏命中或落地，注意是否过重");
  }
  return { score, warnings, compatible: warnings.length === 0 };
}
