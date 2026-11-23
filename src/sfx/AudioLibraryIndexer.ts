import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { AudioAsset, AudioLibraryIndex } from "./models.js";
import { runFfmpeg } from "./FfmpegBinaries.js";
import {keywordPreferenceResolver,pathPreferenceResolver,preferredSearchQuery,referenceStylesFor,type PreferenceContext} from "./LibraryPreferences.js";
import {SFX_WORKFLOW} from "./WorkflowPolicy.js";
import {assetExclusionReasonResolver} from "./AssetExclusions.js";

type AudioMetadata = { duration: number; channels?: number; sampleRate?: number };
export async function probeAudio(file: string): Promise<AudioMetadata> {
  const { stdout } = await runFfmpeg(["__ffprobe__", "-v", "error", "-show_format", "-show_streams", "-of", "json", file], { timeout: 30000 });
  const data = JSON.parse(stdout);
  const audio = data.streams?.find((s: { codec_type: string }) => s.codec_type === "audio");
  const duration = Number(audio?.duration ?? data.format?.duration);
  if (!audio || !Number.isFinite(duration) || duration <= 0) throw new Error("未检测到有效音频");
  return { duration, channels: Number(audio.channels), sampleRate: Number(audio.sample_rate) };
}
const aliases: Array<[string, string]> = [
  ["木门", "wood door"], ["开门", "door open"], ["关门", "door close"], ["打开", "open"], ["关闭", "close"],
  ["脚步", "footstep"], ["步行", "footstep"], ["奔跑", "run footstep"], ["碰撞", "impact hit"], ["落地", "land impact"],
  ["爆炸", "explosion"], ["雨", "rain"], ["风", "wind"], ["火焰", "fire"], ["水", "water"], ["街道", "street"],
  ["环境", "ambience"], ["氛围", "ambience"], ["室内", "room interior"], ["转场", "whoosh transition"], ["挥", "whoosh"],
  ["金属", "metal"], ["木", "wood"], ["玻璃", "glass"], ["汽车", "car"], ["机械", "machine"], ["枪", "gun"],
  ["施法", "cast spell magic"], ["法术", "cast spell magic"], ["释放", "cast release"], ["蓄力", "charge power up"], ["充能", "charge power up"],
  ["挥砍", "swing slash whoosh"], ["斩击", "slash sword"], ["挥刀", "sword swing"], ["挥拳", "fist swing punch"], ["破空", "whoosh swish"],
  ["命中", "hit impact strike"], ["击中", "hit impact strike"], ["重击", "heavy hit impact thud"], ["砸地", "ground smash impact"], ["碎石", "rock debris rubble"],
  ["投掷", "throw launch whoosh"], ["飞行", "fly flight whoosh"], ["咆哮", "roar growl monster"], ["怒吼", "roar growl monster"], ["火花", "spark metal"],
  ["施放", "cast spell magic"], ["技能", "skill cast"], ["能量", "energy magic"], ["冲击", "impact hit blast"], ["爆发", "burst explosion blast"],
  ["spell", "cast magic"], ["magic", "cast spell"], ["channel", "cast charge"], ["charging", "charge"], ["swing", "whoosh slash"], ["slash", "swing hit"], ["strike", "hit impact"], ["thud", "impact hit"],
  ["environment", "ambience outdoor"], ["outdoor", "ambience wind"], ["wasteland", "ambience wind"], ["monster", "creature"], ["gorilla", "ape monster"], ["rock", "stone debris"],
  ["opening", "open"], ["closing", "close"], ["footsteps", "footstep"], ["wooden", "wood"], ["ambient", "ambience"], ["casting", "cast"], ["spellcasting", "cast spell"], ["sfx", "sound effect"]
];
const semanticAliases: Array<[string, string]> = [
  ["boulder", "rock stone debris throw"], ["stone", "rock debris"], ["giant", "heavy large"],
  ["flying", "fly throw projectile whoosh"], ["flight", "fly projectile whoosh"], ["projectile", "throw fly whoosh"],
  ["dash", "dodge body whoosh"], ["dodge", "evade body whoosh"], ["jump", "leap body whoosh"],
  ["spin", "swirl whoosh"], ["button", "ui click"], ["click", "ui interface"], ["roar", "monster creature vocal"],
  ["fire", "flame burn explosion"], ["flash", "energy magic spark"], ["energy", "magic power charge"],
  ["heavy", "large impact thud slam"], ["ground", "earth dirt impact"], ["slam", "smash impact hit"],
  ["sword", "blade slash swing"], ["slash", "sword blade swing hit"], ["swing", "whoosh swish"],
  ["throw", "launch projectile rock whoosh"], ["impact", "hit strike smash thud"], ["hit", "impact strike"],
  ["cast", "magic spell energy"], ["charge", "power energy magic build"], ["land", "landing footstep impact"],
  ["slide", "scrape dirt movement"]
];
export function tokens(text: string): string[] {
  const original = text.toLowerCase();
  let normalized = original;
  for (const [word, expansion] of [...aliases, ...semanticAliases]) if (original.includes(word)) normalized += ` ${expansion}`;
  return [...new Set(normalized.split(/[^\p{L}\p{N}]+/u).filter(t => t.length > 1 && !["wav", "mp3", "flac", "ogg", "m4a"].includes(t)))];
}
export function isMusicAsset(asset: Pick<AudioAsset, "relativePath" | "fileName">) {
  return /(?:^|[^a-z])(?:bgm|music|mus)(?:[^a-z]|$)|背景音乐|配乐|音乐/i.test(`${asset.relativePath} ${asset.fileName}`);
}

const searchGroups = [
  ["cast", "casting", "spellcasting", "施法", "施放"],
  ["charge", "charging", "蓄力", "充能"],
  ["swing", "whoosh", "swish", "slash", "throw", "flying", "flight", "projectile", "挥刀", "挥砍", "破空"],
  ["impact", "hit", "strike", "smash", "slam", "命中", "击中", "砸地", "冲击"],
  ["roar", "growl", "咆哮", "怒吼"], ["jump", "leap", "跳跃"], ["land", "landing", "落地"],
  ["footstep", "foot", "walk", "run", "脚步"], ["warning", "iconwarning", "预警", "危险提示"], ["ui", "click", "interface", "提示"],
  ["amb", "ambience", "ambient", "environment", "环境"], ["debris", "rubble", "碎石", "碎屑"],
  ["sword", "gsword", "blade", "大剑", "长剑", "刀"], ["ape", "gorilla", "猩猩", "巨猿"],
  ["rock", "stone", "boulder", "earth", "石", "地刺"], ["wind", "风"],
  ["boss", "battle", "combat", "战斗"], ["tension", "suspense", "紧张"], ["open", "opening", "开门"], ["close", "closing", "关门"]
];
const rawWords = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 1 && !/^\d+$|^[a-f0-9]{8,}$|^(wav|wem|mp3|ogg|flac|m4a|aiff|sfx|efx|com|sound|effect)$/.test(w));
const contains = (text: string, word: string) => /[\u4e00-\u9fff]/.test(word) ? text.includes(word) : new RegExp(`(?:^|[^a-z])${word}(?:[^a-z]|$)`, "i").test(text) || word.length > 5 && text.includes(word);
export class AudioLibraryIndexer {
  constructor(private probe = probeAudio, private options: { probeMetadata?: boolean; ioConcurrency?: number; fileSystem?: Pick<typeof fs, "stat" | "readdir"> } = {}) {}
  async indexDirectory(directory: string, previous?: AudioLibraryIndex, progress?: (count: number) => void, signal?: AbortSignal): Promise<AudioLibraryIndex> {
    signal?.throwIfAborted();
    const root = path.resolve(directory);
    const io=this.options.fileSystem || fs;
    if (!(await io.stat(root)).isDirectory()) throw new Error("音效库路径必须是文件夹");
    const prior = new Map(previous?.root === root ? previous.assets.map(a => [a.path, a]) : []);
    const assets: AudioAsset[] = []; const warnings: string[] = [];
    // Bound SMB metadata requests across both directories and files. A serial
    // stat per recording can spend minutes waiting on a large shared library.
    const concurrency=Math.max(1,Math.min(32,Math.floor(this.options.ioConcurrency || 16)));
    const queue:Array<{file:string;directory:boolean}>=[{file:root,directory:true}];
    let cursor=0;
    const inspect=async(job:{file:string;directory:boolean})=>{
      signal?.throwIfAborted();
      const file=job.file;
      if(job.directory) {
        let entries;
        try {entries=await io.readdir(file,{withFileTypes:true});}
        catch(error){if(file===root)throw error;warnings.push("无法读取目录："+file);return;}
        signal?.throwIfAborted();
        for(const entry of entries) {
          if(entry.isSymbolicLink())continue;
          if(entry.isDirectory())queue.push({file:path.join(file,entry.name),directory:true});
          else if(entry.isFile()&&/\.(wav|mp3|flac|ogg|m4a|aif|aiff|opus)$/i.test(entry.name))queue.push({file:path.join(file,entry.name),directory:false});
        }
        return;
      }
      let stat;
      try {stat=await io.stat(file);}catch{signal?.throwIfAborted();warnings.push("无法读取文件："+file);return;}
      signal?.throwIfAborted();
      const old=prior.get(file);
      if(old?.usable&&(!this.options.probeMetadata||old.duration!==undefined)&&old.size===stat.size&&old.mtimeMs===stat.mtimeMs){assets.push(old);progress?.(assets.length);return;}
      const relativePath=path.relative(root,file);
      const asset:AudioAsset={id:createHash("sha256").update(file).digest("hex").slice(0,20),path:file,relativePath,fileName:path.basename(file),size:stat.size,mtimeMs:stat.mtimeMs,tags:tokens(relativePath),usable:false};
      if(this.options.probeMetadata) {
        try {Object.assign(asset,await this.probe(file),{usable:true});}
        catch(err){asset.warning=String(err instanceof Error?err.message:err).slice(0,240);warnings.push(`${relativePath}：${asset.warning}`);}
      }else asset.usable=true;
      signal?.throwIfAborted();assets.push(asset);progress?.(assets.length);
    };
    while(cursor<queue.length) {
      signal?.throwIfAborted();
      const batch=queue.slice(cursor,cursor+concurrency);cursor+=batch.length;
      const results=await Promise.allSettled(batch.map(inspect));
      const failed=results.find((r):r is PromiseRejectedResult=>r.status==="rejected");
      if(failed)throw failed.reason;
    }
    assets.sort((a,b)=>a.relativePath.localeCompare(b.relativePath));
    signal?.throwIfAborted();
    return { version: 1, root, generatedAt: new Date().toISOString(), assets, warnings };
  }
  search(index: AudioLibraryIndex, query: string, limit = 3, context?:PreferenceContext) {
    const excluded=assetExclusionReasonResolver(index);
    query=preferredSearchQuery(query,context,index.keywordPreferences);
    const preferredPath=pathPreferenceResolver(index.libraryPreferences);
    const preferredKeyword=keywordPreferenceResolver(index.keywordPreferences,context);
    const profiles=[...(index.styleProfile?[{profile:index.styleProfile}]:[]),...referenceStylesFor(context,index.referenceStyles)];
    const words = rawWords(query);
    const expanded = tokens(query);
    const queryText = query.toLowerCase();
    const music = /\bmusic\b|\bbgm\b|背景音乐|配乐|音乐/i.test(query);
    const groups = searchGroups.filter(group => group.some(w => contains(queryText, w)));
    const primary = groups.find(g => searchGroups.indexOf(g) < 12);
    const musicLibraryConfigured = index.musicLibraryConfigured;
    return index.assets.filter(a => a.usable && !excluded(a) && (music ? musicLibraryConfigured === false ? a.musicOnly === true : musicLibraryConfigured === true ? a.musicOnly === true : isMusicAsset(a) : !a.musicOnly) ).map(asset => {
      const filename = asset.fileName.toLowerCase();
      const pathText = asset.relativePath.toLowerCase();
      const hits = words.filter(w => contains(filename, w));
      const matchedGroups = groups.filter(g => g.some(w => contains(filename, w) || contains(pathText, w)));
      // Names guide ranking, including synonyms; they cannot prove what the recording sounds like.
      const stagePenalty = !music && primary && !primary.some(w => contains(filename, w) || contains(pathText, w)) ? 8 : 0;
      const uiPenalty = !music && /\bui\b/.test(queryText) && !/\bui\b|_ui_|ui_|界面|iconwarning/i.test(`${filename} ${pathText}`) ? 8 : 0;
      const focused = words.filter(w => /^(?:gsword|chestpound|countup|skilllevel|swish|land|charge|cast)$/.test(w));
      const focusBoost = focused.filter(w => contains(filename, w)).length * 7;
      const pathHits = words.filter(w => contains(pathText, w));
      const weakHits = expanded.filter(w => contains(filename, w));
      const score = hits.length * 2 + matchedGroups.length * 2.5 + pathHits.length * .3 + weakHits.length * .08 + focusBoost
        + (music && /(?:^|[_\s])(?:main|loop|battle|boss|combat)(?:[_\s.]|$)/i.test(filename) ? 2 : 0)
        - (music && /(?:_|\b)cin(?:_|\b)|cinematic/i.test(filename) ? 3 : 0)
        - (music && /stinger|jingle|victory|defeat|\bpre\b|_pre\b/i.test(filename) ? 1.5 : 0);
      const voicePenalty = !/roar|voice|vocal|pain|growl|咆哮|叫/.test(queryText) && /(?:^|[^a-z])vo_|\bvoice\b|吼叫/i.test(filename) ? 12 : 0;
      const combatMusicBoost = music && /boss|battle|combat/.test(queryText) && /(?:^|[_\s])(?:battle|boss|combat)(?:[_\s.]|$)/i.test(filename) ? 6 : 0;
      const relevant = hits.length || matchedGroups.length || pathHits.length || weakHits.length;
      const relevance=relevant?Math.max(.01,score-voicePenalty-stagePenalty-uiPenalty+combatMusicBoost):0;
      const preference=preferredPath(asset.path);
      const keyword=preferredKeyword(asset);
      const preferenceSteps=(preference?preference.weight-1:0)+(keyword?keyword.weight-1:0);
      const preferenceBonus=Math.min(SFX_WORKFLOW.libraryPreference.maxBonus,relevance*SFX_WORKFLOW.libraryPreference.bonusPerStep*preferenceSteps);
      const text=`${filename} ${pathText}`.normalize('NFKC');
      const matches=profiles.map(p=>({...p,hits:[...new Set(p.profile.searchTerms.flatMap(term=>term.normalize('NFKC').toLowerCase().split(/[_\s/、,，]+/u)).filter(term=>term.length>1))].filter(term=>contains(text,term))}));
      const styleHits=[...new Set(matches.flatMap(p=>p.hits))];
      const styleBonus=relevance>0?Math.min(1.5,Math.max(0,...matches.map(p=>relevance*.12*p.hits.length))):0;
      return { asset, score:relevance+preferenceBonus+styleBonus, reason: `${styleHits.length?`风格参考：${styleHits.join("、")}；`:""}名称/同义词：${hits.join("、") || matchedGroups.map(g => g[0]).join("、") || pathHits.join("、") || weakHits.join("、")}；${stagePenalty || uiPenalty ? "名称意图不完全一致，需听取判断" : "按声音意图优先排序"}${preference?`；路径优先 ×${preference.weight}：${preference.path}（相关性优先）`:""}${keyword?`；关键词优先 ×${keyword.weight}：${keyword.keyword}（${keyword.scope}，相关性优先）`:""}` };
    }).filter(r => r.score > 0).sort((a, b) => b.score - a.score || a.asset.relativePath.localeCompare(b.asset.relativePath)).slice(0, limit);
  }
}


