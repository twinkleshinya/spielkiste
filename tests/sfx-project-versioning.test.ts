import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SfxService } from "../src/sfx/SfxService.js";
import { SfxProjectStore } from "../src/sfx/SfxProjectStore.js";

export async function testSfxProjectVersioning() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfx-project-versioning-"));
  try {
    const service = new SfxService(path.join(root, "output"));
    const projectId = crypto.randomUUID();
    const first = await service.store.createRun({ projectId, name: "Boss 编辑1", videoPath: path.join(root, "boss.mp4"), libraryPath: root });
    Object.assign(first, { status: "ready", duration: 2 });
    await service.store.save(first);
    await service.projects.registerRun(first, "create");

    const second = await service.store.createRun({ projectId, name: "Boss 编辑2", videoPath: first.videoPath, libraryPath: root });
    Object.assign(second, { status: "ready", duration: 2, revision: 1, parentRunId: first.id });
    await service.store.save(second);
    await service.projects.registerRun(second, "edit");

    const projects = await service.projects.listProjects();
    assert.equal(projects.length, 1, "同一项目在列表中只能出现一条");
    assert.equal(projects[0].currentRunId, second.id);
    assert.equal(projects[0].versionCount, 2);
    assert.equal(projects[0].git, "local-only", "普通保存不能自动提交或上传 Git");
    const versions = await service.projects.listVersions(projectId);
    assert.deepEqual(new Set(versions.map(item => item.runId)), new Set([first.id, second.id]));

    const oldName = (await service.readRun(first.id)).name;
    const renamed = await service.renameProject(projectId, "Boss 最终版");
    assert.equal(renamed.project.name, "Boss 最终版");
    assert.equal((await service.readRun(first.id)).name, oldName, "重命名不能改写历史 run");
    assert.equal((await service.projects.listVersions(projectId)).length, 2, "重命名不能创建音效版本");

    const savedAs = await service.saveProjectAs(projectId, "Boss 另存版");
    assert.notEqual(savedAs.projectId, projectId);
    assert.equal((await service.projects.listProjects()).length, 2);
    assert.equal((await service.projects.listVersions(savedAs.projectId)).length, 1);

    const restored = await service.restoreProjectVersion(projectId, first.id);
    assert.equal(restored.projectId, projectId);
    const restoredRun = await service.readRun(restored.runId);
    assert.equal(restoredRun.parentRunId, second.id);
    assert.equal(restoredRun.revision, 2);
    assert.equal((await service.projects.listVersions(projectId)).length, 3);
    assert.equal((await service.readRun(second.id)).revision, 1, "回退不能改写目标旧版本");

    let syncCalls = 0;
    let syncOptions: unknown;
    let syncedFiles: string[] = [];
    const fakeGit = {
      commitMetadata: async (files: string[], _message: string, options?: unknown) => {
        syncCalls += 1;
        syncedFiles = files;
        syncOptions = options;
        return { status: "committed" as const, commit: "abc123" };
      }
    };
    const isolatedStore = new SfxProjectStore(path.join(root, "manual-sync-projects"), service.store, fakeGit as never);
    await isolatedStore.registerRun(first, "test");
    assert.equal(syncCalls, 0, "普通保存不应调用 Git 适配器");
    const manual = await isolatedStore.syncProject(projectId);
    assert.equal(syncCalls, 1, "手动同步应调用 Git 适配器一次");
    assert.ok(syncedFiles.every(file => !file.endsWith("index.json")), "手动同步不能上传全局本机项目索引");
    assert.ok(syncedFiles.some(file => file.endsWith(`${first.id}.json`)), "手动同步应包含项目版本文件");
    assert.deepEqual(syncOptions, { push: true });
    assert.equal(manual.project.git, "committed");
    const projectJson = JSON.parse(await fs.readFile(path.join(root, "manual-sync-projects", projectId, "project.json"), "utf8"));
    assert.equal("git" in projectJson, false, "Git 状态只保存在本机索引，不能污染可同步项目元数据");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
