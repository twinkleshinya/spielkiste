import type { AudioAsset } from "./models.js";
import { SFX_WORKFLOW } from "./WorkflowPolicy.js";

type Ranked = { asset: AudioAsset; score: number; reason: string };
/** Remove export IDs and take numbers, retaining meaningful material/timbre/stage words. */
export function candidateFamily(asset: Pick<AudioAsset, "fileName">) {
  let name=asset.fileName.replace(/\.[^.]+$/, "").replace(/\[[^\]]*\]/g, part => {
    const label = part.slice(1, -1).trim();
    return /^(?:\d+|[a-f0-9]{8,}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?:\.(?:wem|wav))?$/i.test(label) ? "" : label;
  })
    .replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase().replace(/(?:^|[_\s-])(?:\d+|[a-f0-9]{8,})(?=$|[_\s-])/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if(name.split(" ").length>=4)name=name.replace(/ [a-z]$/," ").trim();
  return name||asset.fileName.toLowerCase();
}
function cosine(a: number[], b: number[]) {
  const aa = a.reduce((s,x)=>s+x*x,0), bb = b.reduce((s,x)=>s+x*x,0);
  return aa > 1e-12 && bb > 1e-12 ? a.reduce((s,x,i)=>s+x*(b[i] || 0),0)/Math.sqrt(aa*bb) : 0;
}
export function similarRecordings(a: AudioAsset, b: AudioAsset) {
  if (candidateFamily(a) === candidateFamily(b)) return true;
  const x = a.acoustics, y = b.acoustics;
  if (!x || !y) return false;
  if (x.fingerprint === y.fingerprint) return true;
  const durationRatio = Math.min(x.activeDuration, y.activeDuration) / Math.max(.001, x.activeDuration, y.activeDuration);
  const policy=SFX_WORKFLOW.candidates;
  return durationRatio > policy.durationSimilarity && cosine(x.bands,y.bands) > policy.bandSimilarity && cosine(x.envelope,y.envelope) > policy.envelopeSimilarity && Math.abs(x.centroid-y.centroid) < policy.centroidDifference;
}
export function diverseCandidates<T extends Ranked>(ranked: T[], limit = 5): T[] {
  const chosen: T[] = [];
  for (const r of ranked) {
    if (chosen.length >= limit) break;
    // Retrieval already excludes unrelated assets. Name-stage penalties remain advice,
    // so a low adjusted score must not veto a useful acoustic exception.
    if (chosen.some(c => similarRecordings(c.asset,r.asset))) continue;
    const reason = r.reason.split(/；(?:首选|不同声音备选)(?=[：，]|$)/u)[0];
    chosen.push({ ...r, reason: `${reason}；${chosen.length ? "不同声音备选" : "首选"}${r.asset.acoustics ? `：${r.asset.acoustics.label}` : "，同系列变体已合并"}` });
  }
  return chosen;
}
