import path from "node:path";
import type {AudioAsset,KeywordPreference,LibraryPreference,SoundEvent} from "./models.js";
import type {ReferenceStyle} from "./CreativeBrief.js";

export function preferencePath(value:string) {
  const clean=value.trim().replace(/^"|"$/g,"");
  return /^[a-z]:[\\/]|^[\\/]{2}/i.test(clean)?path.win32.resolve(clean):path.resolve(clean);
}
export function preferenceKey(value:string) {
  const absolute=preferencePath(value);
  const normalized=absolute.replace(/\\/g,"/").replace(/\/+$/,"");
  return process.platform==="win32"||/^[a-z]:|^\/\//i.test(normalized)?normalized.toLowerCase():normalized;
}
export function directoryContains(directory:string,file:string) {
  const root=preferenceKey(directory),target=preferenceKey(file);
  return target===root||target.startsWith(root+"/");
}
export function normalizeLibraryPreferences(preferences:LibraryPreference[]=[]):LibraryPreference[] {
  const unique=new Map<string,LibraryPreference>();
  for(const entry of preferences) {
    const directory=preferencePath(entry.path),key=preferenceKey(directory),previous=unique.get(key);
    if(!previous||entry.weight>previous.weight)unique.set(key,{path:directory,weight:entry.weight});
  }
  return [...unique.values()].sort((a,b)=>preferenceKey(a.path).localeCompare(preferenceKey(b.path)));
}
export function normalizeExcludedLibraryPaths(values:string[]=[]):string[] {
  const unique=new Map<string,string>();
  for(const value of values)unique.set(preferenceKey(value),preferencePath(value));
  return [...unique.values()].sort((a,b)=>preferenceKey(a).localeCompare(preferenceKey(b)));
}
/** Preference is advisory: do not compound overlapping paths or change audio gain. */
export function pathPreference(file:string,preferences:LibraryPreference[]=[]):LibraryPreference|undefined {
  return pathPreferenceResolver(preferences)(file);
}
export function pathPreferenceResolver(preferences:LibraryPreference[]=[]) {
  const ordered=preferences.filter(p=>p.weight>1).map(p=>({entry:p,key:preferenceKey(p.path)})).sort((a,b)=>b.entry.weight-a.entry.weight||b.key.length-a.key.length);
  return (file:string):LibraryPreference|undefined=>{
    if(!ordered.length)return undefined;
    const target=preferenceKey(file);
    return ordered.find(p=>target===p.key||target.startsWith(p.key+"/"))?.entry;
  };
}
export function additionalLibraryRoots(root:string,preferences:LibraryPreference[]=[]) {
  const candidates=normalizeLibraryPreferences(preferences).map(p=>p.path).filter(p=>!directoryContains(root,p));
  return candidates.filter(p=>!candidates.some(other=>other!==p&&directoryContains(other,p)));
}

export type PreferenceContext=Partial<Pick<SoundEvent,"actor"|"category"|"type"|"description"|"query">>;
const keywordText=(value:string)=>value.normalize("NFKC").trim().toLowerCase();
export function normalizeKeywordPreferences(preferences:KeywordPreference[]=[]):KeywordPreference[] {
  const unique=new Map<string,KeywordPreference>();
  for(const entry of preferences) {
    const reference=entry.purpose==='reference';
    const keyword=reference?entry.keyword.normalize('NFKC').trim():keywordText(entry.keyword),scope=entry.scope||"all",key=`${reference?'reference':'material'}:${scope}:${keywordText(keyword)}`;
    if(!unique.has(key)||entry.weight>unique.get(key)!.weight)unique.set(key,{keyword,weight:entry.weight,scope,...(reference?{purpose:'reference' as const}:{})});
  }
  return [...unique.values()].sort((a,b)=>a.scope.localeCompare(b.scope)||a.keyword.localeCompare(b.keyword));
}
function contextScope(context?:PreferenceContext):KeywordPreference["scope"]|undefined {
  if(context?.category==="music"||context?.category==="ambience")return context.category;
  const actor=context?.actor||"";
  if(/ui|界面/i.test(actor)||/^ui_|warning|telegraph/i.test(context?.type||""))return "ui";
  if(/player|hero|角色|玩家|主角/i.test(actor))return "player";
  if(/boss|monster|enemy|gorilla|ape|猩猩|巨猿|怪物|敌人/i.test(actor))return "boss";
  return undefined;
}
export function keywordPreferencesFor(context:PreferenceContext|undefined,preferences:KeywordPreference[]=[]) {
  const scope=contextScope(context);
  return preferences.filter(p=>p.purpose!=='reference'&&p.weight>1&&(p.scope==="all"||p.scope===scope));
}
export function referenceStylesFor(context:PreferenceContext|undefined,references:ReferenceStyle[]=[]) {
  return references.map(({keyword,profile})=>({keyword,profile}));
}
/** Remove only the historical auto prefix when the event's own intent did not request it. */
export function preferredSearchQuery(query:string,context:PreferenceContext|undefined,preferences:KeywordPreference[]=[]) {
  return contextScope(context)==="boss"&&keywordPreferencesFor(context,preferences).length&&!/apesstonehand/i.test(context?.query||"")
    ?query.replace(/^apesstonehand\s+/i,""):query;
}
// Controlled material aliases only: unknown keywords remain literal identifiers.
const materialKeywords=[
  ["金属","金属质感","metal","metallic"],
  ["木","木头","木质","wood","wooden"],
  ["石","石头","石质","stone","rock","stony"],
  ["玻璃","glass","glassy"],
  ["水","水声","water","watery"],
  ["火","火焰","fire","flame"],
  ["电","电流","电弧","electric","electricity","electrical"],
  ["机械","机甲","mechanical","machine","mech"]
];
function keywordPattern(keyword:string) {
  const words=keyword.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const escape=(word:string)=>word.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  const body=words.map(escape).join("[^\\p{L}\\p{N}]+");
  return new RegExp(/[\u3400-\u9fff]/u.test(keyword)?body:`(?:^|[^\\p{L}\\p{N}])${body}(?=$|[^\\p{L}\\p{N}])`,"u");
}
/** Name tokens plus bilingual material aliases, never extra action-query terms. */
export function keywordPreferenceResolver(preferences:KeywordPreference[]=[],context?:PreferenceContext) {
  const ordered=keywordPreferencesFor(context,normalizeKeywordPreferences(preferences)).sort((a,b)=>b.weight-a.weight||b.keyword.length-a.keyword.length).map(entry=>{
    const aliases=materialKeywords.find(group=>group.includes(entry.keyword))||[entry.keyword];
    return {entry,patterns:aliases.map(keywordPattern)};
  });
  return (asset:Pick<AudioAsset,"path"|"relativePath"|"fileName">):KeywordPreference|undefined=>{
    if(!ordered.length)return undefined;
    const name=keywordText(`${asset.fileName} ${asset.relativePath} ${asset.path}`);
    return ordered.find(p=>p.patterns.some(pattern=>pattern.test(name)))?.entry;
  };
}
