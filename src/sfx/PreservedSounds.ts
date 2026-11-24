import {createHash} from "node:crypto";
import {createReadStream,promises as fs} from "node:fs";
import path from "node:path";
import type {SfxRun} from "./models.js";
import {SfxError} from "./models.js";
import {writeJson} from "./SfxRunStore.js";
import {normalizeExcludedLibraryPaths,normalizeKeywordPreferences,normalizeLibraryPreferences,preferenceKey} from "./LibraryPreferences.js";
import {normalizeExcludedKeywords} from "./AssetExclusions.js";

type VideoLibraries=Pick<SfxRun,"videoDescription"|"soundRequirements"|"style"|"referenceWorks"|"videoPath"|"libraryPath"|"musicLibraryPath"|"musicEnabled"|"audioOutputMode"|"libraryPreferences"|"keywordPreferences"|"excludedLibraryPaths"|"excludedKeywords">;
type PreservedVersion={version:1;runId:string;revision:number;videoHash:string;soundsHash:string;preservedAt:string};
async function fileHash(file:string) {
  const hash=createHash("sha256");for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest("hex");
}
const libraryKey=(value:string)=>{const resolved=path.resolve(value);return process.platform==="win32"?resolved.toLowerCase():resolved;};
/** Only sound-affecting saved data identifies the preserved revision; reports/labels do not. */
function soundsHash(run:SfxRun) {
  const selected=new Set(run.placements.map(p=>p.assetId));
  return createHash("sha256").update(JSON.stringify({duration:run.duration,originalGainDb:run.originalGainDb,originalMuted:run.originalMuted===true,musicEnabled:run.musicEnabled!==false,audioOutputMode:run.audioOutputMode||"all",
    events:run.events,placements:run.placements,assets:run.assets.filter(a=>selected.has(a.id)).map(a=>({id:a.id,path:a.path,size:a.size,mtimeMs:a.mtimeMs})),render:run.render})).digest("hex");
}

/** Separate metadata: preserving/reopening must never rewrite an accepted run or preview. */
export class PreservedSounds {
  constructor(private root:string) {}
  private async identity(input:VideoLibraries) {
    const videoHash=await fileHash(input.videoPath);
    const preferences=normalizeLibraryPreferences(input.libraryPreferences).map(p=>({path:preferenceKey(p.path),weight:p.weight}));
    const keywords=normalizeKeywordPreferences(input.keywordPreferences);
    const excludedLibraryPaths=normalizeExcludedLibraryPaths(input.excludedLibraryPaths).map(preferenceKey),excludedKeywords=normalizeExcludedKeywords(input.excludedKeywords);
    const key=createHash("sha256").update(JSON.stringify({videoHash,...(input.videoDescription?{videoDescription:input.videoDescription}:{}),...(input.soundRequirements?{soundRequirements:input.soundRequirements}:{}),...(input.style?{style:input.style}:{}),...(input.referenceWorks?.length?{referenceWorks:input.referenceWorks}:{}),library:libraryKey(input.libraryPath),music:input.musicLibraryPath?libraryKey(input.musicLibraryPath):null,musicEnabled:input.musicEnabled!==false,audioOutputMode:input.audioOutputMode||"all",...(preferences.length?{libraryPreferences:preferences}:{}),...(keywords.length?{keywordPreferences:keywords}:{}),...(excludedLibraryPaths.length?{excludedLibraryPaths}:{}),...(excludedKeywords.length?{excludedKeywords}:{})})).digest("hex");
    return {videoHash,file:path.join(this.root,`${key}.json`)};
  }
  async preserve(run:SfxRun):Promise<PreservedVersion> {
    if(run.status!=="ready"||!run.placements.length||!run.render||run.render.revision!==run.revision)throw new SfxError("请先生成与当前已保存贴片一致的预览，再保留本版音效",409);
    await Promise.all([fs.access(run.render.video),fs.access(run.render.audio)]);
    const {videoHash,file}=await this.identity(run);
    const record:PreservedVersion={version:1,runId:run.id,revision:run.revision,videoHash,soundsHash:soundsHash(run),preservedAt:new Date().toISOString()};
    try {
      const previous=JSON.parse(await fs.readFile(file,"utf8")) as PreservedVersion;
      if(previous.runId!==run.id&&/^[\da-f-]{36}$/i.test(previous.runId))
        await writeJson(path.join(this.root,"runs",`${previous.runId}.json`),previous);
    } catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
    // Keep every accepted run protected even after a different default is chosen for the video.
    await writeJson(path.join(this.root,"runs",`${run.id}.json`),record);
    await writeJson(file,record);return record;
  }
  async findRun(runId:string):Promise<PreservedVersion|null> {
    if(!/^[\da-f-]{36}$/i.test(runId))throw new SfxError("无效任务 ID");
    try{return JSON.parse(await fs.readFile(path.join(this.root,"runs",`${runId}.json`),"utf8")) as PreservedVersion;}
    catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
    // Compatibility with preservation records created before per-run protection.
    let files:string[];
    try{files=await fs.readdir(this.root);}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return null;throw e;}
    for(const file of files.filter(f=>/^[a-f\d]{64}\.json$/i.test(f))) {
      const record=JSON.parse(await fs.readFile(path.join(this.root,file),"utf8")) as PreservedVersion;
      if(record.runId===runId)return record;
    }
    return null;
  }
  async find(input:VideoLibraries):Promise<PreservedVersion|null> {
    const {file}=await this.identity(input);
    try{return JSON.parse(await fs.readFile(file,"utf8")) as PreservedVersion;}
    catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return null;throw e;}
  }
  async verify(record:PreservedVersion,run:SfxRun) {
    if(record.revision!==run.revision||record.soundsHash!==soundsHash(run)||run.status!=="ready"||!run.render)throw new SfxError("已保留的版本后来有修改，请从历史项目确认后重新保留；不会自动重新选材",409);
    try {await Promise.all([fs.access(run.render.video),fs.access(run.render.audio)]);}catch {throw new SfxError("已保留版本的预览文件缺失，请打开历史项目检查；不会自动重新选材",409);}
  }
}
