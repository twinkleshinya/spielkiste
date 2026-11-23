import { AudioLibraryIndexer } from "./AudioLibraryIndexer.js";
import { AudioLibraryIndex, SoundEvent } from "./models.js";
import { LayerPlanner } from "./LayerPlanner.js";
import { assetNameAdvice, isChargeSustain, isLoopAsset } from "./AssetIntent.js";
import { diverseCandidates } from "./CandidateDiversity.js";
import { SFX_WORKFLOW } from "./WorkflowPolicy.js";
import {keywordPreferencesFor,preferredSearchQuery} from "./LibraryPreferences.js";
import {eligibleAssets} from "./AssetExclusions.js";

/** Populate semantic candidates for every event while keeping ambience as its own layer. */
export function planEventCandidates(event: SoundEvent, index: AudioLibraryIndex) {
  if (event.evidence?.startsWith("密集帧未确认接触")) { event.layers = []; event.candidates = []; return event; }
  const indexer = new AudioLibraryIndexer();
  const planner = new LayerPlanner();
  event.layers = planner.planLayers(event);
  for (const layer of event.layers) {
    const ui = event.actor === "ui" || /^ui_|warning|telegraph/.test(event.type);
    if (ui && !/\bui\b/.test(layer.query)) layer.query = `ui ${layer.query}`;
    if (/warning|telegraph|预警/.test(`${event.type} ${event.description}`)) layer.query = "ui warning";
    if (ui && /charge.*(?:tier|level)|(?:tier|level).*charge/.test(event.type)) layer.query = "ui skilllevel countup";
    if (event.actor === "player" && /charge/.test(event.type) && !ui) layer.query = `gsword charge ${layer.query}`;
    if (event.actor === "player" && /jump|sword|slash|swing/.test(event.type) && layer.role !== "texture" && layer.role !== "tail") layer.query = `gsword ${layer.query}`;
    const explicitKeyword=keywordPreferencesFor(event,index.keywordPreferences).length>0;
    layer.query=preferredSearchQuery(layer.query,event,index.keywordPreferences);
    if (/chest.?pound|chest.?beat/.test(event.type) && event.actor === "boss" && layer.role === "impact") layer.query = "chestpound";
    const eligible = index.assets;
    const rank = (results: ReturnType<AudioLibraryIndexer["search"]>) => results.map(r => {
      const advice = assetNameAdvice(event, layer.role, r.asset);
      return { ...r, score: Math.max(.001, r.score + advice.score), reason: `${r.reason}${advice.warnings.length ? `；${advice.warnings.join("；")}` : ""}` };
    }).sort((a,b) => b.score-a.score);
    let results = rank(indexer.search(index, layer.query, 30,event));
    if (isChargeSustain(event)) {
      results.sort((a, b) => {
        const quality = (name: string, loop: boolean) => (loop ? 16 : 0) + (!explicitKeyword && /common|_com_|katana/.test(name) ? 8 : 0);
        return quality(b.asset.fileName, isLoopAsset(b.asset)) - quality(a.asset.fileName, isLoopAsset(a.asset)) || b.score - a.score;
      });
      const beds = rank(indexer.search({ ...index, assets: eligible.filter(isLoopAsset) }, "charge loop", 30,event));
      const full = explicitKeyword ? [] : rank(indexer.search(index, "gsword com charge", 15,event)).filter(r => /_com_charge(?:\W|_)/.test(r.asset.fileName));
      results = [...new Map([...full.slice(0, 1), ...beds.slice(0, 2), ...results].map(r => [r.asset.id, r])).values()].slice(0, 5);
    }
    layer.candidates = diverseCandidates(results, 5).map(c => ({
      assetId: c.asset.id,
      score: c.score,
      reason: c.reason
    }));
  }
  // A decorative layer needs its own material, never three copies of one hit.
  const used = new Set<string>();
  for (const layer of event.layers) {
    layer.candidates = layer.candidates.filter(c => !used.has(c.assetId));
    if (layer.candidates[0]) used.add(layer.candidates[0].assetId);
  }
  event.candidates = event.layers.flatMap(layer => layer.candidates).slice(0, 5);
  return event;
}

export function planAllEventCandidates(events: SoundEvent[], index: AudioLibraryIndex) {
  const planned = events.map(event => planEventCandidates(event, index));
  return applyDensityBudget(planned);
}

/** Yield between events so large-library ranking cannot freeze status requests. */
export async function planAllEventCandidatesResponsive(events:SoundEvent[],index:AudioLibraryIndex,signal?:AbortSignal,progress?:(message:string)=>void) {
  for(let i=0;i<events.length;i++) {
    signal?.throwIfAborted();
    progress?.(`匹配本地素材：${i+1}/${events.length} · ${events[i].description}`);
    await new Promise<void>(resolve=>setImmediate(resolve));
    planEventCandidates(events[i],index);
  }
  return applyDensityBudget(events);
}

function applyDensityBudget(planned:SoundEvent[]) {
  const denseBossContacts = planned.filter(event => {
    const text = `${event.actor || ""} ${event.type} ${event.description} ${event.query}`;
    return event.category === "impact" && (event.actor === "boss" || /ape|gorilla|猩猩|巨猿|boss/i.test(text)) && (event.phase === "contact" || /impact|slam|pound|hit|砸|捶|命中/i.test(text));
  }).sort((a, b) => a.start - b.start);
  for (const event of denseBossContacts) {
    if (!event.layers?.length) continue;
    const primary = event.layers.find(layer => layer.role === "impact") || event.layers[0];
    const secondary = event.layers.find(layer => layer !== primary && (layer.role === "tail" || layer.role === "texture"));
    event.layers = [primary, ...(secondary ? [secondary] : [])].slice(0, 1 + SFX_WORKFLOW.mix.density.bossSecondaryLayers);
    event.candidates = event.layers.flatMap(layer => layer.candidates).slice(0, 8);
  }
  for (let i = 1; i < denseBossContacts.length; i++) {
    const previous = denseBossContacts[i - 1], current = denseBossContacts[i];
    if (current.start - previous.start < SFX_WORKFLOW.mix.density.consecutiveBossGapSeconds && current.layers?.length) {
      current.layers = current.layers.filter(layer => layer.role !== "texture" && layer.role !== "tail");
      current.candidates = current.layers.flatMap(layer => layer.candidates).slice(0, 8);
    }
  }
  return planned;
}

/** Revalidate persisted picks without discarding valid previous material choices. */
export function repairEventCandidates(event: SoundEvent, index: AudioLibraryIndex) {
  if (event.locked) return;
  if (!event.layers?.length) { planEventCandidates(event, index); return; }
  const assets = new Map(eligibleAssets(index.assets,index).map(a => [a.id, a]));
  for (const layer of event.layers) layer.candidates = layer.candidates.filter(c => {
    const asset = assets.get(c.assetId);
    return asset?.usable;
  });
  if (event.layers.some(l => !l.candidates.length)) {
    const replenished = structuredClone(event);
    planEventCandidates(replenished, index);
    for (const layer of event.layers) if (!layer.candidates.length) layer.candidates = replenished.layers?.find(l => l.id === layer.id)?.candidates || [];
  }
  event.candidates = event.layers.flatMap(l => l.candidates).slice(0, 8);
}
