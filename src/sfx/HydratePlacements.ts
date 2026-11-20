import { SfxRun } from "./models.js";
import { probeAudio } from "./AudioLibraryIndexer.js";

export function reconcilePlacements(run: SfxRun) {
  const assets = new Map(run.assets.map(a => [a.id, a]));
  for (const p of run.placements) {
    const asset = assets.get(p.assetId);
    if (asset?.duration === undefined) continue;
    const maxDuration = Math.floor((asset.duration - p.sourceOffset) * 1000) / 1000;
    if (maxDuration <= 0) { p.enabled = false; p.sourceOffset = 0; p.duration = Math.min(p.duration, asset.duration); }
    else if (!p.loop) p.duration = Math.min(p.duration, maxDuration);
    p.fadeIn = Math.min(p.fadeIn, p.duration / 2);
    p.fadeOut = Math.min(p.fadeOut, p.duration / 2);
  }
}

export async function hydratePlacements(run: SfxRun,options:{preserveEdits?:boolean}={}) {
  const ids = new Set(run.placements.filter(p => p.enabled).map(p => p.assetId));
  for (const asset of run.assets) {
    if (ids.has(asset.id) && asset.duration === undefined) Object.assign(asset, await probeAudio(asset.path));
  }
  // Saved edits are validated by the caller; discovering metadata cannot silently recut them.
  if(!options.preserveEdits)reconcilePlacements(run);
}
