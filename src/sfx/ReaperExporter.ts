import { appResource } from "./RuntimePaths.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SfxRun, SoundEvent, SoundPlacement } from "./models.js";
import { ReaperMediaPackager, type ReaperChannelMode, type ReaperMediaFile } from "./ReaperMedia.js";
import {ReaperNativeConverter,normalizeReaperSettings,needsReaperConversion,applyReaperRenderSettings,type ReaperConversionSettings,type ReaperConversionOptions,type ReaperConversionEvidence,type ReaperProjectConverter} from "./ReaperNative.js";

export const DEFAULT_REAPER_TEMPLATE_PATH = appResource("templates", "spielkiste-default.rpp");

export function normalizeReaperOutputPath(value?: string): string | undefined {
  const input = value?.trim().replace(/^"|"$/g, "").trim();
  if (!input) return undefined;
  return /\.rpp$/i.test(input) ? input : `${input}.rpp`;
}

export type ReaperExportOptions = ReaperConversionOptions & {
  templatePath?: string;
  outputPath?: string;
  channelMode?: ReaperChannelMode;
};

export type ReaperPlacementSource = {
  start: number;
  duration: number;
  sourceOffset: number;
  fadeIn: number;
  fadeOut: number;
  gainDb: number;
};

export type ReaperTrackManifest = {
  trackId: string;
  name: string;
  object: string;
  soundType: string;
  color: number;
  included: true;
  kind: "video" | "folder" | "placement";
  folderDepth: number;
  parentTrackId?: string;
  mediaPath?: string;
  placementId?: string;
  eventId?: string;
  assetPath?: string;
  source?: ReaperPlacementSource;
};

export type ReaperExportManifest = {
  version: 3;
  generatedAt: string;
  runId: string;
  revision: number;
  templatePath: string;
  outputPath: string;
  duration: number;
  tracks: ReaperTrackManifest[];
  skippedPlacements: string[];
  channelMode: ReaperChannelMode;
  media: ReaperMediaFile[];
  warnings: string[];
  settings: ReaperConversionSettings;
  conversion?: Omit<ReaperConversionEvidence,"files">;
};

export type ReaperExportResult = {
  outputPath: string;
  manifestPath: string;
  trackCount: number;
  placementTrackCount: number;
  skippedPlacements: string[];
  manifest: ReaperExportManifest;
  projectDirectory: string;
  channelMode: ReaperChannelMode;
  folderTrackCount: number;
  settings: ReaperConversionSettings;
};

type TrackDescriptor = {
  trackId: string;
  name: string;
  object: string;
  soundType: string;
  color: number;
  placement?: SoundPlacement;
  event?: SoundEvent;
  assetPath?: string;
  kind: "video" | "folder" | "placement";
  folderDepth: number;
  parentTrackId?: string;
  mediaPath?: string;
};

const COLORS: Record<string, number> = {
  VIDEO: reaperColor("667085"),
  BOSS: reaperColor("E85D04"),
  "角色": reaperColor("3A86FF"),
  "环境": reaperColor("2A9D8F"),
  "音乐": reaperColor("00B4D8"),
  UI: reaperColor("8338EC"),
  "其他": reaperColor("7A7A7A")
};

const OBJECT_ORDER: Record<string, number> = { BOSS: 0, "角色": 1, "环境": 2, "音乐": 3, UI: 4, "其他": 5 };
const SOUND_TYPE_ORDER: Record<string, number> = { "动作": 0, "吼叫": 1, "音乐": 2, "环境": 3, UI: 4, "其他": 5 };

function reaperColor(hex: string) {
  const rgb = Number.parseInt(hex, 16);
  // REAPER projects on Windows use COLORREF (R in the low byte).
  return 0x1000000 + ((rgb >> 16) & 255) + (rgb & 0x00ff00) + ((rgb & 255) << 16);
}

function scalarFromDb(db: number) {
  return Math.pow(10, db / 20);
}

function formatNumber(value: number) {
  if (!Number.isFinite(value)) return "0";
  return String(value);
}

function quote(value: string) {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function textFor(event: SoundEvent | undefined, placement: SoundPlacement, fileName = "") {
  return [event?.actor, event?.type, event?.phase, event?.description, event?.query, placement.role, placement.category, fileName].filter(Boolean).join(" ").toLowerCase();
}

function inferObject(event: SoundEvent, placement: SoundPlacement, fileName: string) {
  const text = textFor(event, placement, fileName);
  const actor = (event.actor || "").toLowerCase();
  if (/^ui$|界面|ui/.test(actor)) return "UI";
  if (/environment|ambience|环境/.test(actor)) return event.category === "music" ? "音乐" : "环境";
  if (/player|hero|角色|玩家|主角/.test(actor)) return "角色";
  if (/boss|猩猩|怪物|敌人|monster|enemy/.test(actor)) return "BOSS";
  if (event.category === "music" || /\bmusic\b|音乐|bgm|配乐/.test(text)) return "音乐";
  if (event.category === "ambience" || /ambience|environment|环境|风声|雨声|氛围/.test(text)) return "环境";
  if (/boss|猩猩|怪物|敌人|monster|enemy/.test(text)) return "BOSS";
  if (/player|hero|角色|玩家|主角/.test(text)) return "角色";
  if (/\bui\b|界面|按钮|提示|菜单|click|select|confirm/.test(text)) return "UI";
  return "其他";
}

function inferSoundType(event: SoundEvent, placement: SoundPlacement, fileName: string, object: string) {
  const text = textFor(event, placement, fileName);
  if (event.category === "music" || object === "音乐") return "音乐";
  if (event.category === "ambience" || object === "环境") return "环境";
  if (object === "UI") return "UI";
  const vocal = /roar|growl|scream|shout|voice|吼|咆哮|尖叫|叫声/;
  // A chest impact described as "roaring while hitting" belongs to action, not vocal.
  if (vocal.test([event.type, event.query, fileName].join(" ").toLowerCase())) return "吼叫";
  if (event.category === "impact" || event.category === "whoosh" || placement.role === "impact" || placement.role === "whoosh") return "动作";
  if (vocal.test(text)) return "吼叫";
  if (event.category === "foley" || /attack|cast|charge|hit|impact|whoosh|动作|攻击|施法|蓄力|命中|冲击|挥动/.test(text)) return "动作";
  return "其他";
}

function audioSourceType(filePath: string) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".mp3": return "MP3";
    case ".flac": return "FLAC";
    case ".ogg": return "VORBIS";
    case ".m4a":
    case ".aac": return "MP4";
    default: return "WAVE";
  }
}

function stripTemplateTracks(template: string) {
  const lines = template.split(/\r?\n/);
  const result: string[] = [];
  let depth = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!depth && /^<TRACK\b/.test(trimmed)) {
      depth = 1;
      continue;
    }
    if (depth) {
      if (trimmed.startsWith("<")) depth += 1;
      else if (trimmed === ">") depth -= 1;
      continue;
    }
    result.push(line);
  }
  return result.join("\n");
}

function insertTracks(template: string, tracks: string[]) {
  const clean = stripTemplateTracks(template).replace(/\s+$/, "\n");
  const marker = "  <EXTENSIONS";
  const markerIndex = clean.lastIndexOf(marker);
  const block = tracks.join("\n");
  if (markerIndex < 0) {
    const end = clean.lastIndexOf(">\n");
    if (end < 0) return `${clean}${block}\n`;
    return `${clean.slice(0, end)}${block}\n${clean.slice(end)}`;
  }
  return `${clean.slice(0, markerIndex)}${block}\n${clean.slice(markerIndex)}`;
}

function setRenderRange(template: string, duration: number) {
  const replacement = `  RENDER_RANGE 1 0 0 ${formatNumber(duration)} 1000`;
  if (/^\s*RENDER_RANGE\s+/m.test(template)) return template.replace(/^\s*RENDER_RANGE\s+[^\r\n]*/m, replacement);
  const firstLineEnd = template.indexOf("\n");
  if (firstLineEnd < 0) return `${template}\n${replacement}\n`;
  return `${template.slice(0, firstLineEnd + 1)}${replacement}\n${template.slice(firstLineEnd + 1)}`;
}

function itemBlock(options: { placement: SoundPlacement; assetPath: string; iid: number }) {
  const { placement, assetPath, iid } = options;
  const itemGuid = randomUUID().toUpperCase();
  const sourceGuid = randomUUID().toUpperCase();
  const sourceType = audioSourceType(assetPath);
  return [
    "    <ITEM",
    `      POSITION ${formatNumber(placement.start)}`,
    "      SNAPOFFS 0",
    `      LENGTH ${formatNumber(placement.duration)}`,
    `      LOOP ${placement.loop ? 1 : 0}`,
    "      ALLTAKES 0",
    `      FADEIN 1 ${formatNumber(placement.fadeIn)} 0 1 0 0 0`,
    `      FADEOUT 1 ${formatNumber(placement.fadeOut)} 0 1 0 0 0`,
    "      MUTE 0 0",
    `      SEL 0`,
    `      IGUID {${itemGuid}}`,
    `      IID ${iid}`,
    `      NAME ${quote(path.basename(assetPath))}`,
    `      VOLPAN ${formatNumber(scalarFromDb(placement.gainDb))} 0 1 -1`,
    `      SOFFS ${formatNumber(placement.sourceOffset)}`,
    "      PLAYRATE 1 1 0 -1 0 0.0025",
    "      CHANMODE 0",
    `      GUID {${sourceGuid}}`,
    `      <SOURCE ${sourceType}`,
    `        FILE ${quote(assetPath)}`,
    "      >",
    "    >"
  ].join("\n");
}

function videoItem(run: SfxRun, mediaPath: string) {
  const itemGuid = randomUUID().toUpperCase();
  const sourceGuid = randomUUID().toUpperCase();
  const volume = run.originalMuted ? 0 : scalarFromDb(run.originalGainDb);
  return [
    "    <ITEM",
    "      POSITION 0",
    "      SNAPOFFS 0",
    `      LENGTH ${formatNumber(run.duration)}`,
    "      LOOP 0",
    "      ALLTAKES 0",
    "      FADEIN 1 0 0 1 0 0 0",
    "      FADEOUT 1 0 0 1 0 0 0",
    "      MUTE 0 0",
    "      SEL 0",
    `      IGUID {${itemGuid}}`,
    "      IID 1",
    `      NAME ${quote(path.basename(run.videoPath))}`,
    `      VOLPAN ${formatNumber(volume)} 0 1 -1`,
    "      SOFFS 0",
    "      PLAYRATE 1 1 0 -1 0 0.0025",
    "      CHANMODE 0",
    `      GUID {${sourceGuid}}`,
    "      <SOURCE VIDEO",
    `        FILE ${quote(mediaPath)}`,
    "      >",
    "    >"
  ].join("\n");
}

function trackBlock(track: TrackDescriptor, run: SfxRun, iid: number) {
  const trackGuid = randomUUID().toUpperCase();
  return [
    `  <TRACK {${trackGuid}}`,
    `    NAME ${quote(track.name)}`,
    `    PEAKCOL ${track.color}`,
    "    BEAT -1",
    "    AUTOMODE 0",
    "    PANLAWFLAGS 3",
    "    VOLPAN 1 0 -1 -1 1",
    "    MUTESOLO 0 0 0",
    "    IPHASE 0",
    "    PLAYOFFS 0 1",
    `    ISBUS ${track.folderDepth > 0 ? 1 : track.folderDepth < 0 ? 2 : 0} ${track.folderDepth}`,
    "    BUSCOMP 0 0 0 0 0",
    "    SHOWINMIX 1 0.6667 0.5 1 0.5 0 0 0",
    "    FIXEDLANES 9 0 0 0 0",
    "    SEL 0",
    "    REC 0 0 1 0 0 0 0 0",
    "    VU 2",
    "    TRACKHEIGHT 0 0 0 0 0 0 0",
    "    INQ 0 0 0 0.5 100 0 0 100",
    "    NCHAN 2",
    "    FX 1",
    `    TRACKID {${trackGuid}}`,
    "    PERF 0",
    "    MIDIOUT -1",
    "    MAINSEND 1 0",
    ...(track.kind === "folder" ? [] : [track.placement && track.mediaPath ? itemBlock({ placement: track.placement, assetPath: track.mediaPath, iid }) : videoItem(run, track.mediaPath!)]),
    "  >"
  ].join("\n");
}

function descriptorFor(run: SfxRun, placement: SoundPlacement): TrackDescriptor {
  const event = run.events.find(item => item.id === placement.eventId);
  if (!event) throw new Error(`贴片 ${placement.id} 引用了不存在的事件 ${placement.eventId}`);
  const asset = run.assets.find(item => item.id === placement.assetId);
  if (!asset) throw new Error(`贴片 ${placement.id} 引用了不存在的素材 ${placement.assetId}`);
  const object = inferObject(event, placement, asset.fileName);
  const soundType = inferSoundType(event, placement, asset.fileName, object);
  return {
    trackId: placement.id,
    name: `${object} · ${soundType} · ${event.description || event.query} · ${asset.fileName}`,
    object,
    soundType,
    color: COLORS[object] || COLORS["其他"],
    placement,
    event,
    assetPath: asset.path,
    kind: "placement", folderDepth: 0
  };
}

function activePlacement(run: SfxRun, placement: SoundPlacement) {
  const event = run.events.find(item => item.id === placement.eventId);
  const mode = run.audioOutputMode || "all";
  return Boolean(placement.enabled && !event?.muted && (mode === "all"
    ? placement.category !== "music" || run.musicEnabled !== false
    : mode === "sfx" ? placement.category !== "music" : placement.category === "music"));
}

export class ReaperExporter {
  constructor(
    private converter:ReaperProjectConverter=new ReaperNativeConverter(),
    manifestRoot:string=path.resolve(".output", "reaper-exports")
  ) { this.manifestRoot=path.resolve(manifestRoot); }
  private readonly manifestRoot:string;
  async exportRun(run: SfxRun, options: ReaperExportOptions = {}): Promise<ReaperExportResult> {
    const templatePath = path.resolve(options.templatePath || DEFAULT_REAPER_TEMPLATE_PATH);
    const requestedOutput = normalizeReaperOutputPath(options.outputPath);
    const defaultRoot = path.join(path.dirname(this.manifestRoot), "reaper-projects", "Spielkiste.rpp");
    const nameOnly = requestedOutput && !/[/\\:]/.test(requestedOutput);
    const suggestedPath = nameOnly
      ? defaultOutputPath(defaultRoot, { ...run, name: path.parse(requestedOutput).name })
      : path.resolve(requestedOutput || defaultOutputPath(options.templatePath ? templatePath : defaultRoot, run));
    const outputPath = !requestedOutput || nameOnly
      ? await reserveProjectDirectory(suggestedPath)
      : suggestedPath;
    if (path.normalize(templatePath).toLowerCase() === path.normalize(outputPath).toLowerCase()) throw new Error("Reaper 模板和输出文件不能相同");
    const template = await fs.readFile(templatePath, "utf8");
    const settings=normalizeReaperSettings(options),channelMode=settings.channelMode;
    await fs.mkdir(path.dirname(outputPath), { recursive: true });

    const active = run.placements.filter(placement => activePlacement(run, placement));
    const skippedPlacements = run.placements.filter(placement => !activePlacement(run, placement)).map(placement => placement.id);
    const descriptors = active.map(placement => descriptorFor(run, placement));
    descriptors.sort((a, b) => {
      const object = (OBJECT_ORDER[a.object] ?? 99) - (OBJECT_ORDER[b.object] ?? 99);
      if (object) return object;
      const type = (SOUND_TYPE_ORDER[a.soundType] ?? 99) - (SOUND_TYPE_ORDER[b.soundType] ?? 99);
      if (type) return type;
      const start = (a.placement?.start || 0) - (b.placement?.start || 0);
      return start || a.trackId.localeCompare(b.trackId);
    });

    const packager = new ReaperMediaPackager(path.dirname(outputPath));
    const video = await packager.add(run.videoPath, "video");
    for (const descriptor of descriptors) {
      const asset = run.assets.find(asset => asset.id === descriptor.placement!.assetId)!;
      descriptor.mediaPath = (await packager.add(descriptor.assetPath!, "audio", asset)).relativePath;
    }
    const videoTrack: TrackDescriptor = { trackId: "video", name: "VIDEO · 原视频", object: "VIDEO", soundType: "视频", color: COLORS.VIDEO, kind: "video", folderDepth: 0, mediaPath: video.relativePath };
    const tracks = [videoTrack, ...folderTracks(descriptors)];
    const renderTemplate=applyReaperRenderSettings(setRenderRange(template, run.duration),settings);
    const rpp = insertTracks(renderTemplate, tracks.map((track, index) => track.placement ? trackBlock(track, run, index + 1) : trackBlock(track, run, 1)));

    const manifestTracks: ReaperTrackManifest[] = tracks.map(track => {
      const manifest: ReaperTrackManifest = { trackId: track.trackId, name: track.name, object: track.object, soundType: track.soundType, color: track.color, included: true, kind: track.kind, folderDepth: track.folderDepth, parentTrackId: track.parentTrackId, mediaPath: track.mediaPath };
      if (track.placement && track.event && track.assetPath) {
        manifest.placementId = track.placement.id;
        manifest.eventId = track.placement.eventId;
        manifest.assetPath = track.assetPath;
        manifest.source = { start: track.placement.start, duration: track.placement.duration, sourceOffset: track.placement.sourceOffset, fadeIn: track.placement.fadeIn, fadeOut: track.placement.fadeOut, gainDb: track.placement.gainDb };
      }
      return manifest;
    });
    const warnings: string[]=[];
    if(channelMode==="mono")warnings.push("由 REAPER 合并为单声道，声场和相位关系会改变，不能称为严格无损。");
    if(channelMode==="stereo")warnings.push("由 REAPER 转为双声道文件；单声道不会凭空产生空间感，不会复制轨道或添加空间效果。");
    if(settings.sampleRate)warnings.push("由 REAPER 使用高质量重采样转换实际素材文件；重采样不是逐样本无损。");
    if(settings.audioFormat === "wav16" && settings.dither !== "off") warnings.push("最终 REAPER 渲染启用抖动；它只作用于 16-bit 渲染，减少位深量化失真。");
    if(settings.noiseShaping && settings.dither !== "off") warnings.push("最终 REAPER 渲染启用 Noise Shaping；它把部分抖动噪声推向高频，不改变素材音调或速度。");
    const manifest: ReaperExportManifest = { version: 3, generatedAt: new Date().toISOString(), runId: run.id, revision: run.revision, templatePath, outputPath, duration: run.duration, tracks: manifestTracks, skippedPlacements, channelMode, media: packager.files, warnings,settings };
    // The manifest is workbench metadata, not part of the portable REAPER
    // project. Keep it outside the project directory so sharing the project
    // folder only exposes the .rpp and its relative media.
    const manifestPath = path.join(this.manifestRoot, run.id, `${path.basename(outputPath)}.reaper-export.json`);
    const stamp=randomUUID(),temporary = path.join(path.dirname(outputPath),`.spielkiste-final-${stamp}.rpp`),importPath=path.join(path.dirname(outputPath),`.spielkiste-import-${stamp}.rpp`),manifestTemporary=`${manifestPath}.${stamp}.tmp`;
    try {
      await fs.mkdir(path.dirname(manifestPath), { recursive: true });
      if(needsReaperConversion(settings)) {
        await fs.writeFile(importPath,rpp,"utf8");
        const {files,...evidence}=await this.converter.convertProject({importPath,outputPath:temporary,media:packager.files,settings});
        manifest.conversion=evidence;manifest.media=files;
        const mediaBySource=new Map(files.map(file=>[file.originalPath,file.relativePath]));
        for(const track of manifest.tracks)if(track.assetPath)track.mediaPath=mediaBySource.get(track.assetPath)||track.mediaPath;
      } else await fs.writeFile(temporary, rpp, "utf8");
      await fs.writeFile(manifestTemporary, JSON.stringify(manifest, null, 2), "utf8");
      await fs.rename(temporary, outputPath);
      await fs.rename(manifestTemporary,manifestPath);
    } finally { for(const file of [temporary,importPath,manifestTemporary])await fs.rm(file,{force:true}); }
    return { outputPath, manifestPath, trackCount: tracks.length, placementTrackCount: descriptors.length, skippedPlacements, manifest, projectDirectory: path.dirname(outputPath), channelMode, folderTrackCount: tracks.filter(track => track.kind === "folder").length,settings };
  }
}

function folderTracks(descriptors: TrackDescriptor[]): TrackDescriptor[] {
  const result: TrackDescriptor[] = [];
  for (const object of new Set(descriptors.map(track => track.object))) {
    const objectId = `folder:${object}`;
    result.push({ trackId: objectId, name: object, object, soundType: "分类", color: COLORS[object], kind: "folder", folderDepth: 1 });
    const objectTracks = descriptors.filter(track => track.object === object);
    const types = [...new Set(objectTracks.map(track => track.soundType))];
    for (const [typeIndex, soundType] of types.entries()) {
      const typeId = `${objectId}:${soundType}`;
      result.push({ trackId: typeId, name: soundType, object, soundType, color: COLORS[object], kind: "folder", folderDepth: 1, parentTrackId: objectId });
      const children = objectTracks.filter(track => track.soundType === soundType);
      children.forEach((track, i) => result.push({ ...track, parentTrackId: typeId, folderDepth: i === children.length - 1 ? (typeIndex === types.length - 1 ? -2 : -1) : 0 }));
    }
  }
  return result;
}

export function defaultOutputPath(templatePath: string, run?: Pick<SfxRun, "name" | "revision">) {
  const parsed = path.parse(templatePath);
  const label = (run?.name || parsed.name).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "").slice(0, 40) || "Spielkiste";
  return path.join(parsed.dir, label, `${label}.rpp`);
}

/** Reserve the folder atomically so concurrent exports cannot overwrite one another. */
async function reserveProjectDirectory(suggestedPath:string) {
  const directory=path.dirname(suggestedPath),root=path.dirname(directory),label=path.basename(directory);
  await fs.mkdir(root,{recursive:true});
  for(let number=1;;number++) {
    const target=path.join(root,number===1?label:`${label}（${number}）`);
    try { await fs.mkdir(target); return path.join(target,path.basename(suggestedPath)); }
    catch(error) { if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error; }
  }
}
