import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitSyncResult = {
  /**
   * local-only: project exists only in the local runtime store.
   * committed: the selected metadata was committed locally, but no remote
   * push was performed (or no origin is configured).
   * synced: the selected metadata was committed and pushed to origin.
   */
  status: "local-only" | "committed" | "synced" | "pending-sync" | "unavailable" | "unchanged";
  commit?: string;
  error?: string;
};

export type GitCommitOptions = { push?: boolean };

/**
 * Small, deliberately conservative Git adapter. It only commits the metadata
 * files supplied by SfxProjectStore; it never runs a shell command and never
 * stages the rest of the user's working tree.
 */
export class SfxGitStore {
  constructor(public repoRoot = path.resolve(".")) {}

  private async git(args: string[]) {
    return execFileAsync("git", args, {
      cwd: this.repoRoot,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024
    });
  }

  private relativeFiles(files: string[]) {
    const result = files.map(file => {
      const absolute = path.resolve(file);
      const relative = path.relative(this.repoRoot, absolute);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("Git 元数据文件必须位于工具仓库内");
      }
      return relative.replaceAll(path.sep, "/");
    });
    return [...new Set(result)];
  }

  private async originUrl() {
    try {
      return (await this.git(["remote", "get-url", "origin"])).stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async commitMetadata(files: string[], message: string, options: GitCommitOptions = {}): Promise<GitSyncResult> {
    let relative: string[];
    try {
      relative = this.relativeFiles(files);
      if (!relative.length) return { status: "unchanged" };
      const root = (await this.git(["rev-parse", "--show-toplevel"])).stdout.trim();
      if (path.resolve(root) !== path.resolve(this.repoRoot)) {
        return { status: "unavailable", error: "当前目录不是 Spielkiste 工具仓库" };
      }
      // Project metadata is a runtime directory and is ignored by the normal
      // working-tree rules. The adapter is the only path allowed to force-add
      // these explicitly supplied files.
      await this.git(["add", "-f", "--", ...relative]);
      const staged = (await this.git(["diff", "--cached", "--name-only", "--", ...relative])).stdout
        .split(/\r?\n/).map(value => value.trim()).filter(Boolean);
      let commit: string | undefined;
      // --only limits the commit to our metadata paths and preserves unrelated
      // files the user may already have staged for another change.
      if (staged.length) {
        await this.git(["commit", "--only", "-m", message.slice(0, 180), "--", ...relative]);
        commit = (await this.git(["rev-parse", "HEAD"])).stdout.trim();
      }
      if (!options.push) return staged.length ? { status: "committed", commit } : { status: "unchanged" };

      const origin = await this.originUrl();
      if (!origin) return staged.length ? { status: "committed", commit, error: "未配置 origin，已提交到本机 Git，尚未推送。" } : { status: "unavailable", error: "未配置 origin，无法推送到远程 Git。" };
      try {
        await this.git(["push", "-u", "origin", "HEAD"]);
        return { status: "synced", commit };
      } catch (error) {
        const detail = String(error instanceof Error ? error.message : error).replace(/\s+/g, " ").slice(0, 500);
        return { status: "pending-sync", commit, error: detail };
      }
    } catch (error) {
      const detail = String(error instanceof Error ? error.message : error).replace(/\s+/g, " ").slice(0, 500);
      return { status: "pending-sync", error: detail };
    }
  }
}
