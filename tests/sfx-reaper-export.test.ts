import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import type { SfxRun } from "../src/sfx/models.js";
import { ReaperExporter } from "../src/sfx/ReaperExporter.js";
import { SfxService } from "../src/sfx/SfxService.js";
import { handleSfxRequest } from "../src/ui/sfx-routes.js";

export function fixtureRun(root: string): SfxRun {
  const audio = (name: string) => path.join(root, name);
  const assets = [
    { id: "boss-roar", path: audio("boss_roar.wav"), relativePath: "boss_roar.wav", fileName: "boss_roar.wav", size: 1, mtimeMs: 1, tags: [], duration: 3, usable: true },
    { id: "player-charge", path: audio("player_charge.wav"), relativePath: "player_charge.wav", fileName: "player_charge.wav", size: 1, mtimeMs: 1, tags: [], duration: 2, usable: true },
    { id: "music-build", path: audio("music_build.wav"), relativePath: "music_build.wav", fileName: "music_build.wav", size: 1, mtimeMs: 1, tags: [], duration: 10, usable: true },
    { id: "ui-click", path: audio("ui_click.wav"), relativePath: "ui_click.wav", fileName: "ui_click.wav", size: 1, mtimeMs: 1, tags: [], duration: 1, usable: true },
    { id: "ignored", path: audio("ignored.wav"), relativePath: "ignored.wav", fileName: "ignored.wav", size: 1, mtimeMs: 1, tags: [], duration: 1, usable: true }
  ];
  return {
    version: 1, id: "11111111-1111-4111-8111-111111111111", name: "Reaper 导出测试",
    createdAt: new Date(0).toISOString(), revision: 6, status: "ready", progress: "ready",
    videoPath: path.join(root, "source.mp4"), libraryPath: root, duration: 12, originalGainDb: 0,
    originalMuted: true, analysisMode: "auto", warnings: [], scenes: [], assets,
    events: [
      { id: "boss-event", start: 1, end: 2, type: "roar", description: "猩猩怒吼", query: "boss roar", category: "foley", confidence: 1, source: "vision", candidates: [], requiresHumanReview: false, actor: "Boss/猩猩", phase: "attack" },
      { id: "player-event", start: 3, end: 4, type: "charge", description: "玩家蓄力", query: "player charge", category: "foley", confidence: 1, source: "vision", candidates: [], requiresHumanReview: false, actor: "player", phase: "build" },
      { id: "music-event", start: 0, end: 12, type: "music", description: "背景音乐增强", query: "music build", category: "music", confidence: 1, source: "vision", candidates: [], requiresHumanReview: false, musicStage: "build" },
      { id: "ui-event", start: 5, end: 5.5, type: "ui", description: "UI 提示", query: "ui click", category: "other", confidence: 1, source: "vision", candidates: [], requiresHumanReview: false },
      { id: "muted-event", start: 6, end: 7, type: "impact", description: "静音点位", query: "impact", category: "impact", confidence: 1, source: "vision", candidates: [], requiresHumanReview: false, muted: true }
    ],
    placements: [
      { id: "p-boss", eventId: "boss-event", layerId: "main", role: "foley", assetId: "boss-roar", start: 1.25, duration: .75, sourceOffset: .4, gainDb: -6, fadeIn: .02, fadeOut: .1, category: "foley", enabled: true },
      { id: "p-player", eventId: "player-event", layerId: "main", role: "foley", assetId: "player-charge", start: 3.1, duration: 1.2, sourceOffset: .15, gainDb: -12, fadeIn: .03, fadeOut: .08, category: "foley", enabled: true },
      { id: "p-music", eventId: "music-event", layerId: "main", role: "music", assetId: "music-build", start: 0, duration: 12, sourceOffset: 0, gainDb: -18, fadeIn: .4, fadeOut: .5, category: "music", enabled: true, loop: true },
      { id: "p-ui", eventId: "ui-event", layerId: "main", role: "foley", assetId: "ui-click", start: 5.02, duration: .3, sourceOffset: .1, gainDb: -3, fadeIn: .01, fadeOut: .02, category: "other", enabled: true },
      { id: "p-disabled", eventId: "muted-event", layerId: "main", role: "impact", assetId: "ignored", start: 6, duration: .5, sourceOffset: 0, gainDb: 0, fadeIn: 0, fadeOut: 0, category: "impact", enabled: true },
      { id: "p-off", eventId: "player-event", layerId: "detail", role: "foley", assetId: "ignored", start: 3.3, duration: .2, sourceOffset: 0, gainDb: 0, fadeIn: 0, fadeOut: 0, category: "foley", enabled: false }
    ],
    musicEnabled: true, autoMix: true
  };
}

export async function writeReaperFixtures(run: SfxRun) {
  await fs.writeFile(run.videoPath, "video fixture");
  for (const asset of run.assets) {
    const samples = 48;
    const wav = Buffer.alloc(44 + samples * 4);
    wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
    wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(192000, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34);
    wav.write("data", 36); wav.writeUInt32LE(samples * 4, 40);
    for (let i = 0; i < samples; i++) { wav.writeInt16LE(8192, 44 + i * 4); wav.writeInt16LE(4096, 46 + i * 4); }
    await fs.writeFile(asset.path, wav);
  }
}

export async function testReaperPortableProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "spielkiste-reaper-portable-"));
  try {
    const run = fixtureRun(root);
    await writeReaperFixtures(run);
    // A source is reused twice; another file has the same name in a different directory.
    run.placements.push({ ...run.placements[0], id: "p-boss-again", start: 8 });
    const duplicateDir = path.join(root, "another-library");
    await fs.mkdir(duplicateDir);
    const other = { ...run.assets[0], id: "other-roar", path: path.join(duplicateDir, run.assets[0].fileName) };
    await fs.writeFile(other.path, "different source with the same filename");
    run.assets.push(other);
    run.placements.push({ ...run.placements[0], id: "p-other-roar", assetId: other.id, start: 10 });
    const template = path.join(root, "template.rpp");
    await fs.writeFile(template, '<REAPER_PROJECT 0.1 "7.33/win64" 1\n>\n');
    const output = path.join(root, "package", "portable.rpp");
    const manifestRoot = path.join(root, "workbench", "reaper-exports");
    const result = await new ReaperExporter(undefined, manifestRoot).exportRun(run, { templatePath: template, outputPath: output });
    const rpp = await fs.readFile(output, "utf8");
    const references = [...rpp.matchAll(/^        FILE "([^"]+)"/gm)].map(match => match[1]);
    assert.equal(references.length, 7);
    assert.ok(references.every(ref => !path.isAbsolute(ref)), "工程媒体必须使用相对路径");
    assert.equal(new Set(references.filter(ref => ref.startsWith("Audio/"))).size, 5, "重复使用的素材只复制一次，重名文件各自保留");
    assert.ok(references.some(ref => ref.startsWith("Video/")), "视频也必须随工程复制");
    assert.doesNotMatch(rpp, /^\s*FOLDERDEPTH\b/m, "FOLDERDEPTH 不是 REAPER 7.33 的 RPP token，文件夹必须写为 ISBUS");
    assert.match(rpp, /ISBUS 1 1/);
    assert.match(rpp, /ISBUS 2 -2/);
    assert.doesNotMatch(rpp, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const moved = path.join(root, "moved-package");
    await fs.rename(path.dirname(output), moved);
    assert.deepEqual((await fs.readdir(moved)).sort(), ["Audio", "Video", "portable.rpp"]);
    for (const ref of references) await fs.access(path.join(moved, ref));
    assert.equal(result.manifestPath, path.join(manifestRoot, run.id, "portable.rpp.reaper-export.json"));
    await fs.access(result.manifestPath);
    await assert.rejects(fs.access(path.join(moved, "portable.rpp.reaper-export.json")));
    const tracks = result.manifest.tracks as Array<{ kind?: string; folderDepth?: number; placementId?: string; parentTrackId?: string }>;
    const folderTracks = tracks.filter(track => track.kind === "folder");
    assert.equal(folderTracks.length, 8);
    assert.equal((rpp.match(/^    <ITEM$/gm) || []).length, 7, "空白分类轨道不得带媒体");
    let depth = 0;
    for (const track of tracks) {
      if (track.placementId) { assert.equal(depth, 2); assert.ok(track.parentTrackId); }
      depth += track.folderDepth || 0;
      assert.ok(depth >= 0 && depth <= 2);
    }
    assert.equal(depth, 0, "所有分类文件夹必须正确关闭");
    const boss = result.manifest.tracks.find(track => track.placementId === "p-boss")!;
    const bossRef = (boss as unknown as { mediaPath: string }).mediaPath;
    assert.deepEqual(await fs.readFile(path.join(moved, bossRef)), await fs.readFile(run.assets[0].path), "保留模式必须逐字节保留音源");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

export async function testReaperActionCategoryUsesEventIntent() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "spielkiste-reaper-types-"));
  try {
    const run = fixtureRun(root);
    await writeReaperFixtures(run);
    const event = { ...run.events[0], id: "boss-contact", type: "impact", category: "impact" as const, description: "Boss咆哮中重拳捶胸", query: "boss chest impact" };
    const asset = { ...run.assets[0], id: "chest", fileName: "boss_chest_impact.wav", path: path.join(root, "boss_chest_impact.wav") };
    await fs.copyFile(run.assets[0].path, asset.path);
    run.events.push(event); run.assets.push(asset);
    run.placements.push({ ...run.placements[0], id: "p-chest", assetId: asset.id, eventId: event.id, category: "impact", role: "impact" });
    const template = path.join(root, "template.rpp"); await fs.writeFile(template, '<REAPER_PROJECT 0.1 "7.33/win64" 1\n>\n');
    const manifestRoot = path.join(root, "workbench", "reaper-exports");
    const result = await new ReaperExporter(undefined, manifestRoot).exportRun(run, { templatePath: template, outputPath: path.join(root, "package", "types.rpp") });
    const contact = result.manifest.tracks.find(track => track.placementId === "p-chest")!;
    assert.equal(contact.soundType, "动作", "画面描述顺带提及咆哮时，捶胸命中仍归动作");
    assert.equal(contact.folderDepth, -1, "动作文件夹结束后，BOSS 吼叫仍应在同一对象下");
    assert.equal(result.manifest.tracks.find(track => track.placementId === "p-boss")!.folderDepth, -2);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

export async function testReaperExportApi() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "spielkiste-reaper-api-"));
  const service = new SfxService(path.join(root, "output"));
  const server = http.createServer((req, res) => { void handleSfxRequest(req, res, new URL(req.url!, "http://localhost"), service); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const template = path.join(root, "template.rpp");
    const requestedOutput = path.join(root, "exported");
    const output = path.join(root, "exported.rpp");
    await fs.writeFile(template, '<REAPER_PROJECT 0.1 "7.33/win64" 1794762253\n  <EXTENSIONS\n  >\n>\n', "utf8");
    const run = fixtureRun(root);
    await writeReaperFixtures(run);
    await service.store.save(run);
    const response = await fetch(`${base}/api/sfx/runs/${run.id}/export/reaper`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ templatePath: template, outputPath: requestedOutput }) });
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json() as { outputPath: string; manifestPath: string; projectDirectory: string; placementTrackCount: number };
    assert.equal(body.outputPath, output);
    assert.equal(body.manifestPath, path.join(root, "reaper-exports", run.id, "exported.rpp.reaper-export.json"));
    assert.equal(body.projectDirectory, path.dirname(output));
    assert.equal(body.placementTrackCount, 4);
    const invalid = await fetch(`${base}/api/sfx/runs/${run.id}/export/reaper`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channelMode: "invalid" }) });
    assert.equal(invalid.status, 400);
    for(const settings of [{audioFormat:"mp3"},{sampleRate:12345},{sampleRate:"48000"}]) {
      const rejected=await fetch(`${base}/api/sfx/runs/${run.id}/export/reaper`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(settings)});
      assert.equal(rejected.status,400,"invalid native conversion settings must be rejected before export");
    }
    await fs.access(output);
    await fs.access(body.manifestPath);
    await assert.rejects(fs.access(output + ".reaper-export.json"));
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
}

export async function testReaperExportUi() {
  const html = await fs.readFile(path.join(process.cwd(), "src", "ui", "public", "sfx.html"), "utf8");
  const script = await fs.readFile(path.join(process.cwd(), "src", "ui", "public", "sfx.js"), "utf8");
  assert.match(html, /导出 Reaper 工程/);
  assert.match(html, /reaper-dither/);
  assert.match(html, /reaper-noise-shaping/);
  assert.match(html, /Normalize|归一化/);
  assert.match(script, /export\/reaper/);
  assert.match(script, /noiseShaping/);
}

export async function testReaperNamesWithoutExtension() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "spielkiste-reaper-names-"));
  try {
    const run = fixtureRun(root);
    await writeReaperFixtures(run);
    const templatePath = path.join(root, "template.rpp");
    await fs.writeFile(templatePath, '<REAPER_PROJECT 0.1 "7.33/win64" 1\n>\n');
    const exporter = new ReaperExporter(undefined, path.join(root, "workbench", "reaper-exports"));
    for (const [input, expected] of [["Boss 技能", "Boss 技能.rpp"], ["Boss.v2", "Boss.v2.rpp"], ["existing.rpp", "existing.rpp"], ["existing.RPP", "existing.RPP"]]) {
      const outputPath = path.join(root, input.replace(/\.rpp$/i, ""), input);
      const exported = await exporter.exportRun(run, { templatePath, outputPath });
      assert.equal(exported.outputPath, path.join(path.dirname(outputPath), expected));
      await fs.access(exported.outputPath);
      assert.match(await fs.readFile(exported.outputPath, "utf8"), /<REAPER_PROJECT/);
    }
    const named = await exporter.exportRun(run, { outputPath: "只输入名字" });
    assert.equal(path.basename(named.outputPath), "只输入名字.rpp");
    assert.equal(path.dirname(named.projectDirectory), path.join(root, "workbench", "reaper-projects"), "a name must create its own portable folder under the export root");
    assert.deepEqual((await fs.readdir(named.projectDirectory)).sort(), ["Audio", "Video", "只输入名字.rpp"]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

export async function testReaperExporter() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "spielkiste-reaper-"));
  try {
    const template = path.join(root, "template.rpp");
    const output = path.join(root, "out.rpp");
    await fs.writeFile(template, [
      '<REAPER_PROJECT 0.1 "7.33/win64" 1794762253',
      '  RENDER_RANGE 1 0 0 2 1000',
      '  <TRACK {OLD-TRACK}',
      '    NAME "old track"',
      '  >',
      '  <EXTENSIONS',
      '  >',
      '>',
      ''
    ].join("\n"), "utf8");
    const run = fixtureRun(root);
    await writeReaperFixtures(run);
    const manifestRoot = path.join(root, "workbench", "reaper-exports");
    const result = await new ReaperExporter(undefined, manifestRoot).exportRun(run, { templatePath: template, outputPath: output });
    assert.equal(result.outputPath, output);
    assert.equal(result.manifestPath, path.join(manifestRoot, run.id, "out.rpp.reaper-export.json"));
    const rpp = await fs.readFile(output, "utf8");
    const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8")) as {
      tracks: Array<{ placementId?: string; object: string; soundType: string; included: boolean; source: { start: number; duration: number; sourceOffset: number; fadeIn: number; fadeOut: number; gainDb: number } }>;
      skippedPlacements: string[];
    };
    assert.equal((rpp.match(/^  <TRACK /gm) || []).length, 13);
    assert.doesNotMatch(rpp, /old track/);
    assert.match(rpp, /NAME "VIDEO · 原视频"/);
    assert.match(rpp, /RENDER_RANGE 1 0 0 12 1000/);
    assert.match(rpp, /RENDER_DITHER 0/);
    assert.match(rpp, /RENDER_NORMALIZE 262144/);
    assert.match(rpp, /RENDER_TAILFLAG 0/);
    assert.match(rpp, /RENDER_ADDTOPROJ 0/);
    assert.match(rpp, /<SOURCE VIDEO\n        FILE "/);
    assert.match(rpp, /NAME "source\.mp4"[\s\S]*?VOLPAN 0 0 1 -1/);
    assert.match(rpp, /POSITION 1\.25/);
    assert.match(rpp, /LENGTH 0\.75/);
    assert.match(rpp, /SOFFS 0\.4/);
    assert.match(rpp, /FADEIN 1 0\.02 0 1 0 0 0/);
    assert.match(rpp, /FADEOUT 1 0\.1 0 1 0 0 0/);
    assert.match(rpp, /VOLPAN 0\.5011872336272722 0 1 -1/);
    const trackVolumeLines = rpp.match(/^    VOLPAN [^\r\n]+$/gm) || [];
    assert.ok(trackVolumeLines.every(line => line.startsWith("    VOLPAN 1 ")), "轨道增益必须保持 unity，实际增益只写在 item");
    assert.match(rpp, /LOOP 1/);
    assert.equal(manifest.tracks.filter(track => track.included && track.placementId).length, 4);
    assert.deepEqual(manifest.skippedPlacements.sort(), ["p-disabled", "p-off"]);
    assert.equal(manifest.tracks[0].object, "VIDEO");
    assert.deepEqual(manifest.tracks.filter(track => track.placementId).map(track => [track.object, track.soundType]), [
      ["BOSS", "吼叫"], ["角色", "动作"], ["音乐", "音乐"], ["UI", "UI"]
    ]);
    const boss = manifest.tracks.find(track => track.placementId === "p-boss")!;
    assert.deepEqual(boss.source, { start: 1.25, duration: .75, sourceOffset: .4, fadeIn: .02, fadeOut: .1, gainDb: -6 });
    assert.equal(boss.object, "BOSS");
    const typedManifest = result.manifest;
    const bossColor = typedManifest.tracks.find(track => track.placementId === "p-boss")!.color;
    assert.equal(bossColor, 0x1000000 + 0xE8 + (0x5D << 8) + (0x04 << 16), "Windows REAPER 自定义颜色需要 native BGR 整数");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

