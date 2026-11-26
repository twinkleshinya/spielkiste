import type {AudioAsset,SoundEvent} from "./models.js";

export type AssetExclusions={excludedLibraryPaths?:string[];excludedKeywords?:string[]};
type NamedAsset=Pick<AudioAsset,"path"|"relativePath"|"fileName">;
const keywordKey=(value:string)=>value.normalize("NFKC").trim().toLowerCase();
const metadataPath=/(?:^|[\\/])(?:\._|__MACOSX(?:[\\/]|$))/i;

// No Node dependencies: the editor uses the same literal exclusion semantics.
function directoryKey(value:string) {
  const normalized=value.trim().replace(/^"|"$/g,"").replace(/\\/g,"/");
  const insensitive=/^[a-z]:|^\/\//i.test(normalized);
  const prefix=normalized.startsWith("//")?"//":normalized.startsWith("/")?"/":"";
  const segments:string[]=[];
  for(const part of normalized.split("/")) {
    if(!part||part===".")continue;
    if(part===".."&&segments.length&&segments.at(-1)!==".."&&!/^[a-z]:$/i.test(segments.at(-1)!))segments.pop();
    else if(part!==".."||!prefix)segments.push(part);
  }
  const result=prefix+segments.join("/");
  return insensitive?result.toLowerCase():result;
}
export function normalizeExcludedKeywords(values:string[]=[]):string[] {
  return [...new Set(values.map(keywordKey).filter(Boolean))].sort();
}
/** Exclusions always win over ranking; keywords do not expand into aliases or regex. */
export function assetExclusionReasonResolver(policy:AssetExclusions={}) {
  const directories=(policy.excludedLibraryPaths||[]).map(value=>({value,key:directoryKey(value)})).filter(item=>item.key);
  const keywords=normalizeExcludedKeywords(policy.excludedKeywords);
  return (asset:NamedAsset):string|undefined=>{
    if(metadataPath.test(asset.fileName)||metadataPath.test(asset.relativePath)||metadataPath.test(asset.path))return "系统元数据，不是音频素材";
    if(directories.length) {
      const file=directoryKey(asset.path),directory=directories.find(d=>file===d.key||file.startsWith(d.key.endsWith("/")?d.key:d.key+"/"));
      if(directory)return `素材位于排除目录：${directory.value}`;
    }
    if(keywords.length) {
      const names=[asset.fileName,asset.relativePath,asset.path].map(keywordKey);
      const keyword=keywords.find(word=>names.some(name=>name.includes(word)));
      if(keyword)return `素材包含禁用关键词：${keyword}`;
    }
    return undefined;
  };
}
export function eligibleAssets(assets:AudioAsset[],policy:AssetExclusions={}) {
  const reason=assetExclusionReasonResolver(policy);
  return assets.filter(asset=>!reason(asset));
}
/** Sanitize stale candidate IDs before measuring or sending any audio to Gemini. */
export function filterEventCandidates(events:SoundEvent[],assets:AudioAsset[],policy:AssetExclusions={}) {
  const allowed=new Set(eligibleAssets(assets,policy).filter(a=>a.usable).map(a=>a.id));
  for(const event of events) {
    event.candidates=event.candidates.filter(c=>allowed.has(c.assetId));
    for(const layer of event.layers||[]){
      layer.candidates=layer.candidates.filter(c=>allowed.has(c.assetId));
      if(layer.alternatives)layer.alternatives=layer.alternatives.filter(c=>allowed.has(c.assetId));
    }
  }
}
