import { promises as fs } from "node:fs";
import path from "node:path";
import { VideoManifestItem } from "../schemas/index.js";

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm"]);
const REFERENCE_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".json"]);

export class FileAdapter {
  constructor(private readonly cwd = process.cwd()) {}

  resolvePath(input: string): string {
    return path.isAbsolute(input) ? input : path.resolve(this.cwd, input);
  }

  async ensureDir(dirPath: string): Promise<void> {
    await fs.mkdir(dirPath, { recursive: true });
  }

  async readMarkdown(filePath: string): Promise<string> {
    return fs.readFile(this.resolvePath(filePath), "utf8");
  }

  async readJson<T = unknown>(filePath: string): Promise<T> {
    const text = await fs.readFile(this.resolvePath(filePath), "utf8");
    return JSON.parse(text) as T;
  }

  async writeJson(filePath: string, data: unknown): Promise<void> {
    const resolved = this.resolvePath(filePath);
    await this.ensureDir(path.dirname(resolved));
    await fs.writeFile(resolved, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }

  async writeMarkdown(filePath: string, markdown: string): Promise<void> {
    const resolved = this.resolvePath(filePath);
    await this.ensureDir(path.dirname(resolved));
    await fs.writeFile(resolved, markdown.endsWith("\n") ? markdown : `${markdown}\n`, "utf8");
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(this.resolvePath(filePath));
      return true;
    } catch {
      return false;
    }
  }

  async stat(filePath: string) {
    return fs.stat(this.resolvePath(filePath));
  }

  async listVideoFiles(inputDir: string): Promise<string[]> {
    return this.listFilesByExtension(inputDir, VIDEO_EXTENSIONS);
  }

  async listReferenceFiles(input: string | string[]): Promise<string[]> {
    const inputs = Array.isArray(input) ? input : [input];
    const results: string[] = [];
    for (const item of inputs.filter(Boolean)) {
      const resolved = this.resolvePath(item);
      const stat = await fs.stat(resolved);
      if (stat.isDirectory()) {
        results.push(...(await this.listFilesByExtension(resolved, REFERENCE_EXTENSIONS)));
      } else if (REFERENCE_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
        results.push(resolved);
      }
    }
    return [...new Set(results)].sort();
  }

  private async listFilesByExtension(inputDir: string, extensions: Set<string>): Promise<string[]> {
    const root = this.resolvePath(inputDir);
    const found: string[] = [];
    async function walk(dir: string) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (extensions.has(path.extname(entry.name).toLowerCase())) {
          found.push(fullPath);
        }
      }
    }
    await walk(root);
    return found.sort();
  }

  toManifestTable(videos: VideoManifestItem[]): string {
    if (videos.length === 0) {
      return "| 视频 | 类型 | 时长 | 分辨率 | 备注 |\n|---|---|---:|---|---|\n";
    }
    const rows = videos.map((video) => {
      const duration = video.duration === undefined ? "待确认" : video.duration.toFixed(2);
      const resolution =
        video.resolution.width && video.resolution.height
          ? `${video.resolution.width}x${video.resolution.height}`
          : "待确认";
      return `| ${video.fileName} | ${video.inferredType} | ${duration} | ${resolution} | ${video.notes.join("; ")} |`;
    });
    return ["| 视频 | 类型 | 时长(s) | 分辨率 | 备注 |", "|---|---|---:|---|---|", ...rows].join("\n");
  }
}
