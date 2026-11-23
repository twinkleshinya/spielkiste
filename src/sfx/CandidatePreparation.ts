import type { AudioAsset, AudioLibraryIndex, CandidateSchema, SoundEvent } from "./models.js";
import type { z } from "zod";
import { AudioLibraryIndexer } from "./AudioLibraryIndexer.js";
import { AudioCandidateClips } from "./AudioCandidateClips.js";
import { diverseCandidates } from "./CandidateDiversity.js";
import { assetNameAdvice } from "./AssetIntent.js";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { SFX_WORKFLOW } from "./WorkflowPolicy.js";
import {eligibleAssets,filterEventCandidates} from "./AssetExclusions.js";

type Candidate = z.infer<typeof CandidateSchema>;
const clips = new AudioCandidateClips();
/** Failed or duplicate recordings must not consume the valid shortlist budget. */
export async function measureDiverseShortlist<T extends {asset:AudioAsset;score:number;reason:string}>(source:T[],outputDir:string,signal?:AbortSignal) {
  const attempted=new Set<string>();
  let pool=diverseCandidates(source.filter(r=>r.asset.usable),SFX_WORKFLOW.candidates.measuredFamilies);
  while(pool.some(r=>!attempted.has(r.asset.id))) {
    signal?.throwIfAborted();
    const batch=pool.filter(r=>!attempted.has(r.asset.id)).slice(0,3);
    batch.forEach(r=>attempted.add(r.asset.id));
    const measured=await Promise.allSettled(batch.map(r=>measureShortlist(r.asset,outputDir,signal)));
    for(const result of measured)if(result.status==="rejected")signal?.throwIfAborted();
    pool=diverseCandidates(source.filter(r=>r.asset.usable),SFX_WORKFLOW.candidates.measuredFamilies);
  }
  return pool;
}
export async function measureShortlist(asset: AudioAsset, outputDir: string, signal?: AbortSignal) {
  if (!asset.usable) return;
  if (asset.acoustics) return;
  const file=path.resolve(outputDir,"..","..","candidate-acoustic-cache",createHash("sha256").update(JSON.stringify([1,asset.path,asset.size,asset.mtimeMs])).digest("hex")+".json");
  try { asset.acoustics=JSON.parse(await fs.readFile(file,"utf8")); return; } catch { /* first measurement */ }
  const copy=structuredClone(asset);
  try { await clips.sample(copy,false,outputDir,signal); } catch(error) {
    signal?.throwIfAborted();
    Object.assign(asset,copy,{usable:false,warning:copy.warning||"候选片段解码失败，本次选材已排除"});
    throw error;
  }
  Object.assign(asset,copy);
  if(asset.acoustics) { await fs.mkdir(path.dirname(file),{recursive:true}); await fs.writeFile(file,JSON.stringify(asset.acoustics)); }
}

/** Inspect only distinct shortlist families, keeping an explicit current pick first. */
export async function prepareDiverseCandidates(events: SoundEvent[], index: AudioLibraryIndex, outputDir: string, signal?: AbortSignal, progress?: (text:string)=>void) {
  filterEventCandidates(events.filter(e=>!e.locked),index.assets,index);
  const assets=new Map(eligibleAssets(index.assets,index).map(a=>[a.id,a]));
  const indexer=new AudioLibraryIndexer();
  for(const event of events.filter(e=>!e.locked)) {
    for(const layer of event.layers||[]) {
      const seen=new Set<string>();
      const source: {asset:AudioAsset;score:number;reason:string}[]=[];
      const append=(c:Candidate)=>{const a=assets.get(c.assetId);if(a?.usable&&!seen.has(a.id)){seen.add(a.id);source.push({asset:a,score:c.score,reason:c.reason});}};
      layer.candidates.forEach(append);
      const query=layer.query||event.query;
      const ranked=indexer.search(index,event.category==="music"?`music ${query}`:query,SFX_WORKFLOW.candidates.searchLimit,event).map(r=>{const advice=assetNameAdvice(event,layer.role,r.asset);return {...r,score:Math.max(.001,r.score+advice.score),reason:r.reason};}).sort((a,b)=>b.score-a.score);
      ranked.forEach(r=>append({assetId:r.asset.id,score:r.score,reason:r.reason}));
      const pool=await measureDiverseShortlist(source,outputDir,signal);
      layer.candidates=diverseCandidates(pool.filter(r=>r.asset.usable),SFX_WORKFLOW.candidates.alternatives).map(r=>({assetId:r.asset.id,score:r.score,reason:r.reason}));
    }
    event.candidates=(event.layers||[]).flatMap(l=>l.candidates).slice(0,8);
    progress?.(`比较备选音色与衰减：${event.start.toFixed(2)} 秒 ${event.type}`);
  }
}
