import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ffmpegBinary, ffprobeBinary } from "../src/sfx/FfmpegBinaries.js";

export async function testOnboardingFfmpegUsesCurrentUserInstallation() {
  if (process.platform !== "win32") return;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "spielkiste-media-install-"));
  const previous = { local: process.env.LOCALAPPDATA, ffmpeg: process.env.FFMPEG_PATH, ffprobe: process.env.FFPROBE_PATH };
  try {
    const binary = path.join(root, "Microsoft", "WinGet", "Packages", "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe", "ffmpeg-99.0-full_build", "bin", "ffmpeg.exe");
    await fs.mkdir(path.dirname(binary), { recursive: true }); await fs.writeFile(binary, "fixture");
    process.env.LOCALAPPDATA = root; delete process.env.FFMPEG_PATH; delete process.env.FFPROBE_PATH;
    assert.equal(ffmpegBinary(), binary, "a teammate's WinGet version must be discovered without hardcoding version 8.1.1");
    assert.equal(ffprobeBinary(), path.join(path.dirname(binary), "ffprobe.exe"));
    const custom = path.join(root, "custom", "ffmpeg.exe"); await fs.mkdir(path.dirname(custom)); await fs.writeFile(custom, "fixture");
    process.env.FFMPEG_PATH = custom;
    assert.equal(ffmpegBinary(), custom, ".env or saved process settings loaded after module import must still take effect");
  } finally {
    for (const [key, value] of [["LOCALAPPDATA", previous.local], ["FFMPEG_PATH", previous.ffmpeg], ["FFPROBE_PATH", previous.ffprobe]]) { if (value === undefined) delete process.env[key!]; else process.env[key!] = value; }
    await fs.rm(root, { recursive: true, force: true });
  }
}
