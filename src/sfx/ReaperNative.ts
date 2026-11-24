import {promises as fs} from "node:fs";
import path from "node:path";
import os from "node:os";
import {createHash,randomUUID} from "node:crypto";
import {execa} from "execa";
import type {ReaperChannelMode,ReaperMediaFile} from "./ReaperMedia.js";

export type ReaperAudioFormat="preserve"|"wav16"|"wav24"|"wav32f"|"wav64f";
export type ReaperDitherMode="auto"|"on"|"off";
export type ReaperConversionSettings={audioFormat:ReaperAudioFormat;sampleRate:number;channelMode:ReaperChannelMode;dither:ReaperDitherMode;noiseShaping:boolean};
export type ReaperConversionOptions=Partial<ReaperConversionSettings>;
export type ReaperConversionEvidence={engine:"reaper";version:string;resampleMode:string;steps:string[];files:ReaperMediaFile[]};
export type ReaperConversionRequest={importPath:string;outputPath:string;media:ReaperMediaFile[];settings:ReaperConversionSettings};
export interface ReaperProjectConverter {convertProject(request:ReaperConversionRequest):Promise<ReaperConversionEvidence>}

export function normalizeReaperSettings(input:ReaperConversionOptions={}):ReaperConversionSettings {
  const result={audioFormat:input.audioFormat??"preserve",sampleRate:input.sampleRate??0,channelMode:input.channelMode??"preserve",dither:input.dither??"auto",noiseShaping:input.noiseShaping??false};
  if(!["preserve","wav16","wav24","wav32f","wav64f"].includes(result.audioFormat))throw new Error("无效的 REAPER 音频格式");
  if(![0,44100,48000,88200,96000,192000].includes(result.sampleRate))throw new Error("无效的 REAPER 采样率");
  if(!["preserve","mono","stereo"].includes(result.channelMode))throw new Error("无效的声道转换模式");
  if(!["auto","on","off"].includes(result.dither))throw new Error("无效的 REAPER 抖动设置");
  if(typeof result.noiseShaping!=="boolean")throw new Error("无效的 REAPER Noise Shaping 设置");
  return result;
}
export const needsReaperConversion=(settings:ReaperConversionSettings)=>settings.audioFormat!=="preserve"||settings.sampleRate!==0||settings.channelMode!=="preserve";

/** REAPER RENDER_DITHER: master dither=1, master noise shaping=2. */
export function renderDitherFlags(settings:Pick<ReaperConversionSettings,"audioFormat"|"dither"|"noiseShaping">) {
  const dither=settings.dither==="on" || (settings.dither==="auto" && settings.audioFormat==="wav16");
  return dither ? 1 | (settings.noiseShaping ? 2 : 0) : 0;
}

/** REAPER RENDER_NORMALIZE bit 18 explicitly disables all render postprocessing. */
export const renderPostProcessDisabledFlags=4<<16;

function setProjectSetting(template:string,key:string,value:string) {
  const replacement=`  ${key} ${value}`;
  const pattern=new RegExp(`^\\s*${key}\\s+[^\\r\\n]*`,'m');
  if(pattern.test(template))return template.replace(pattern,replacement);
  const firstLineEnd=template.indexOf("\n");
  if(firstLineEnd<0)return `${template}\n${replacement}\n`;
  return `${template.slice(0,firstLineEnd+1)}${replacement}\n${template.slice(firstLineEnd+1)}`;
}

/** Applies the fixed project render policy used by exported Spielkiste projects. */
export function applyReaperRenderSettings(template:string, settings:ReaperConversionSettings) {
  let result=template;
  result=setProjectSetting(result,"RENDER_DITHER",String(renderDitherFlags(settings)));
  result=setProjectSetting(result,"RENDER_NORMALIZE",String(renderPostProcessDisabledFlags));
  result=setProjectSetting(result,"RENDER_TAILFLAG","0");
  result=setProjectSetting(result,"RENDER_TAILMS","0");
  result=setProjectSetting(result,"RENDER_ADDTOPROJ","0");
  result=setProjectSetting(result,"RENDER_STEMS","0");
  return result;
}

/** REAPER's WAV sink: FourCC evaw followed by bit depth and two option bytes. */
export function reaperWaveFormat(format:ReaperAudioFormat) {
  const bits={preserve:64,wav16:16,wav24:24,wav32f:32,wav64f:64}[format];
  return Buffer.from([101,118,97,119,bits,0,0]).toString("base64");
}
function luaString(value:string) {
  // Lua strings are generated data, never interpolated shell code.
  return `"${value.replaceAll("\\","\\\\").replaceAll('"','\\"').replaceAll("\r","\\r").replaceAll("\n","\\n").replaceAll("\t","\\t")}"`;
}
async function binaryPath() {
  const candidates=[process.env.SFX_REAPER_PATH,path.join(process.env.ProgramFiles||"C:/Program Files","REAPER (x64)","reaper.exe"),path.join(process.env["ProgramFiles(x86)"]||"C:/Program Files (x86)","REAPER","reaper.exe")].filter((s):s is string=>Boolean(s));
  for(const candidate of candidates)try{if((await fs.stat(candidate)).isFile())return path.resolve(candidate);}catch{/* try next */}
  throw new Error("未找到 REAPER。请安装 REAPER，或设置 SFX_REAPER_PATH 为 reaper.exe 的完整路径；保留全部原始设置可直接导出。");
}
async function safeTemporaryDirectory() {
  const root=process.env.SFX_REAPER_TEMP_DIR||os.tmpdir();
  await fs.mkdir(root,{recursive:true});
  const directory=await fs.mkdtemp(path.join(root,"spielkiste-reaper-"));
  if(!/\s/.test(directory))return {directory,nativePath:directory};
  // REAPER 7.33 batchconvert misparses quoted input paths with spaces.
  // 8.3 is used only for this tool-owned temporary path; final media keeps its names.
  const {stdout}=await execa("powershell.exe",["-NoProfile","-NonInteractive","-Command","$folder=New-Object -ComObject Scripting.FileSystemObject; $folder.GetFolder($env:SFX_NATIVE_SHORT_DIRECTORY).ShortPath"],{windowsHide:true,env:{SFX_NATIVE_SHORT_DIRECTORY:directory}});
  const nativePath=stdout.trim();
  if(!nativePath||/\s|[\r\n]/.test(nativePath)) {
    await fs.rm(directory,{recursive:true,force:true});
    throw new Error("REAPER 批量转换需要无空格的临时目录。请设置 SFX_REAPER_TEMP_DIR（例如 C:\\SfxTemp）后重试。");
  }
  return {directory,nativePath};
}

type NativeSource={file:string;channels:number;sampleRate:number;duration:number};
type NativeState={version:string;resampleMode:string;resampleIndex:number;sources:NativeSource[];steps:string[];error?:string};
function scriptHeader() {
  return `local state={version=reaper.GetAppVersion(),sources={},steps={}}
local function json(v)
 if type(v)=="table" then
  local parts={}; if #v>0 then for _,x in ipairs(v) do parts[#parts+1]=json(x) end;return "["..table.concat(parts,",").."]" end
  for k,x in pairs(v) do parts[#parts+1]=json(k)..":"..json(x) end;return "{"..table.concat(parts,",").."}"
 elseif type(v)=="string" then return '"'..v:gsub('[%z\\1-\\31\\\\"]',function(c) return string.format('\\\\u%04x',string.byte(c)) end)..'"'
 elseif type(v)=="number" or type(v)=="boolean" then return tostring(v) else return "null" end
end
local function sourceinfo(source)
 local duration=reaper.GetMediaSourceLength(source)
 return {file=reaper.GetMediaSourceFileName(source,""),channels=reaper.GetMediaSourceNumChannels(source),sampleRate=reaper.GetMediaSourceSampleRate(source),duration=duration}
end
local ok,err=xpcall(function()
`;
}
function scriptFooter(statusPath:string) {
  return `
end,debug.traceback)
if not ok then state.error=err end
local f=io.open(${luaString(statusPath)},"w"); if f then f:write(json(state));f:close() end
-- Finish the script before quitting its dedicated instance. Immediate quit can
-- crash REAPER 7.33 during script teardown, even after the status was written.
reaper.defer(function() reaper.Main_OnCommand(40004,0) end)
`;
}
async function nativeScript(binary:string,config:string,script:string,status:string) {
  try {await execa(binary,["-newinst","-nosplash","-noactivate","-ignoreerrors","-cfgfile",config,script],{windowsHide:true,killSignal:"SIGKILL"});}
  catch(error) {throw new Error(`REAPER 自动处理失败：${(error as Error).message.slice(0,500)}`);}
  let state:NativeState;
  try {state=JSON.parse(await fs.readFile(status,"utf8"));}catch {throw new Error("REAPER 未完成自动脚本，请检查本机 REAPER 是否存在首次启动或授权提示。");}
  if(state.error)throw new Error(`REAPER 处理失败：${state.error.slice(0,700)}`);
  state.sources=Array.isArray(state.sources)?state.sources:[];
  return state;
}

/** Imports originals first; only REAPER's native Batch Converter changes audio samples. */
export class ReaperNativeConverter implements ReaperProjectConverter {
  async convertProject(request:ReaperConversionRequest):Promise<ReaperConversionEvidence> {
    if(process.platform!=="win32")throw new Error("REAPER 原生自动转换当前支持 Windows。");
    const binary=await binaryPath(),temporary=await safeTemporaryDirectory(),work=temporary.directory,native=temporary.nativePath;
    const config=path.join(work,"reaper.ini"),directory=path.dirname(request.importPath);
    try {
      await fs.mkdir(path.join(work,"EmptyVST"));
      await fs.writeFile(config,`[reaper]\nloadlastproj=0\nprojecttabs=0\nsplash=0\nsplash2=0\nlangpack=\nvst_scan=0\nvstpath64=${path.join(native,"EmptyVST")}\ndisabledxscan=1\nuserewire=0\nautosaveint=0\n[audioconfig]\nmode=4\n`);
      // Borrow only the plugin index to suppress unnecessary third-party scans, never preferences or credentials.
      const cached=path.join(process.env.APPDATA||"","REAPER","reaper-vstplugins64.ini");
      try {await fs.copyFile(cached,path.join(work,"reaper-vstplugins64.ini"));}catch{/* vst_scan=0 remains active */}
      const audio=request.media.filter(file=>file.kind==="audio"),status=path.join(work,"import.json"),script=path.join(work,"import.lua");
      const importedPaths=audio.map(file=>path.resolve(directory,file.relativePath));
      const importScript=scriptHeader()+`
reaper.Main_openProject(${luaString(request.importPath)})
local project,name=reaper.EnumProjects(-1,"")
assert(name:lower():gsub("\\\\","/")==${luaString(request.importPath.replaceAll("\\","/").toLowerCase())},"Import project did not open")
local loaded={}
for i=0,reaper.CountMediaItems(project)-1 do
 local item=reaper.GetMediaItem(project,i)
 for j=0,reaper.CountTakes(item)-1 do
  local source=reaper.GetMediaItemTake_Source(reaper.GetTake(item,j))
  local info=sourceinfo(source)
  if info.channels>0 then loaded[info.file:lower():gsub("\\\\","/")]=true end
 end
end
local originals={${importedPaths.map(luaString).join(",")}}
for _,file in ipairs(originals) do
 assert(loaded[file:lower():gsub("\\\\","/")],"Original audio missing from imported project: "..file)
 local source=assert(reaper.PCM_Source_CreateFromFile(file),"Cannot decode "..file)
 local info=sourceinfo(source);assert(info.channels>0 and info.sampleRate>0 and info.duration>0,"Invalid audio: "..file)
 state.sources[#state.sources+1]=info;reaper.PCM_Source_Destroy(source)
end
local i=0;state.resampleIndex=0;state.resampleMode="default"
while true do local mode=reaper.Resample_EnumModes(i);if not mode then break end
 if mode:lower():find("r8brain",1,true) then state.resampleIndex=i;state.resampleMode=mode;break end;i=i+1
end
state.steps={"import-originals"}
`+scriptFooter(status);
      await fs.writeFile(script,importScript);
      const imported=await nativeScript(binary,config,script,status);
      const inputs=path.join(work,"Input"),outputs=path.join(work,"Output"),nativeInputs=path.join(native,"Input"),nativeOutputs=path.join(native,"Output");
      await fs.mkdir(inputs);await fs.mkdir(outputs);
      const mapping=new Map<string,{original:ReaperMediaFile;relativePath:string;input:string;output:string;meta:NativeSource}>();
      for(const [i,file] of audio.entries()) {
        const id=createHash("sha256").update(file.relativePath).digest("hex").slice(0,24),input=path.join(inputs,id+path.extname(file.relativePath)),output=path.join(outputs,id+".wav");
        await fs.copyFile(path.join(directory,file.relativePath),input);
        const relativePath=`Audio/Converted/${path.parse(file.relativePath).name}_${randomUUID().slice(0,8)}.wav`;
        mapping.set(path.resolve(directory,file.relativePath).replaceAll("\\","/").toLowerCase(),{original:file,relativePath,input,output,meta:imported.sources[i]});
      }
      if(audio.length) {
        const job=path.join(work,"convert.txt"),settings=request.settings;
        const lines=[...mapping.values()].map(entry=>path.join(nativeInputs,path.basename(entry.input)));
        lines.push("<CONFIG",` OUTPATH "${nativeOutputs}"`,' OUTPATTERN "$source"',` RSMODE ${imported.resampleIndex}`," USESRCSTART 1"," USESRCMETADATA 1"," CPULIMIT 2");
        if(settings.sampleRate)lines.push(` SRATE ${settings.sampleRate}`);
        if(settings.channelMode!=="preserve")lines.push(` NCH ${settings.channelMode==="mono"?1:2}`);
        lines.push(" <OUTFMT",`  ${reaperWaveFormat(settings.audioFormat)}`," >",">");
        await fs.writeFile(job,lines.join("\r\n")+"\r\n");
        await execa(binary,["-newinst","-nosplash","-noactivate","-cfgfile",config,"-batchconvert",job],{windowsHide:true,killSignal:"SIGKILL"});
        const log=await fs.readFile(job+".log","utf8");
        if(!/^OK\s*$/m.test(log)||/^FAIL|^ERROR|Can't open/m.test(log))throw new Error(`REAPER 批量转换失败：${log.slice(-700)}`);
        await fs.mkdir(path.join(directory,"Audio","Converted"),{recursive:true});
        for(const entry of mapping.values()) {
          if((await fs.stat(entry.output)).size<=44)throw new Error("REAPER 未生成完整转换文件");
          await fs.copyFile(entry.output,path.join(directory,entry.relativePath));
        }
      }
      const finalStatus=path.join(work,"save.json"),finalScript=path.join(work,"save.lua");
      const rows=[...mapping.entries()].map(([source,entry])=>`[${luaString(source)}]={file=${luaString(path.resolve(directory,entry.relativePath))},channels=${request.settings.channelMode==="mono"?1:request.settings.channelMode==="stereo"?2:entry.meta.channels},sampleRate=${request.settings.sampleRate||entry.meta.sampleRate},duration=${entry.meta.duration}}`).join(",\n");
      await fs.writeFile(finalScript,scriptHeader()+`
reaper.Main_openProject(${luaString(request.importPath)})
local project=reaper.EnumProjects(-1,"")
local replacements={${rows}}
local seen={}
for i=0,reaper.CountMediaItems(project)-1 do
 local item=reaper.GetMediaItem(project,i)
 for j=0,reaper.CountTakes(item)-1 do
  local take=reaper.GetTake(item,j);local old=reaper.GetMediaItemTake_Source(take)
  local key=reaper.GetMediaSourceFileName(old,""):lower():gsub("\\\\","/");local replacement=replacements[key]
  if replacement then
   local source=assert(reaper.PCM_Source_CreateFromFile(replacement.file),"Converted source missing")
   local info=sourceinfo(source)
   assert(info.channels==replacement.channels and info.sampleRate==replacement.sampleRate,"Converted media settings mismatch: "..replacement.file)
   assert(math.abs(info.duration-replacement.duration)<=math.max(0.003,2/info.sampleRate),"Converted source length mismatch")
   assert(reaper.SetMediaItemTake_Source(take,source),"Relink failed")
   reaper.PCM_Source_Destroy(old)
   if not seen[key] then state.sources[#state.sources+1]=info;seen[key]=true end
  end
 end
end
for key,_ in pairs(replacements) do assert(seen[key],"Source not relinked: "..key) end
${request.settings.sampleRate?`reaper.GetSetProjectInfo(project,"PROJECT_SRATE",${request.settings.sampleRate},true)\nreaper.GetSetProjectInfo(project,"PROJECT_SRATE_USE",1,true)\nreaper.GetSetProjectInfo(project,"RENDER_SRATE",${request.settings.sampleRate},true)`:""}
reaper.GetSetProjectInfo_String(project,"RENDER_FORMAT",${luaString(reaperWaveFormat(request.settings.audioFormat))},true)
reaper.GetSetProjectInfo(project,"RENDER_DITHER",${renderDitherFlags(request.settings)},true)
reaper.GetSetProjectInfo(project,"RENDER_NORMALIZE",${renderPostProcessDisabledFlags},true)
reaper.GetSetProjectInfo(project,"RENDER_TAILFLAG",0,true)
reaper.GetSetProjectInfo(project,"RENDER_TAILMS",0,true)
reaper.GetSetProjectInfo(project,"RENDER_ADDTOPROJ",0,true)
reaper.GetSetProjectInfo(project,"RENDER_STEMS",0,true)
reaper.Main_SaveProjectEx(project,${luaString(request.outputPath)},8)
assert(reaper.file_exists(${luaString(request.outputPath)}),"Project save failed")
state.steps={"import-originals","convert-full-sources","relink-and-save"}
`+scriptFooter(finalStatus));
      const final=await nativeScript(binary,config,finalScript,finalStatus);
      const byPath=new Map(final.sources.map(s=>[s.file.replaceAll("\\","/").toLowerCase(),s]));
      const files=request.media.map(file=>{
        if(file.kind!=="audio")return file;
        const entry=mapping.get(path.resolve(directory,file.relativePath).replaceAll("\\","/").toLowerCase())!;
        const meta=byPath.get(path.resolve(directory,entry.relativePath).replaceAll("\\","/").toLowerCase())!;
        const format=request.settings.audioFormat==="preserve"?"wav64f":request.settings.audioFormat;
        const codec={wav16:"pcm_s16le",wav24:"pcm_s24le",wav32f:"pcm_f32le",wav64f:"pcm_f64le"}[format];
        return {...file,originalRelativePath:file.relativePath,relativePath:entry.relativePath,converted:true,method:"reaper-batch-converter",sourceChannels:entry.meta.channels,channels:meta.channels,sampleRate:meta.sampleRate,codec};
      });
      // REAPER may serialize absolute file paths after Save As; only package-contained paths are relativized.
      let saved=await fs.readFile(request.outputPath,"utf8");
      saved=saved.replace(/^(\s*FILE )([^\r\n]+)/gm,(_line,prefix:string,token:string)=>{
        const file=token.startsWith('"')?token.slice(1,-1):token;
        if(!path.isAbsolute(file))return `${prefix}"${file.replaceAll("\\","/")}"`;
        const relative=path.relative(directory,file).replaceAll("\\","/");
        if(relative===".."||relative.startsWith("../"))throw new Error("REAPER 成品含工程目录以外的素材路径");
        return `${prefix}"${relative}"`;
      });
      await fs.writeFile(request.outputPath,saved);
      return {engine:"reaper",version:imported.version,resampleMode:imported.resampleMode,steps:final.steps,files};
    } finally {await fs.rm(work,{recursive:true,force:true});}
  }
}
