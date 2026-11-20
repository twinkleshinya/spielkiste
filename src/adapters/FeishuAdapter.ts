import { execa, ExecaError } from "execa";
import { existsSync } from "node:fs";
import path from "node:path";

export interface FeishuCommandResult {
  command: string;
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface FeishuReference {
  raw: string;
  token: string;
  type: "doc" | "wiki" | "sheet" | "unknown";
}

export interface WikiNodeInfo {
  nodeToken?: string;
  objToken?: string;
  objType?: string;
  title?: string;
  spaceId?: string;
}

export class FeishuAdapter {
  constructor(
    private readonly larkCommand = process.env.LARK_CLI_PATH || "lark-cli",
    private readonly legacyCommand = process.env.FEISHU_TOOL_PATH || "feishu-tool"
  ) {}

  async checkAvailability(): Promise<{ available: boolean; command: string; message: string }> {
    const finder = process.platform === "win32" ? "where.exe" : "which";
    const lark = await execa(finder, [this.larkCommand], { reject: false });
    if (lark.exitCode === 0 || this.larkCliExistsOnWindows()) {
      return {
        available: true,
        command: this.resolvedLarkCommand(),
        message: "lark-cli available"
      };
    }
    const legacy = await execa(finder, [this.legacyCommand], { reject: false });
    return {
      available: legacy.exitCode === 0,
      command: legacy.exitCode === 0 ? this.legacyCommand : this.larkCommand,
      message:
        legacy.exitCode === 0
          ? "feishu-tool available"
          : "lark-cli 不可用，请安装官方 @larksuite/cli"
    };
  }

  async getConfig(): Promise<FeishuCommandResult> {
    if (await this.hasLarkCli()) return this.runLark(["auth", "status"]);
    return this.runLegacy(["config", "show"]);
  }

  async createDocument(input: { title: string; folderToken?: string; markdown?: string }): Promise<FeishuCommandResult> {
    if (await this.hasLarkCli()) {
      const args = ["docs", "+create", "--api-version", "v2", "--doc-format", "markdown"];
      if (input.folderToken) args.push("--parent-token", input.folderToken);
      if (input.markdown) args.push("--content", markdownArg(input.markdown));
      else args.push("--content", `# ${input.title}`);
      return this.runLark(args);
    }
    return this.runLegacyTool("create_feishu_document", {
      title: input.title,
      folderToken: input.folderToken,
      content: input.markdown
    });
  }

  async getDocumentBlocks(docToken: string): Promise<FeishuCommandResult> {
    if (await this.hasLarkCli()) {
      return this.runLark(["docs", "+fetch", "--api-version", "v2", "--doc", docToken, "--format", "json"]);
    }
    return this.runLegacyTool("get_feishu_document_blocks", { documentId: docToken });
  }

  async updateDocumentMarkdown(docToken: string, markdownPath: string, mode: "append" | "overwrite" = "overwrite"): Promise<FeishuCommandResult> {
    if (await this.hasLarkCli()) {
      return this.runLark([
        "docs",
        "+update",
        "--api-version",
        "v2",
        "--doc",
        docToken,
        "--command",
        mode,
        "--doc-format",
        "markdown",
        "--content",
        markdownArg(markdownPath)
      ]);
    }
    return this.runLegacyTool("batch_update_feishu_block_text", { documentId: docToken, blocksFile: markdownPath });
  }

  async getContent(reference: string): Promise<FeishuCommandResult> {
    if (await this.hasLarkCli()) {
      return this.getContentWithLark(reference);
    }
    const parsed = parseFeishuReference(reference);
    const attempts =
      parsed.type === "sheet"
        ? [
            ["get_feishu_document_blocks", JSON.stringify({ documentId: parsed.raw, documentType: "sheet" })],
            ["get_feishu_document_info", JSON.stringify({ documentId: parsed.raw, documentType: "sheet" })],
            ["get_feishu_document_blocks", JSON.stringify({ documentId: parsed.token })]
          ]
        : parsed.type === "wiki"
          ? [
              ["get_feishu_document_blocks", JSON.stringify({ documentId: parsed.raw, documentType: "wiki" })],
              ["get_feishu_document_info", JSON.stringify({ documentId: parsed.raw, documentType: "wiki" })],
              ["get_feishu_document_blocks", JSON.stringify({ documentId: parsed.token })]
            ]
          : [["get_feishu_document_blocks", JSON.stringify({ documentId: parsed.token })]];
    const results: FeishuCommandResult[] = [];
    for (const args of attempts) {
      const result = await this.runLegacy(args);
      results.push(result);
      if (result.exitCode === 0 && (result.stdout ?? "").trim()) return result;
    }
    return {
      command: this.legacyCommand,
      args: ["content", "get", parsed.raw],
      exitCode: results.at(-1)?.exitCode ?? 1,
      stdout: results.map((item) => item.stdout).filter(Boolean).join("\n\n"),
      stderr: results
        .map((item) => `${item.command} ${item.args.join(" ")}\n${item.stderr || item.stdout}`)
        .join("\n\n")
    };
  }

  async batchCreateBlocks(docToken: string, blocksJsonPath: string): Promise<FeishuCommandResult> {
    if (await this.hasLarkCli()) {
      return this.runLark([
        "docs",
        "+update",
        "--api-version",
        "v2",
        "--doc",
        docToken,
        "--command",
        "append",
        "--doc-format",
        "markdown",
        "--content",
        markdownArg(blocksJsonPath)
      ]);
    }
    return this.runLegacyTool("batch_create_feishu_blocks", { documentId: docToken, blocksFile: blocksJsonPath });
  }

  async batchUpdateBlockText(docToken: string, blocksJsonPath: string): Promise<FeishuCommandResult> {
    if (await this.hasLarkCli()) {
      return this.runLark([
        "docs",
        "+update",
        "--api-version",
        "v2",
        "--doc",
        docToken,
        "--command",
        "overwrite",
        "--doc-format",
        "markdown",
        "--content",
        markdownArg(blocksJsonPath)
      ]);
    }
    return this.runLegacyTool("batch_update_feishu_block_text", { documentId: docToken, blocksFile: blocksJsonPath });
  }

  async createTable(docToken: string, tableJsonPath: string): Promise<FeishuCommandResult> {
    return this.runLegacyTool("create_feishu_table", { documentId: docToken, tableFile: tableJsonPath });
  }

  async uploadImageToBlock(docToken: string, blockId: string, imagePath: string): Promise<FeishuCommandResult> {
    if (await this.hasLarkCli()) {
      return this.runLark(["docs", "+media-insert", "--doc", docToken, "--file", imagePath]);
    }
    return this.runLegacyTool("upload_and_bind_image_to_block", { documentId: docToken, blockId, imagePath });
  }

  async searchDocuments(query: string): Promise<FeishuCommandResult> {
    if (await this.hasLarkCli()) return this.runLark(["docs", "+search", "--query", query]);
    return this.runLegacyTool("search_feishu_documents", { searchKey: query });
  }

  async createTasks(tasksJsonPath: string): Promise<FeishuCommandResult> {
    return this.runLegacyTool("create_feishu_task", { tasksFile: tasksJsonPath });
  }

  async getUsers(query?: string): Promise<FeishuCommandResult> {
    return this.runLegacyTool("get_feishu_users", { queries: query ? [{ query }] : [] });
  }

  async resolveWikiNode(reference: string): Promise<{ result: FeishuCommandResult; node?: WikiNodeInfo }> {
    const parsed = parseFeishuReference(reference);
    if (parsed.type !== "wiki") {
      return {
        result: {
          command: this.resolvedLarkCommand(),
          args: ["wiki", "spaces", "get_node"],
          exitCode: 0,
          stdout: JSON.stringify({ node: { obj_token: parsed.token, obj_type: parsed.type } }),
          stderr: ""
        },
        node: { objToken: parsed.token, objType: parsed.type }
      };
    }
    const result = await this.runLark(["wiki", "spaces", "get_node", "--params", JSON.stringify({ token: parsed.token }), "--format", "json"]);
    return { result, node: parseWikiNode(result.stdout) };
  }

  async readSheet(input: { spreadsheetToken: string; sheetId: string; range: string }): Promise<FeishuCommandResult> {
    return this.runLark([
      "sheets",
      "+read",
      "--spreadsheet-token",
      input.spreadsheetToken,
      "--sheet-id",
      input.sheetId,
      "--range",
      input.range,
      "--value-render-option",
      "ToString"
    ]);
  }

  async getSheetInfo(input: { spreadsheetToken?: string; url?: string }): Promise<FeishuCommandResult> {
    const args = ["sheets", "+info"];
    if (input.url) args.push("--url", input.url);
    if (input.spreadsheetToken) args.push("--spreadsheet-token", input.spreadsheetToken);
    return this.runLark(args);
  }

  async writeSheet(input: { spreadsheetToken: string; sheetId: string; range: string; values: unknown[][] }): Promise<FeishuCommandResult> {
    return this.runLark([
      "sheets",
      "+write",
      "--spreadsheet-token",
      input.spreadsheetToken,
      "--sheet-id",
      input.sheetId,
      "--range",
      input.range,
      "--values",
      JSON.stringify(input.values)
    ]);
  }

  async mergeSheetCells(input: { spreadsheetToken: string; sheetId: string; range: string; mergeType?: "MERGE_ALL" | "MERGE_ROWS" | "MERGE_COLUMNS" }): Promise<FeishuCommandResult> {
    return this.runLark([
      "sheets",
      "+merge-cells",
      "--spreadsheet-token",
      input.spreadsheetToken,
      "--sheet-id",
      input.sheetId,
      "--range",
      input.range,
      "--merge-type",
      input.mergeType ?? "MERGE_ALL"
    ]);
  }

  async createDriveFolder(name: string, parentFolderToken?: string): Promise<FeishuCommandResult> {
    const args = ["drive", "+create-folder", "--name", name];
    if (parentFolderToken) args.push("--folder-token", parentFolderToken);
    return this.runLark(args);
  }

  async copyDriveFile(input: { fileToken: string; type: string; name: string; folderToken: string }): Promise<FeishuCommandResult> {
    return this.runLark([
      "drive",
      "files",
      "copy",
      "--params",
      JSON.stringify({ file_token: input.fileToken }),
      "--data",
      JSON.stringify({ folder_token: input.folderToken, name: input.name, type: input.type }),
      "--format",
      "json"
    ]);
  }

  private async getContentWithLark(reference: string): Promise<FeishuCommandResult> {
    const parsed = parseFeishuReference(reference);
    if (parsed.type === "sheet") {
      return this.getSheetContentWithLark(parsed);
    }
    const attempts = [
      ["docs", "+fetch", "--api-version", "v2", "--doc", parsed.raw, "--format", "json"],
      ["docs", "+fetch", "--api-version", "v2", "--doc", parsed.token, "--format", "json"],
      ["docs", "+fetch", "--doc", parsed.raw, "--format", "json"],
      ["docs", "+fetch", "--doc", parsed.token, "--format", "json"]
    ];
    return this.firstSuccessfulLark(attempts, parsed.raw);
  }

  private async getSheetContentWithLark(parsed: FeishuReference): Promise<FeishuCommandResult> {
    const results: FeishuCommandResult[] = [];
    const infoAttempts = [
      ["sheets", "+info", "--url", parsed.raw],
      ["sheets", "+info", "--spreadsheet-token", parsed.token]
    ];
    for (const args of infoAttempts) {
      const info = await this.runLark(args);
      results.push(info);
      const sheetIds = parseSheetIds(info.stdout);
      if (info.exitCode === 0 && sheetIds.length > 0) {
        const readOutputs: string[] = [];
        for (const sheetId of sheetIds.slice(0, 5)) {
          const read = await this.runLark(["sheets", "+read", "--spreadsheet-token", parsed.token, "--sheet-id", sheetId, "--range", "A1:Z200"]);
          results.push(read);
          if (read.exitCode === 0 && read.stdout.trim()) {
            readOutputs.push(`# sheet ${sheetId}\n${read.stdout}`);
          }
        }
        if (readOutputs.length > 0) {
          return {
            command: this.resolvedLarkCommand(),
            args: ["sheets", "+read", parsed.raw],
            exitCode: 0,
            stdout: readOutputs.join("\n\n"),
            stderr: results.map((item) => item.stderr).filter(Boolean).join("\n\n")
          };
        }
      }
    }
    const exportResult = await this.runLark(["sheets", "+export", "--url", parsed.raw, "--file-extension", "xlsx"]);
    results.push(exportResult);
    if (exportResult.exitCode === 0 && exportResult.stdout.trim()) return exportResult;
    return {
      command: this.resolvedLarkCommand(),
      args: ["sheets", "+read", parsed.raw],
      exitCode: results.at(-1)?.exitCode ?? 1,
      stdout: results.map((item) => item.stdout).filter(Boolean).join("\n\n"),
      stderr: results.map((item) => `${item.command} ${item.args.join(" ")}\n${item.stderr || item.stdout}`).join("\n\n")
    };
  }

  private async firstSuccessfulLark(attempts: string[][], reference: string): Promise<FeishuCommandResult> {
    const results: FeishuCommandResult[] = [];
    for (const args of attempts) {
      const result = await this.runLark(args);
      results.push(result);
      if (result.exitCode === 0 && result.stdout.trim()) return result;
    }
    return {
      command: this.larkCommand,
      args: ["content", "get", reference],
      exitCode: results.at(-1)?.exitCode ?? 1,
      stdout: results.map((item) => item.stdout).filter(Boolean).join("\n\n"),
      stderr: results.map((item) => `${item.command} ${item.args.join(" ")}\n${item.stderr || item.stdout}`).join("\n\n")
    };
  }

  private async hasLarkCli(): Promise<boolean> {
    const finder = process.platform === "win32" ? "where.exe" : "which";
    const result = await execa(finder, [this.larkCommand], { reject: false });
    return result.exitCode === 0 || this.larkCliExistsOnWindows();
  }

  private async runLegacyTool(toolName: string, payload: Record<string, unknown>): Promise<FeishuCommandResult> {
    const cleanPayload = Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
    return this.runLegacy([toolName, JSON.stringify(cleanPayload)]);
  }

  private async runLark(args: string[]): Promise<FeishuCommandResult> {
    return this.run(this.resolvedLarkCommand(), args);
  }

  private async runLegacy(args: string[]): Promise<FeishuCommandResult> {
    return this.run(this.legacyCommand, args);
  }

  private async run(command: string, args: string[]): Promise<FeishuCommandResult> {
    try {
      const isLark = command.includes("lark-cli");
      const result = await execa(command, args, {
        reject: false,
        env: isLark ? cleanProxyEnv() : undefined
      });
      return {
        command,
        args,
        exitCode: result.exitCode ?? (result.failed ? 1 : 0),
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? result.shortMessage ?? ""
      };
    } catch (error) {
      const execaError = error as ExecaError;
      return {
        command,
        args,
        exitCode: execaError.exitCode ?? 1,
        stdout: stringifyOutput(execaError.stdout),
        stderr: stringifyOutput(execaError.stderr) || execaError.message
      };
    }
  }

  private resolvedLarkCommand(): string {
    if (this.larkCommand !== "lark-cli") return this.larkCommand;
    const appData = process.env.APPDATA;
    const candidate = appData ? path.join(appData, "npm", "lark-cli.cmd") : "";
    return candidate && existsSync(candidate) ? candidate : this.larkCommand;
  }

  private larkCliExistsOnWindows(): boolean {
    if (process.platform !== "win32") return false;
    const appData = process.env.APPDATA;
    return Boolean(appData && existsSync(path.join(appData, "npm", "lark-cli.cmd")));
  }
}

function cleanProxyEnv(): Record<string, string> {
  return {
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    ALL_PROXY: "",
    http_proxy: "",
    https_proxy: "",
    all_proxy: "",
    LARK_CLI_NO_PROXY: "1",
    NO_PROXY: "localhost,127.0.0.1,::1",
    no_proxy: "localhost,127.0.0.1,::1"
  };
}

function markdownArg(value: string): string {
  if (/\.md$/i.test(value) || /[\\/]/.test(value)) return `@${relativeCliPath(value)}`;
  return value;
}

function relativeCliPath(value: string): string {
  const absolute = path.resolve(value);
  const relative = path.relative(process.cwd(), absolute);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) return relative || ".";
  return value;
}

function parseSheetIds(text: string): string[] {
  const ids = new Set<string>();
  if (!text.trim()) return [];
  try {
    const parsed = JSON.parse(text);
    collectSheetIds(parsed, ids);
  } catch {
    for (const match of text.matchAll(/(?:sheet_id|sheetId|sheet-id)["':=\s]+([A-Za-z0-9_-]+)/g)) {
      ids.add(match[1]);
    }
  }
  return [...ids];
}

function collectSheetIds(value: unknown, ids: Set<string>) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectSheetIds(item, ids);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["sheet_id", "sheetId", "sheet-id"]) {
    if (typeof record[key] === "string") ids.add(record[key] as string);
  }
  for (const item of Object.values(record)) collectSheetIds(item, ids);
}

function parseWikiNode(text: string): WikiNodeInfo | undefined {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const node = ((parsed.data as Record<string, unknown> | undefined)?.node ?? parsed.node) as Record<string, unknown> | undefined;
    if (!node) return undefined;
    return {
      nodeToken: stringValue(node.node_token),
      objToken: stringValue(node.obj_token),
      objType: stringValue(node.obj_type),
      title: stringValue(node.title),
      spaceId: stringValue(node.space_id)
    };
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function parseFeishuReference(raw: string): FeishuReference {
  const text = raw.trim();
  const sheet = text.match(/\/sheets\/([A-Za-z0-9]+)/);
  if (sheet) return { raw: text, token: sheet[1], type: "sheet" };
  const wiki = text.match(/\/wiki\/([A-Za-z0-9]+)/);
  if (wiki) return { raw: text, token: wiki[1], type: "wiki" };
  const docx = text.match(/\/docx?\/([A-Za-z0-9]+)/);
  if (docx) return { raw: text, token: docx[1], type: "doc" };
  const token = text.match(/[A-Za-z0-9]{12,}/)?.[0] ?? text;
  return { raw: text, token, type: "unknown" };
}

function stringifyOutput(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return JSON.stringify(value);
}
