import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { SfxRun, SfxError } from "./models.js";
import { SfxRunStore, writeJson } from "./SfxRunStore.js";
import { SfxGitStore, type GitSyncResult } from "./SfxGitStore.js";

type ProjectIndex = { version: 1; projects: ProjectRecord[] };
export type ProjectGitState = GitSyncResult["status"];

export type ProjectRecord = {
  projectId: string;
  name: string;
  currentRunId: string;
  createdAt: string;
  updatedAt: string;
  versionCount: number;
  git: ProjectGitState;
  gitCommit?: string;
  gitError?: string;
};

export type ProjectVersion = {
  runId: string;
  projectId: string;
  name: string;
  revision: number;
  parentRunId?: string;
  operation?: string;
  createdAt: string;
  status: SfxRun["status"];
  hasPreview: boolean;
  eventCount: number;
  placementCount: number;
  videoName: string;
  libraryName: string;
  git?: { status: ProjectGitState; commit?: string; error?: string };
};

const IndexSchemaVersion = 1 as const;

function deterministicProjectId(value: string) {
  const hash = createHash("sha256").update(value).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${(parseInt(hash.slice(16, 18), 16) & 0x3f | 0x80).toString(16).padStart(2, "0")}${hash.slice(18, 20)}-${hash.slice(20, 32)}`;
}

function normalizePath(value: string) {
  return path.resolve(value).replaceAll("/", "\\").toLowerCase();
}

function projectFingerprint(run: Pick<SfxRun, "videoPath" | "libraryPath" | "musicLibraryPath" | "libraryPreferences">) {
  return JSON.stringify({ video: normalizePath(run.videoPath), library: normalizePath(run.libraryPath), music: run.musicLibraryPath ? normalizePath(run.musicLibraryPath) : "", preferences: (run.libraryPreferences || []).map(item => ({ path: normalizePath(item.path), weight: item.weight })) });
}

export class SfxProjectStore {
  private readonly indexFile: string;
  private readonly git: SfxGitStore;
  private migrationPromise: Promise<ProjectIndex> | undefined;

  constructor(
    public metadataRoot = path.resolve("projects"),
    private runs = new SfxRunStore(),
    git = new SfxGitStore(path.resolve("."))
  ) {
    this.indexFile = path.join(metadataRoot, "index.json");
    this.git = git;
  }

  allocateProjectId() { return randomUUID(); }
  private projectDir(projectId: string) { return path.join(this.metadataRoot, projectId); }
  private projectFile(projectId: string) { return path.join(this.projectDir(projectId), "project.json"); }
  private versionsDir(projectId: string) { return path.join(this.projectDir(projectId), "versions"); }
  private versionFile(projectId: string, runId: string) { return path.join(this.versionsDir(projectId), `${runId}.json`); }

  private async readIndex(): Promise<ProjectIndex> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.indexFile, "utf8")) as ProjectIndex;
      if (parsed.version === IndexSchemaVersion && Array.isArray(parsed.projects)) return this.mergeDiskProjects(parsed);
    } catch { /* first run or damaged cache; rebuild below */ }
    return this.mergeDiskProjects({ version: IndexSchemaVersion, projects: [] });
  }

  private async mergeDiskProjects(index: ProjectIndex): Promise<ProjectIndex> {
    const merged = new Map(index.projects.map(project => [project.projectId, project]));
    let entries: import("node:fs").Dirent[] = [];
    try { entries = await fs.readdir(this.metadataRoot, { withFileTypes: true }); } catch { return index; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const value = JSON.parse(await fs.readFile(path.join(this.metadataRoot, entry.name, "project.json"), "utf8")) as Partial<ProjectRecord>;
        if (typeof value.projectId !== "string" || typeof value.name !== "string" || typeof value.currentRunId !== "string") continue;
        if (!merged.has(value.projectId)) merged.set(value.projectId, {
          projectId: value.projectId,
          name: value.name,
          currentRunId: value.currentRunId,
          createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString(),
          updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
          versionCount: typeof value.versionCount === "number" ? value.versionCount : 0,
          git: value.git || "local-only",
          gitCommit: value.gitCommit,
          gitError: value.gitError
        });
      } catch { /* ignore incomplete or unrelated directories */ }
    }
    return { version: IndexSchemaVersion, projects: [...merged.values()] };
  }

  private async writeIndex(index: ProjectIndex) {
    await writeJson(this.indexFile, index);
  }

  private async runSummary(run: SfxRun): Promise<ProjectVersion> {
    return {
      runId: run.id,
      projectId: run.projectId || this.deriveProjectId(run),
      name: run.name,
      revision: run.revision,
      parentRunId: run.parentRunId,
      operation: run.workflow?.operation,
      createdAt: run.createdAt,
      status: run.status,
      hasPreview: Boolean(run.render),
      eventCount: run.events.length,
      placementCount: run.placements.length,
      videoName: path.basename(run.videoPath),
      libraryName: path.basename(run.libraryPath)
    };
  }

  deriveProjectId(run: Pick<SfxRun, "projectId" | "parentRunId" | "videoPath" | "libraryPath" | "musicLibraryPath" | "libraryPreferences">) {
    if (run.projectId) return run.projectId;
    return deterministicProjectId(projectFingerprint(run));
  }

  private async writeProjectFiles(project: ProjectRecord, version: ProjectVersion) {
    const projectFile = this.projectFile(project.projectId);
    const versionFile = this.versionFile(project.projectId, version.runId);
    await writeJson(projectFile, {
      version: 1,
      projectId: project.projectId,
      name: project.name,
      currentRunId: project.currentRunId,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      versionCount: project.versionCount,
      media: { videoName: version.videoName, libraryName: version.libraryName }
    });
    await writeJson(versionFile, version);
  }

  async registerRun(run: SfxRun, operation = run.workflow?.operation || "save"): Promise<{ projectId: string; git: GitSyncResult }> {
    const projectId = this.deriveProjectId(run);
    run.projectId = projectId;
    const index = await this.readIndex();
    const version = await this.runSummary(run);
    let project = index.projects.find(item => item.projectId === projectId);
    if (!project) {
      project = { projectId, name: run.name.replace(/ · (?:编辑|定位|补声|自动混音|Gemini选材)(?:副本|\d+)?$/, "").slice(0, 120) || "视频音效项目", currentRunId: run.id, createdAt: run.createdAt, updatedAt: run.createdAt, versionCount: 0, git: "local-only" };
      index.projects.push(project);
    }
    if (new Date(run.createdAt).getTime() >= new Date(project.updatedAt).getTime()) {
      project.currentRunId = run.id;
      project.updatedAt = run.createdAt;
    }
    // Count from the on-disk version files so re-saving a run does not create
    // duplicate versions or inflate the project count.
    let existing: string[] = [];
    try { existing = await fs.readdir(this.versionsDir(projectId)); } catch { /* first version */ }
    project.versionCount = new Set([...existing.filter(name => name.endsWith(".json")), `${run.id}.json`]).size;
    project.git = project.git === "synced" || project.git === "committed" ? project.git : "local-only";
    await this.writeProjectFiles(project, version);
    index.projects = index.projects.map(item => item.projectId === projectId ? project! : item);
    await this.writeIndex(index);
    return { projectId, git: { status: project.git } };
  }

  async listProjects(): Promise<ProjectRecord[]> {
    await this.migrate();
    const index = await this.readIndex();
    return index.projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async listVersions(projectId: string): Promise<ProjectVersion[]> {
    await this.migrate();
    return this.readVersionFiles(projectId);
  }

  private async readVersionFiles(projectId: string): Promise<ProjectVersion[]> {
    const dir = this.versionsDir(projectId);
    let names: string[] = [];
    try { names = await fs.readdir(dir); } catch { return []; }
    const versions: ProjectVersion[] = [];
    for (const name of names.filter(item => item.endsWith(".json"))) {
      try { versions.push(JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as ProjectVersion); } catch { /* skip damaged summary */ }
    }
    return versions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async project(projectId: string) {
    const projects = await this.listProjects();
    const project = projects.find(item => item.projectId === projectId);
    if (!project) throw new SfxError("未找到项目", 404);
    return project;
  }

  async rename(projectId: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 120) throw new SfxError("项目名称不能为空且不能超过 120 个字符");
    const index = await this.readIndex();
    const project = index.projects.find(item => item.projectId === projectId);
    if (!project) throw new SfxError("未找到项目", 404);
    project.name = trimmed;
    project.updatedAt = new Date().toISOString();
    const version = (await this.readVersionFiles(projectId))[0];
    if (!version) throw new SfxError("项目没有可用版本", 409);
    await this.writeProjectFiles(project, version);
    await this.writeIndex(index);
    return { project, git: { status: project.git } };
  }

  async syncProject(projectId: string): Promise<{ project: ProjectRecord; git: GitSyncResult }> {
    const index = await this.readIndex();
    const project = index.projects.find(item => item.projectId === projectId);
    if (!project) throw new SfxError("未找到项目", 404);
    const version = (await this.readVersionFiles(projectId))[0];
    if (!version) throw new SfxError("项目没有可用版本", 409);
    const versionFiles = (await fs.readdir(this.versionsDir(projectId))).filter(name => name.endsWith(".json")).map(name => path.join(this.versionsDir(projectId), name));
    const result = await this.git.commitMetadata(
      [this.projectFile(projectId), ...versionFiles],
      `Spielkiste: ${project.name} · 手动同步`,
      { push: true }
    );
    project.git = result.status;
    if (result.commit) project.gitCommit = result.commit;
    if (result.error) project.gitError = result.error; else delete project.gitError;
    await this.writeProjectFiles(project, version);
    index.projects = index.projects.map(item => item.projectId === projectId ? project : item);
    await this.writeIndex(index);
    return { project, git: result };
  }

  async migrate() {
    if (this.migrationPromise) return this.migrationPromise;
    this.migrationPromise = (async () => {
      const summaries = await this.runs.list();
      const index = await this.readIndex();
      for (const summary of summaries) await this.registerSummaryWithoutGit(summary, index);
      await this.writeIndex(index);
      return index;
    })().catch(error => { this.migrationPromise = undefined; throw error; });
    return this.migrationPromise;
  }

  private async registerSummaryWithoutGit(summary: {
    id: string; projectId?: string; name: string; createdAt: string; status: SfxRun["status"];
    revision: number; parentRunId?: string; videoPath: string; libraryPath: string;
    musicLibraryPath?: string; libraryPreferences?: SfxRun["libraryPreferences"];
    eventCount: number; placementCount: number; hasPreview: boolean; workflow?: SfxRun["workflow"];
  }, index: ProjectIndex) {
    const projectId = summary.projectId || this.deriveProjectId(summary);
    const version: ProjectVersion = {
      runId: summary.id, projectId, name: summary.name, revision: summary.revision,
      parentRunId: summary.parentRunId, operation: summary.workflow?.operation,
      createdAt: summary.createdAt, status: summary.status, hasPreview: summary.hasPreview,
      eventCount: summary.eventCount, placementCount: summary.placementCount,
      videoName: path.basename(summary.videoPath), libraryName: path.basename(summary.libraryPath)
    };
    let project = index.projects.find(item => item.projectId === projectId);
    if (!project) {
      project = { projectId, name: summary.name.replace(/ · (?:编辑|定位|补声|自动混音|Gemini选材)(?:副本|\d+)?$/, "").slice(0, 120) || "视频音效项目", currentRunId: summary.id, createdAt: summary.createdAt, updatedAt: summary.createdAt, versionCount: 0, git: "local-only" };
      index.projects.push(project);
    }
    if (new Date(summary.createdAt).getTime() >= new Date(project.updatedAt).getTime()) { project.currentRunId = summary.id; project.updatedAt = summary.createdAt; }
    await this.writeProjectFiles(project, version);
    let names: string[] = [];
    try { names = await fs.readdir(this.versionsDir(projectId)); } catch { /* first */ }
    project.versionCount = names.filter(item => item.endsWith(".json")).length;
  }

  private async registerRunWithoutGit(run: SfxRun, index: ProjectIndex) {
    const projectId = this.deriveProjectId(run);
    const version = await this.runSummary(run);
    let project = index.projects.find(item => item.projectId === projectId);
    if (!project) {
      project = { projectId, name: run.name.replace(/ · (?:编辑|定位|补声|自动混音|Gemini选材)(?:副本|\d+)?$/, "").slice(0, 120) || "视频音效项目", currentRunId: run.id, createdAt: run.createdAt, updatedAt: run.createdAt, versionCount: 0, git: "local-only" };
      index.projects.push(project);
    }
    if (new Date(run.createdAt).getTime() >= new Date(project.updatedAt).getTime()) { project.currentRunId = run.id; project.updatedAt = run.createdAt; }
    await this.writeProjectFiles(project, version);
    let names: string[] = [];
    try { names = await fs.readdir(this.versionsDir(projectId)); } catch { /* first */ }
    project.versionCount = names.filter(item => item.endsWith(".json")).length;
  }
}
