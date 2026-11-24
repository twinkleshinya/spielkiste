import { AudioAsset, AudioLibraryIndex, SoundEvent } from "./models.js";
import { probeAudio } from "./AudioLibraryIndexer.js";
import { runFfmpeg } from "./FfmpegBinaries.js";
import {eligibleAssets,filterEventCandidates} from "./AssetExclusions.js";

/** Measure a shortlisted file without changing any event's candidate ranking. */
export async function inspectAudioCandidate(asset: AudioAsset, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!asset.usable) return false;
  if (asset.rmsDb !== undefined && asset.onset !== undefined && asset.duration !== undefined) return true;
  try {
    if (asset.duration === undefined) Object.assign(asset, await probeAudio(asset.path));
    const { stderr } = await runFfmpeg(["-hide_banner", "-nostats", "-i", asset.path, "-t", "40", "-vn", "-ac", "1", "-ar", "12000", "-af", "silencedetect=noise=-50dB:d=0.015,volumedetect", "-f", "null", "-"], { maxBuffer: 2 * 1024 * 1024, cancelSignal: signal });
    const mean = /mean_volume:\s*(-?inf|[-\d.]+)/.exec(stderr)?.[1];
    const peak = /max_volume:\s*(-?inf|[-\d.]+)/.exec(stderr)?.[1];
    const rmsDb = mean === "-inf" ? -100 : Number(mean), peakDb = peak === "-inf" ? -100 : Number(peak);
    if (!Number.isFinite(rmsDb) || !Number.isFinite(peakDb)) throw new Error("无法测量音频电平");
    if (peakDb < -65) throw new Error("候选音频为静音或电平过低");
    const silenceStart = /silence_start:\s*([\d.]+)/.exec(stderr);
    const silenceEnd = /silence_end:\s*([\d.]+)/.exec(stderr);
    asset.onset = silenceStart && Number(silenceStart[1]) < .02 && silenceEnd ? Math.max(0, Number(silenceEnd[1]) - .008) : 0;
    asset.peakDb = peakDb; asset.rmsDb = rmsDb; delete asset.warning;
    return true;
  } catch (error) {
    signal?.throwIfAborted(); asset.usable = false; asset.warning = `候选检查失败：${String(error instanceof Error ? error.message : error).slice(0, 220)}`; return false;
  }
}

/** Decode shortlisted assets only; the complete local library remains a filename index. */
export async function prepareCandidates(events: SoundEvent[], index: AudioLibraryIndex, progress: (message: string) => void = () => {}, signal?: AbortSignal) {
  filterEventCandidates(events,index.assets,index);
  const byId = new Map(eligibleAssets(index.assets,index).map(a => [a.id, a]));
  const checked = new Map<string, Promise<boolean>>();
  let count = 0;
  const check = (asset: AudioAsset): Promise<boolean> => {
    if (checked.has(asset.id)) return checked.get(asset.id)!;
    const promise = (async () => {
      signal?.throwIfAborted();
      try {
        return await inspectAudioCandidate(asset, signal);
      } finally { progress(`检查所选音频：已检查 ${++count} 个文件的时长、起音和电平`); }
    })();
    checked.set(asset.id, promise); return promise;
  };
  const musicEvents = events.filter(e => e.category === "music");
  let music: AudioAsset | undefined;
  for (const candidate of musicEvents.flatMap(e => e.candidates).filter((c, i, all) => all.findIndex(a => a.assetId === c.assetId) === i).slice(0, 15)) {
    const asset = byId.get(candidate.assetId);
    if (asset && await check(asset) && (asset.duration ?? 0) >= 8) { music = asset; break; }
  }
  for (const event of musicEvents) {
    if (music) {
      const selected = { assetId: music.id, score: event.candidates.find(c => c.assetId === music!.id)?.score ?? 1, reason: "本地音乐文件名匹配，连续使用同曲；已检查非静音与音量，音乐风格需试听复核" };
      event.candidates = [selected, ...event.candidates.filter(c => c.assetId !== music!.id)];
      for (const layer of event.layers || []) layer.candidates = [...event.candidates];
    } else { event.candidates = []; for (const layer of event.layers || []) layer.candidates = []; }
  }
  const actions = events.filter(e => e.category !== "music");
  for (let i = 0; i < actions.length; i += 3) {
    const results = await Promise.allSettled(actions.slice(i, i + 3).map(async event => {
      const used = new Set<string>();
      for (const layer of event.layers || []) {
        let selected: string | undefined;
        for (const candidate of layer.candidates) {
          const asset = byId.get(candidate.assetId);
          if (asset && !used.has(asset.id) && await check(asset)) { selected = asset.id; used.add(asset.id); break; }
        }
        layer.candidates = selected ? layer.candidates.filter(c => byId.get(c.assetId)?.usable && (!used.has(c.assetId) || c.assetId === selected)) : [];
        if (selected) layer.candidates.sort((a, b) => Number(b.assetId === selected) - Number(a.assetId === selected));
      }
      event.candidates = (event.layers || []).flatMap(l => l.candidates).slice(0, 8);
    }));
    for (const result of results) if (result.status === "rejected") throw result.reason;
  }
}
