import { randomUUID } from "node:crypto";
import { AudioAsset, SoundEvent, SoundPlacement, round } from "./models.js";
import { isChargeSustain, isLoopAsset } from "./AssetIntent.js";
import { planSourceEdit } from "./ClipEdit.js";
import {eligibleAssets,type AssetExclusions} from "./AssetExclusions.js";

export function createPlacements(events: SoundEvent[], assets: AudioAsset[], videoDuration: number,exclusions:AssetExclusions={}): SoundPlacement[] {
  const ordered = [...events].sort((a, b) => a.start - b.start);
  const assetById = new Map(eligibleAssets(assets,exclusions).map(a => [a.id, a]));
  let musicAnchor = 0, previousMusic: { end: number; assetId: string } | undefined;
  return ordered.flatMap(event => (event.layers?.length ? event.layers : [{ id: "default", role: event.category === "impact" ? "impact" : event.category, query: event.query, offset: 0, candidates: event.candidates }]).flatMap(layer => {
    const asset = layer.candidates.map(c => assetById.get(c.assetId)).find(a => a?.usable);
    if (!asset?.usable) return [];
    const start = event.start + layer.offset;
    const music = event.category === "music";
    const sustained = music || event.category === "ambience" || isChargeSustain(event) && isLoopAsset(asset);
    let sourceOffset = Math.min(asset.onset ?? 0, Math.max(0, (asset.duration ?? 1) - .01));
    if (music) {
      if (!previousMusic || previousMusic.assetId !== asset.id || Math.abs(previousMusic.end - event.start) > .3) musicAnchor = event.start;
      sourceOffset = (event.start - musicAnchor + sourceOffset) % (asset.duration ?? 1e9);
      previousMusic = { end: event.end, assetId: asset.id };
    }
    const hasNextCue = music && ordered.some(e => e.category === "music" && Math.abs(e.start - event.end) < .05);
    const edit = planSourceEdit(event, layer.role, asset, videoDuration, start);
    const intended = event.end - start + (hasNextCue ? .18 : 0);
    const duration = music ? Math.floor(Math.min(intended, videoDuration - start) * 1000) / 1000 : edit.duration;
    if (duration <= 0) return [];
    const role = ["ambience", "music", "foley", "impact", "whoosh", "texture", "tail"].includes(layer.role) ? layer.role as never : undefined;
    const target = music ? -30 + (event.intensity ?? .5) * 7 : event.category === "ambience" ? -33 : layer.role === "texture" || layer.role === "tail" ? -27 : event.category === "impact" ? -19 : /charge/.test(event.type) ? -24 : -23;
    const gainDb = asset.rmsDb !== undefined ? round(Math.max(-35, Math.min(9, target - asset.rmsDb, -3 - (asset.peakDb ?? 0)))) : music ? -17 + (event.intensity ?? .5) * 6 : layer.role === "ambience" ? -18 : -6;
    return [{ id: randomUUID(), eventId: event.id, layerId: layer.id, role, locked: Boolean(event.locked), assetId: asset.id, start: round(start), duration, sourceOffset: round(sourceOffset), gainDb, fadeIn: Math.min(music ? (start === musicAnchor ? .65 : .18) : event.category === "ambience" ? .3 : edit.fadeIn, duration / 3), fadeOut: Math.min(music ? hasNextCue ? .18 : event.musicStage === "exit" ? duration * .7 : .8 : event.category === "ambience" ? .5 : edit.fadeOut, duration / 3), category: event.category, enabled: true, ...(sustained && asset.duration !== undefined && sourceOffset + duration > asset.duration ? { loop: true } : {}) }];
  }));
}

