import { appResource } from "../sfx/RuntimePaths.js";
import http from "node:http";
import { promises as fs, createReadStream } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { SfxService } from "../sfx/SfxService.js";
import { clientRunPayload } from "../sfx/SfxRunStore.js";
import { ExclusionFields,KeywordPreferencesSchema,SfxError } from "../sfx/models.js";
import {buildWorkflowReport} from "../sfx/WorkflowReport.js";
import {workflowResources,workflowBundle,readWorkflowGuide,readWorkflowSkill} from "../sfx/WorkflowResources.js";
import {SFX_WORKFLOW} from "../sfx/WorkflowPolicy.js";
import {styleBlendOptions} from "../sfx/CreativeBrief.js";
import {STYLE_PRESETS} from "../sfx/StyleResearch.js";
import {listLocalFolders,searchLocalFolders} from "./LocalFolders.js";
import {SFX_API_VERSION,SFX_REQUIRED_CAPABILITIES} from "./SfxServerCompatibility.js";
import { AiConfigService } from "../sfx/SfxAiConfig.js";

async function readJson(req: http.IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 4 * 1024 * 1024) throw new SfxError("编辑内容超过 4MB", 413); chunks.push(Buffer.from(chunk)); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw new SfxError("JSON 格式无效"); }
}
function json(res: http.ServerResponse, data: unknown, status = 200) { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(data)); }
export async function streamSfxFile(req: http.IncomingMessage, res: http.ServerResponse, file: string, download?: string) {
  const stat = await fs.stat(file); const size = stat.size;
  const mime: Record<string, string> = { ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".flac": "audio/flac", ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".jpg": "image/jpeg", ".json": "application/json; charset=utf-8", ".csv": "text/csv; charset=utf-8" };
  const headers: Record<string, string | number> = { "content-type": mime[path.extname(file).toLowerCase()] || "application/octet-stream", "accept-ranges": "bytes", "cache-control": "no-store", "x-content-type-options": "nosniff" };
  if (download) headers["content-disposition"] = `attachment; filename="${download}"`;
  let start = 0; let end = size - 1; let status = 200;
  if (req.headers.range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!m || (!m[1] && !m[2])) { res.writeHead(416, { "content-range": `bytes */${size}` }); res.end(); return; }
    start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start > end || start >= size || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) { res.writeHead(416, { "content-range": `bytes */${size}` }); res.end(); return; }
    status = 206; headers["content-range"] = `bytes ${start}-${end}/${size}`;
  }
  headers["content-length"] = Math.max(0, end - start + 1); res.writeHead(status, headers);
  if (!size || req.method === "HEAD") { res.end(); return; }
  const stream = createReadStream(file, { start, end });
  res.on("close", () => stream.destroy()); stream.on("error", () => res.destroy()); stream.pipe(res);
}
export async function handleSfxRequest(req: http.IncomingMessage, res: http.ServerResponse, url: URL, service: SfxService): Promise<boolean> {
  if(url.pathname==="/sfx-asset-exclusions.js") {
    res.writeHead(200,{"content-type":"text/javascript; charset=utf-8","cache-control":"no-store"});
    res.end(await fs.readFile(appResource("dist/src/sfx/AssetExclusions.js"),"utf8"));return true;
  }
  if(url.pathname==="/sfx-clip-edit.js") {
    res.writeHead(200,{"content-type":"text/javascript; charset=utf-8","cache-control":"no-store"});
    res.end(await fs.readFile(appResource("dist/src/sfx/ClipEdit.js"),"utf8"));return true;
  }
  if(url.pathname==="/WorkflowPolicy.js") {
    res.writeHead(200,{"content-type":"text/javascript; charset=utf-8","cache-control":"no-store"});
    res.end(await fs.readFile(appResource("dist/src/sfx/WorkflowPolicy.js"),"utf8"));return true;
  }
  if (!url.pathname.startsWith("/api/sfx/")) return false;
  try {
    const host = req.headers.host || "";
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)) throw new SfxError("仅允许本机访问", 403);
    if (req.headers.origin && req.headers.origin !== `http://${host}`) throw new SfxError("不允许跨站访问本地文件", 403);
    if (req.headers["sec-fetch-site"] === "cross-site") throw new SfxError("不允许跨站访问", 403);
    if(req.method==='GET'&&url.pathname==='/api/sfx/search-folders') {
      const controller=new AbortController();res.on('close',()=>controller.abort());
      const result=await searchLocalFolders({path:url.searchParams.get('path')||'',query:url.searchParams.get('query')||'',signal:controller.signal});
      if(!res.destroyed)json(res,result);return true;
    }
    if(req.method==="GET"&&url.pathname==="/api/sfx/local-folders") {
      try {json(res,await listLocalFolders({path:url.searchParams.get("path")||undefined,offset:Number(url.searchParams.get("offset"))||0}));}
      catch(error){json(res,{error:error instanceof Error?error.message:String(error)},400);}
      return true;
    }
    const parts = url.pathname.slice("/api/sfx/".length).split("/");
    if(parts[0]==="library-index"){
      if(req.method==="POST"&&!parts[1])json(res,service.refreshLibraryIndexes(await readJson(req)),202);
      else if(req.method==="GET"&&parts[1]&&!parts[2])json(res,service.libraryIndexStatus(parts[1]));
      else throw new SfxError("接口不存在",404);
      return true;
    }
    if(parts[0]==='styles') {
      if(req.method==='GET'&&!parts[1])json(res,{presets:STYLE_PRESETS.map(({style,works})=>({style,works})),profiles:await service.styles.list()});
      else if(req.method==='POST'&&parts[1]==='check'){
        const body=z.object({style:z.string().trim().max(120).optional(),referenceWorks:z.array(z.string().trim().min(1).max(120)).max(12).optional(),soundRequirements:z.string().trim().max(4000).optional(),refresh:z.boolean().default(false)}).parse(await readJson(req));
        json(res,await service.checkStyleDirection(body,undefined,body.refresh));
      }else if(req.method==='POST'&&parts[1]==='research'){
        const body=z.object({style:z.string().trim().min(1).max(120),targetType:z.enum(['style','work']).default('style'),refresh:z.boolean().default(false)}).parse(await readJson(req));
        const config=await new AiConfigService().resolve();
        json(res,await service.styles.research(body.style,config.model,config.reasoningEffort||'high',undefined,body.refresh,body.targetType));
      }else throw new SfxError('接口不存在',404);
      return true;
    }

    if(parts[0]==='git-config') {
      if(req.method==='GET'&&!parts[1])json(res,await service.projectGit.snapshot());
      else if(req.method==='POST'&&!parts[1])json(res,await service.projectGit.save(await readJson(req)));
      else if(req.method==='POST'&&parts[1]==='test')json(res,await service.projectGit.test());
      else if(req.method==='POST'&&parts[1]==='login')json(res,await service.projectGit.login(),202);
      else if(req.method==='GET'&&parts[1]==='login')json(res,service.projectGit.loginStatus());
      else if(req.method==='GET'&&parts[1]==='projects')json(res,await service.projectGit.remoteProjects());
      else if(req.method==='POST'&&parts[1]==='import'){const body=z.object({projectId:z.string().uuid()}).parse(await readJson(req));json(res,await service.importGitProject(body.projectId));}
      else throw new SfxError('接口不存在',404);
      return true;
    }
    if (parts[0] === "ai-config") {
      const ai = new AiConfigService();
      if (req.method === "GET" && !parts[1]) { json(res, await ai.snapshot()); return true; }
      if (req.method === "POST" && parts[1] === "test") {
        const body = z.object({ mode: z.literal("ccswitch").optional(), configPath: z.string().trim().max(2000).optional(), model: z.string().trim().min(1).max(200).optional(), baseUrl: z.string().trim().max(2000).optional(), bearer: z.string().max(4000).optional(), reasoningEffort: z.enum(["high", "xhigh"]).optional(), wireApi: z.enum(["responses", "chat_completions"]).optional() }).parse(await readJson(req));
        const result = await ai.testConnection(body);
        await ai.recordTest(result, body);
        json(res, result, result.ok ? 200 : 502); return true;
      }
      if (req.method === "POST" && !parts[1]) {
        const body = z.object({ mode: z.literal("ccswitch").optional(), configPath: z.string().trim().max(2000).optional(), model: z.string().trim().min(1).max(200).optional(), baseUrl: z.string().trim().max(2000).optional(), bearer: z.string().max(4000).optional(), reasoningEffort: z.enum(["high", "xhigh"]).optional(), wireApi: z.enum(["responses", "chat_completions"]).optional() }).parse(await readJson(req));
        json(res, await ai.save(body)); return true;
      }
      throw new SfxError("接口不存在", 404);
    }
    if(parts[0]==="workspace"&&!parts[1]) {
      if(req.method==="GET")json(res,await service.store.workspace());
      else if(req.method==="POST") {const body=z.object({runId:z.string().uuid(),projectId:z.string().uuid().optional()}).parse(await readJson(req));json(res,await service.store.rememberOpenRun(body.runId,body.projectId));}
      else throw new SfxError("接口不存在",404);
      return true;
    }
    if(parts[0]==="workflow"&&req.method==="GET") {
      if(!parts[1])json(res,workflowResources());
      else if(parts[1]==="bundle") {const zip=await workflowBundle();res.writeHead(200,{"content-type":"application/zip","content-disposition":"attachment; filename=video-sfx-skills.zip","content-length":zip.length,"cache-control":"no-store"});res.end(zip);}
      else if(parts[1]==="guide"||parts[1]==="skill") {const content=parts[1]==="guide"?await readWorkflowGuide():await readWorkflowSkill(parts[2]);res.writeHead(200,{"content-type":"text/plain; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"});res.end(content);}
      else throw new SfxError("流程资源不存在",404);
      return true;
    }
    if (parts[0] === "health") {
      const ai = await new AiConfigService().snapshot();
      json(res, { apiVersion:SFX_API_VERSION,capabilities:[...SFX_REQUIRED_CAPABILITIES],ok: true, standard:{workflow:SFX_WORKFLOW.id,provider:"ccswitch",model:ai.model || SFX_WORKFLOW.model,enabled:process.env.SFX_USE_CCSWITCH!=="0"}, ai, readyForGeneration: ai.ready, provider: process.env.SFX_USE_CCSWITCH !== "0" ? "ccswitch" : "ollama", model: process.env.SFX_USE_CCSWITCH !== "0" ? ai.model : (process.env.SFX_OLLAMA_MODEL || "qwen2.5vl:7b"), modelUrl: process.env.SFX_USE_CCSWITCH !== "0" ? "local CC Switch gateway" : (process.env.SFX_OLLAMA_URL || "http://127.0.0.1:11434") }); return true;
    }
    if (parts[0] === "compare" && req.method === "GET") {
      json(res, await service.compare(url.searchParams.get("local") || undefined, url.searchParams.get("gemini") || undefined));
      return true;
    }
    if (parts[0] === "projects") {
      if (req.method === "GET" && !parts[1]) { json(res, await service.projects.listProjects()); return true; }
      if (!parts[1]) throw new SfxError("项目 ID 缺失", 400);
      const projectId = z.string().uuid().parse(parts[1]);
      if (req.method === "GET" && parts[2] === "versions") { json(res, await service.projects.listVersions(projectId)); return true; }
      if (req.method === "GET" && !parts[2]) { json(res, await service.projects.project(projectId)); return true; }
      if (req.method === "POST" && parts[2] === "rename") { const body = z.object({ name: z.string().trim().min(1).max(120) }).parse(await readJson(req)); json(res, await service.renameProject(projectId, body.name)); return true; }
      if (req.method === "POST" && parts[2] === "save-as") { const body = z.object({ name: z.string().trim().min(1).max(120) }).parse(await readJson(req)); json(res, await service.saveProjectAs(projectId, body.name)); return true; }
      if (req.method === "POST" && parts[2] === "save-version") { const body = z.object({ name: z.string().trim().min(1).max(120), runId: z.string().uuid().optional() }).parse(await readJson(req)); json(res, await service.saveVersion(projectId, body.name, body.runId)); return true; }
      if (req.method === "POST" && parts[2] === "restore") { const body = z.object({ runId: z.string().uuid() }).parse(await readJson(req)); json(res, await service.restoreProjectVersion(projectId, body.runId)); return true; }
      if (req.method === "POST" && parts[2] === "sync") { const body=z.object({includeMedia:z.boolean().default(false)}).parse(await readJson(req));json(res, await service.syncProject(projectId,body.includeMedia)); return true; }
      throw new SfxError("接口不存在", 404);
    }
    if (parts[0] !== "runs") throw new SfxError("接口不存在", 404);
    const id = parts[1]; const action = parts[2];
    if (!id && req.method === "GET") json(res, await service.store.list());
    else if (!id && req.method === "POST") {
      const body = await readJson(req) as Record<string, unknown>;
      json(res, await service.create(body), 202);
    }
    else if (id && !action && req.method === "GET") json(res, clientRunPayload(await service.readRun(id)));
    else if (id && action === "status" && req.method === "GET") json(res, await service.status(id));
    else if (id && action === 'control' && req.method === 'POST') {const input=z.object({action:z.enum(['pause','resume','terminate'])}).parse(await readJson(req));json(res,await service.controlTask(id,input.action),202);}
    else if (id && action === "placements" && req.method === "POST") json(res, await service.update(id, await readJson(req)));
    else if (id && action === "quick-edit" && req.method === "POST") json(res, await service.quickEdit(id, await readJson(req)),202);
    else if (id && action === "edit-preview" && req.method === "POST") json(res, await service.editPreview(id, await readJson(req)),202);
    else if (id && action === "locate-event" && req.method === "POST") json(res, await service.locateEvent(id, await readJson(req)), 202);
    else if (id && action === "reanalyze" && req.method === "POST") json(res, await service.reanalyze(id, await readJson(req)), 202);
    else if (id && action === "add-described-event" && req.method === "POST") json(res, await service.addDescribedEvent(id, await readJson(req)), 202);
    else if (id && action === "search" && req.method === "POST") { const b = z.object({ query: z.string().max(2000), category: z.string().optional(),eventId:z.string().min(1).optional(),keywordPreferences:KeywordPreferencesSchema.optional(),...ExclusionFields }).parse(await readJson(req)); json(res, await service.search(id, b.query, b.category,b)); }
    else if (id && action === "render" && req.method === "POST") json(res, await service.render(id), 202);
    else if (id && action === "preserve" && req.method === "POST") json(res, await service.preserve(id, await readJson(req)));
    else if (id && action === "reselect" && req.method === "POST") json(res, await service.reselect(id, await readJson(req)), 202);
    else if (id && action === "automix" && req.method === "POST") json(res, await service.automix(id, await readJson(req)), 202);
    else if (id && action === "export" && parts[3] === "reaper" && req.method === "POST") json(res, await service.exportReaper(id, await readJson(req)));
    else if(id&&action==="export"&&parts[3]==="workflow"&&req.method==="GET") {
      const run=await service.readRun(id);let usage;
      try{usage=JSON.parse(await fs.readFile(path.join(service.store.directory(id),"usage-report.json"),"utf8"));}catch{ /* processing or legacy */ }
      res.setHeader("content-disposition","attachment; filename=workflow-report.json");json(res,buildWorkflowReport(run,usage));
    }
    else if (id && action === "export" && req.method === "GET") {
      const run = await service.readRun(id);
      const exportKind = parts[3];
      const name = ({ json: "placements.json", csv: "placements.csv", events: "events.json", music: "music-cues.json", review: "analysis-review.json", selection: "selection-report.json", mix: "mix-report.json", usage: "usage-report.json", names: "name-stage-review.json", edits:"source-edit-report.json", described: "described-event-report.json", audio: "preview.wav", video: "preview.mp4" } as Record<string, string>)[exportKind];
      if (!name) throw new SfxError("导出格式不存在", 404);
      const mediaPath = exportKind === "video" ? run.render?.video : exportKind === "audio" ? run.render?.audio : undefined;
      await streamSfxFile(req, res, mediaPath || path.join(service.store.directory(id), name), name);
    } else if (id && action === "media" && ["GET", "HEAD"].includes(req.method || "")) {
      const run = await service.readRun(id); const kind = parts[3]; let file: string | undefined;
      if (kind === "video") file = run.videoPath;
      else if (kind === "asset") file = run.assets.find(a => a.id === url.searchParams.get("id"))?.path;
      else if (kind === "frame") file = run.scenes[Number(url.searchParams.get("index"))]?.thumbnail;
      else if (kind === "preview") file = run.render?.video;
      if (!file) throw new SfxError("媒体不存在或尚未生成", 404);
      await streamSfxFile(req, res, file);
    } else throw new SfxError("接口不存在", 404);
  } catch (e) {
    if (res.headersSent) res.destroy();
    else json(res, { ...((e as any).code==='STYLE_CONFLICT'?{code:'STYLE_CONFLICT',conflicts:(e as any).conflicts,suggestions:styleBlendOptions((e as any).suggestions)}:{}),error: e instanceof z.ZodError ? e.issues.map(i => `${i.path.join(".")}：${i.message}`).join("；") : e instanceof Error ? e.message : String(e) }, e instanceof SfxError ? e.status : e instanceof z.ZodError ? 400 : (e as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500);
  }
  return true;
}
