import { startToolWatcher } from "./tool-git.mjs";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Spielkiste requires Node.js 22 or later. Please install Node.js LTS.");
startToolWatcher(process.cwd());
const port = process.env.PORT || "4320";
const url = `http://127.0.0.1:${port}/sfx`;
const execFileAsync = promisify(execFile);

async function health() {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/sfx/health`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return null;
    return await response.json();
  } catch { return null; }
}

async function aiConfigStatus() {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/sfx/ai-config`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return null;
    return await response.json();
  } catch { return null; }
}

async function listenerPid() {
  if (process.platform !== "win32") return null;
  try {
    const command = `$connection = Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($connection) { [Console]::Write($connection.OwningProcess) }`;
    const result = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], { windowsHide: true });
    const value = String(result.stdout || "").trim();
    return /^\d+$/.test(value) ? value : null;
  } catch { return null; }
}

async function stopStaleServer() {
  const pid = await listenerPid();
  if (!pid || pid === String(process.pid)) return false;
  try {
    await execFileAsync("taskkill.exe", ["/PID", pid, "/T", "/F"], { windowsHide: true });
  } catch { return false; }
  for (let i = 0; i < 20; i++) {
    if (!await health()) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return !await health();
}

function openBrowser() {
  if (process.env.SFX_OPEN_BROWSER === "0" || process.platform !== "win32") return;
  try {
    const opener = spawn("rundll32.exe", ["url.dll", "FileProtocolHandler", url], { windowsHide: true, detached: true, stdio: "ignore" });
    opener.on("error", () => console.log(`请手动打开 ${url}`));
    opener.unref();
  } catch { console.log(`请手动打开 ${url}`); }
}

try {
  const build = spawn(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"], { stdio: "inherit", windowsHide: true });
  await new Promise((resolve, reject) => {
    build.once("error", reject);
    build.once("exit", code => code === 0 ? resolve() : reject(new Error("编译失败")));
  });

  const { isCurrentSfxHealth } = await import("../dist/src/ui/SfxServerCompatibility.js");
  const existing = await health();
  if (existing) {
    if (isCurrentSfxHealth(existing) && process.env.SFX_FORCE_REFRESH !== "1") {
      console.log(`Spielkiste 已在运行：${url}`);
      openBrowser();
      process.exit(0);
    }
    if (existing.standard?.workflow === "reference-v6") {
      const runs = await fetch(`http://127.0.0.1:${port}/api/sfx/runs`, { signal: AbortSignal.timeout(3000) }).then(response => response.json());
      if (!Array.isArray(runs) || runs.some(run => ["analyzing", "rendering"].includes(run.status))) throw new Error("Spielkiste 正在处理项目，请等待完成后重新启动以加载更新。");
      const stopped = await stopStaleServer();
      if (!stopped) throw new Error(`端口 ${port} 上的旧 Spielkiste 服务无法关闭，请关闭旧启动窗口后再运行。`);
      console.log(`已刷新端口 ${port} 上的 Spielkiste 服务。`);
    } else {
      throw new Error(`端口 ${port} 已被其他服务占用，请先关闭该服务。`);
    }
  }

  await import("dotenv/config");
  const { runFfmpeg } = await import("../dist/src/sfx/FfmpegBinaries.js");
  try {
    await runFfmpeg(["__ffprobe__", "-version"], { timeout: 10000 });
    await runFfmpeg(["-version"], { timeout: 10000 });
  } catch (error) {
    console.warn(`FFmpeg 预检未完成，工作台仍会启动；生成或读取媒体时会给出具体错误：${error.message}`);
  }

  process.env.PORT = port;
  await import("../dist/src/ui/server.js");
  console.log(`Spielkiste：${url}`);
  const ai = await aiConfigStatus();
  if (ai && !ai.ready) console.warn(`AI 配置预检：未就绪（${ai.error || "请打开工作台右上角 AI 连接设置"}）。工作台仍会启动，但标准生成会先要求完成连接测试。`);
  else if (ai) console.log(`AI 配置预检：已就绪（${ai.model}）。`);
  openBrowser();
} catch (error) {
  console.error(`启动失败：${error.message}`);
  process.exitCode = 1;
}
