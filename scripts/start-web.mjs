import { startToolWatcher } from "./tool-git.mjs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
if (Number(process.versions.node.split(".")[0]) < 22) {
  throw new Error("Spielkiste requires Node.js 22 or later. Please install Node.js LTS.");
}

// The regular web entry owns the single code-backup watcher. When start-ui.bat
// also launches the SFX workspace, it disables the second watcher there.
startToolWatcher(process.cwd());

const port = Number(process.env.PORT || 4317);
const execFileAsync = promisify(execFile);
async function health() {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    return response.ok ? await response.json() : null;
  } catch { return null; }
}
async function listenerPid() {
  if (process.platform !== "win32") return null;
  try {
    const command = `$connection = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($connection) { [Console]::Write($connection.OwningProcess) }`;
    const result = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], { windowsHide: true });
    const value = String(result.stdout || "").trim();
    return /^\d+$/.test(value) ? value : null;
  } catch { return null; }
}
async function stopStaleServer() {
  const pid = await listenerPid();
  if (!pid || pid === String(process.pid)) return false;
  try { await execFileAsync("taskkill.exe", ["/PID", pid, "/T", "/F"], { windowsHide: true }); } catch { return false; }
  for (let i = 0; i < 20; i++) {
    if (!await health()) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return !await health();
}

const existing = await health();
if (existing) {
  if (!await stopStaleServer()) throw new Error(`端口 ${port} 上的旧网页版服务无法关闭，请关闭旧启动窗口后再运行。`);
}

const build = spawn(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"], {
  stdio: "inherit",
  windowsHide: true
});
await new Promise((resolve, reject) => {
  build.once("error", reject);
  build.once("exit", code => code === 0 ? resolve() : reject(new Error("编译失败")));
});

await import("dotenv/config");
process.env.SPIELKISTE_WEB_ENTRY = "1";
await import("../dist/src/ui/server.js");
