import { appResource } from "../sfx/RuntimePaths.js";
import "dotenv/config";
import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { OrchestratorAgent } from "../orchestrator/OrchestratorAgent.js";
import { ProjectConfig } from "../schemas/index.js";
import { SfxService } from "../sfx/SfxService.js";
import { handleSfxRequest } from "./sfx-routes.js";

const PORT = Number(process.env.PORT ?? 4317);
const PUBLIC_DIR = appResource("src", "ui", "public");
const sfxService = new SfxService();

type Job = {
  id: string;
  status: "running" | "success" | "failed";
  startedAt: string;
  finishedAt?: string;
  runId?: string;
  runDir?: string;
  markdownPath?: string;
  feishuUrl?: string;
  error?: string;
};

const jobs = new Map<string, Job>();
const folderPickers = new Map<
  string,
  {
    id: string;
    status: "running" | "success" | "cancelled" | "failed";
    startedAt: string;
    path?: string;
    error?: string;
    resultPath: string;
    helper?: ReturnType<typeof spawn>;
  }
>();

const server = http.createServer(async (req, res) => {
  try {
    const host=req.headers.host||'';
    if(!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)||req.headers.origin&&req.headers.origin!==`http://${host}`||req.headers['sec-fetch-site']==='cross-site')return sendJson(res,{error:'仅允许本机同源访问'},403);
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (await handleSfxRequest(req, res, url, sfxService)) return;
    if (req.method === "POST" && url.pathname === "/api/upload-session") {
      const body = (await readJsonBody(req)) as { targetRoot?: string; parentRoot?: string; folderName?: string };
      return sendJson(res, await createUploadSession(body));
    }
    if (req.method === "POST" && url.pathname === "/api/upload") {
      return sendJson(res, await uploadFile(req, url), 201);
    }
    if (req.method === "POST" && url.pathname === "/api/delete-upload") {
      const body = (await readJsonBody(req)) as { filePath?: string };
      return sendJson(res, await deleteUploadedFile(body));
    }
    if (req.method === "POST" && url.pathname === "/api/pick-folder") {
      const body = (await readJsonBody(req)) as { initialPath?: string; description?: string };
      return sendJson(res, await startFolderPicker(body), 202);
    }
    if (req.method === "POST" && url.pathname === "/api/open-folder") {
      const body = (await readJsonBody(req)) as { folderPath?: string };
      return sendJson(res, await openFolder(body));
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/pick-folder/")) {
      return sendJson(res, await getFolderPicker(url.pathname.split("/").pop() ?? ""));
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
      return sendJson(res, jobs.get(url.pathname.split("/").pop() ?? "") ?? { error: "job not found" }, jobs.has(url.pathname.split("/").pop() ?? "") ? 200 : 404);
    }
    if (req.method === "GET" && url.pathname === "/api/runs") {
      return sendJson(res, await listRuns());
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/runs/")) {
      return sendJson(res, await getRun(url.pathname.split("/").pop() ?? ""));
    }
    if (req.method === "POST" && url.pathname === "/api/run") {
      const body = (await readJsonBody(req)) as Partial<ProjectConfig>;
      const job = createJob();
      jobs.set(job.id, job);
      void runProject(body, job);
      return sendJson(res, job, 202);
    }
    if (req.method === "GET" && url.pathname === "/api/health") {
      return sendJson(res, { ok: true, port: PORT, webEntry: process.env.SPIELKISTE_WEB_ENTRY === "1" });
    }
    if (req.method === "GET" && url.pathname === "/api/path-preview") {
      return sendJson(
        res,
        getPathPreview({
          parentRoot: url.searchParams.get("parentRoot") ?? undefined,
          folderName: url.searchParams.get("folderName") ?? undefined
        })
      );
    }
    return serveStatic(req, res, url.pathname);
  } catch (error) {
    return sendJson(res, { error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

export const serverReady = new Promise<number>((resolve, reject) => {
server.once("error", reject);
server.listen(PORT, "127.0.0.1", () => {
  const actualPort=(server.address() as import("node:net").AddressInfo).port;
  console.log(`Spielkiste：http://localhost:${actualPort}/sfx`);
  resolve(actualPort);
});
});
export { server };

function createJob(): Job {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    status: "running",
    startedAt: new Date().toISOString()
  };
}

async function runProject(body: Partial<ProjectConfig>, job: Job) {
  try {
    const orchestrator = new OrchestratorAgent();
    const result = await orchestrator.run({
      ...body,
      dryRun: body.dryRun ?? true,
      referenceFiles: body.referenceFiles ?? [],
      referenceFeishuDocs: body.referenceFeishuDocs ?? []
    });
    const feishuError = result.state.feishuResult?.error;
    job.status = feishuError ? "failed" : "success";
    job.finishedAt = new Date().toISOString();
    job.runId = result.runId;
    job.runDir = result.runDir;
    job.markdownPath = result.state.feishuResult?.localMarkdownPath;
    job.feishuUrl = result.state.feishuResult?.url;
    if (feishuError) {
      job.error = stringifyError(feishuError);
    }
  } catch (error) {
    job.status = "failed";
    job.finishedAt = new Date().toISOString();
    job.error = error instanceof Error ? error.message : String(error);
  }
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
  const relativePath = pathname === "/" ? "index.html" : pathname === "/sfx" || pathname === "/sfx/" ? "sfx.html" : pathname === "/sfx/compare" || pathname === "/sfx/compare/" ? "sfx-compare.html" : pathname.replace(/^\/+/, "");
  const filePath = path.normalize(path.join(PUBLIC_DIR, relativePath));
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const content = await fs.readFile(filePath);
    res.writeHead(200, {
      "content-type": contentType(filePath),
      "cache-control": "no-store, max-age=0"
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

async function readBinaryBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function sendJson(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

async function createUploadSession(input: { targetRoot?: string; parentRoot?: string; folderName?: string }) {
  const sessionId = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;
  const root = resolveUploadRoot(input, sessionId);
  const folders = {
    root,
    videos: path.join(root, "videos"),
    images: path.join(root, "images"),
    requirements: path.join(root, "requirements"),
    skillDocuments: path.join(root, "skill_documents"),
    references: path.join(root, "references"),
    styles: path.join(root, "styles"),
    audioReferences: path.join(root, "audio_references")
  };
  await Promise.all(Object.values(folders).map((folder) => fs.mkdir(folder, { recursive: true })));
  return { sessionId, folders };
}

async function uploadFile(req: http.IncomingMessage, url: URL) {
  const sessionId = requiredParam(url, "sessionId");
  const kind = normalizeKind(requiredParam(url, "kind"));
  const targetRoot = url.searchParams.get("targetRoot") ?? undefined;
  const parentRoot = url.searchParams.get("parentRoot") ?? undefined;
  const folderName = url.searchParams.get("folderName") ?? undefined;
  const originalName = decodeURIComponent(req.headers["x-file-name"]?.toString() || "upload.bin");
  const relativePath = decodeURIComponent(req.headers["x-relative-path"]?.toString() || originalName);
  const root = resolveUploadRoot({ targetRoot, parentRoot, folderName }, sessionId);
  const kindDir = path.join(root, kind === "sfxLibrary" ? "audio_references" : kind);
  const safePath = safeRelativePath(relativePath || originalName);
  const outputPath = path.join(kindDir, safePath);
  if (!outputPath.startsWith(kindDir)) {
    throw new Error("非法上传路径。");
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const body = await readBinaryBody(req);
  await fs.writeFile(outputPath, body);
  return {
    fileName: originalName,
    kind,
    sizeBytes: body.length,
    path: outputPath,
    folders: {
      root,
      videos: path.join(root, "videos"),
      images: path.join(root, "images"),
      requirements: path.join(root, "requirements"),
      skillDocuments: path.join(root, "skill_documents"),
      references: path.join(root, "references"),
      styles: path.join(root, "styles"),
      audioReferences: path.join(root, "audio_references")
    }
  };
}

async function deleteUploadedFile(input: { filePath?: string }) {
  if (!input.filePath) return { deleted: false, message: "未提供文件路径。" };
  const resolved = path.resolve(process.cwd(), input.filePath);
  const workspace = path.resolve(process.cwd());
  if (!resolved.startsWith(workspace)) {
    throw new Error("只允许删除当前工具工作目录内的上传文件。");
  }
  try {
    await fs.unlink(resolved);
    return { deleted: true, path: resolved };
  } catch (error) {
    return {
      deleted: false,
      path: resolved,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

function resolveUploadRoot(input: { targetRoot?: string; parentRoot?: string; folderName?: string }, sessionId: string): string {
  if (input.targetRoot?.trim()) {
    return path.resolve(process.cwd(), input.targetRoot.trim());
  }
  const parent = input.parentRoot?.trim() || path.join(".output", "upload_sessions", sessionId);
  const folderName = safeSegment(input.folderName?.trim() || `outsourcing-${sessionId}`);
  return path.resolve(process.cwd(), parent, folderName);
}

function getPathPreview(input: { parentRoot?: string; folderName?: string }) {
  const parentRoot = input.parentRoot?.trim();
  if (!parentRoot) {
    return { selected: false, message: "尚未选择外包文档文件夹路径。" };
  }
  const folderName = safeSegment(input.folderName?.trim() || "外包文件夹");
  const resolvedParent = path.resolve(process.cwd(), parentRoot);
  return {
    selected: true,
    parentRoot: resolvedParent,
    projectRoot: path.join(resolvedParent, folderName)
  };
}

function requiredParam(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) throw new Error(`缺少参数：${name}`);
  return value;
}

function normalizeKind(kind: string): string {
  const allowed = new Set(["videos", "images", "requirements", "skillDocuments", "references", "styles", "audioReferences", "sfxLibrary"]);
  if (!allowed.has(kind)) throw new Error(`不支持的上传类型：${kind}`);
  return kind;
}

function safeRelativePath(value: string): string {
  const normalized = path
    .normalize(value)
    .replace(/^([a-zA-Z]:)?[\\/]+/, "")
    .split(/[\\/]+/)
    .filter((part) => part && part !== "." && part !== "..")
    .map(safeSegment)
    .join(path.sep);
  return normalized || "upload.bin";
}

function safeSegment(value: string): string {
  return value.replace(/[<>:"|?*\x00-\x1F]/g, "_").slice(0, 160);
}

async function listRuns() {
  const runsDir = path.join(process.cwd(), ".output", "runs");
  try {
    const entries = await fs.readdir(runsDir, { withFileTypes: true });
    const runs = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const runId = entry.name;
          const summaryPath = path.join(runsDir, runId, "final_summary.json");
          const manifestPath = path.join(runsDir, runId, "run_manifest.json");
          return {
            runId,
            summary: await readOptionalJson(summaryPath),
            manifest: await readOptionalJson(manifestPath)
          };
        })
    );
    return runs.reverse();
  } catch {
    return [];
  }
}

async function getRun(runId: string) {
  const runDir = path.join(process.cwd(), ".output", "runs", runId);
  const summary = await readOptionalJson(path.join(runDir, "final_summary.json"));
  const manifest = await readOptionalJson(path.join(runDir, "run_manifest.json"));
  const markdownPath = typeof summary === "object" && summary && "markdownPath" in summary ? String(summary.markdownPath) : path.join(runDir, "final_document.md");
  return {
    runId,
    runDir,
    summary,
    manifest,
    markdown: await readOptionalText(markdownPath)
  };
}

async function readOptionalJson(filePath: string) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function readOptionalText(filePath: string) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function contentType(filePath: string): string {
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".ico")) return "image/x-icon";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  return "application/octet-stream";
}

async function startFolderPicker(input: { initialPath?: string; description?: string }) {
  if (process.platform !== "win32") {
    throw new Error("当前文件夹选择器只支持 Windows；请手动填写路径。");
  }
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const pickerDir = path.join(process.cwd(), ".output", "folder-pickers");
  await fs.mkdir(pickerDir, { recursive: true });
  const resultPath = path.join(pickerDir, `${id}.json`);
  const requestPath = path.join(pickerDir, `${id}.request.json`);
  const initialPath = typeof input.initialPath === 'string' ? input.initialPath.trim().replace(/^"|"$/g,'') : '';
  const description = typeof input.description === 'string' ? input.description.slice(0,200) : '选择文件夹';
  await fs.writeFile(requestPath,JSON.stringify({initialPath,description,resultPath}),"utf8");
  const picker: NonNullable<ReturnType<typeof folderPickers.get>> = {
    id,
    status: "running" as const,
    startedAt: new Date().toISOString(),
    resultPath
  };
  folderPickers.set(id, picker);
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", appResource('scripts','pick-folder.ps1'), "-RequestPath", requestPath],
    {
      // PowerShell only launches the helper. Hiding the process here can
      // propagate SW_HIDE to the WinForms dialog and leave the page polling
      // forever without a visible Windows folder window.
      windowsHide: false,
      stdio: "ignore"
    }
  );
  picker.helper=child;
  child.once('error',error=>{picker.status='failed';picker.error=`系统文件夹窗口启动失败：${error.message}`;});
  child.once('exit',(code,signal)=>{
    if(picker.status==='running'){picker.status='failed';picker.error=`系统文件夹窗口已退出（${code ?? signal}），未返回选择结果。`;}
  });
  child.unref();
  return {
    id,
    status: "running",
    message: "已打开 Windows 文件夹选择窗口。如果没看到，请检查任务栏或切换窗口。"
  };
}

async function getFolderPicker(id: string) {
  const picker = folderPickers.get(id);
  if (!picker) return { id, status: "failed", error: "未找到文件夹选择任务。" };
  const elapsedMs = Date.now() - new Date(picker.startedAt).getTime();
  try {
    const result=JSON.parse((await fs.readFile(picker.resultPath, "utf8")).replace(/^\uFEFF/, ""));
    if(result.status==='success'&&typeof result.path==='string'&&result.path){picker.status='success';picker.path=result.path;delete picker.error;}
    else if(result.status==='cancelled'){picker.status='cancelled';delete picker.error;}
    else if(result.status==='failed'){picker.status='failed';picker.error=result.error||'系统文件夹选择失败。';}
  } catch {
    if (picker.status==='running'&&elapsedMs > 120000) {
      picker.helper?.kill();
      picker.status = "failed";
      picker.error = "文件夹选择超时；请直接把路径粘贴到输入框。";
    }
  }
  const {helper,resultPath,...snapshot}=picker;
  return snapshot;
}

async function openFolder(input: { folderPath?: string }) {
  if (!input.folderPath?.trim()) throw new Error("请先选择或填写文件夹路径。");
  const folderPath = path.resolve(process.cwd(), input.folderPath.trim());
  await fs.mkdir(folderPath, { recursive: true });
  if (process.platform === "win32") {
    const child = spawn("explorer.exe", [folderPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: false
    });
    child.unref();
  } else {
    throw new Error("当前只支持在 Windows 上打开文件夹；请手动复制路径。");
  }
  return { path: folderPath, opened: true };
}

