import path from "node:path";
import { promises as fs } from "node:fs";
import {
  FeishuDocumentInput,
  FeishuDocumentInputSchema,
  FeishuDocumentResult,
  FeishuDocumentResultSchema
} from "../schemas/index.js";
import { FeishuAdapter } from "../adapters/FeishuAdapter.js";
import { FeishuCommandResult } from "../adapters/FeishuAdapter.js";
import { BaseAgent, AgentContext } from "./BaseAgent.js";

export class FeishuDocumentAgent extends BaseAgent<FeishuDocumentInput, FeishuDocumentResult> {
  readonly name = "FeishuDocumentAgent" as const;

  async run(input: FeishuDocumentInput, context: AgentContext): Promise<FeishuDocumentResult> {
    const parsed = FeishuDocumentInputSchema.parse(input);
    const markdownPath = path.join(context.runDir, "final_document.md");
    const blocksPath = path.join(context.runDir, "feishu_blocks.json");
    await context.fileAdapter.writeMarkdown(markdownPath, parsed.documentModel.markdown);
    await context.fileAdapter.writeJson(blocksPath, parsed.documentModel.blocks);

    const feishu = new FeishuAdapter();
    const availability = await feishu.checkAvailability();
    const commandResults: FeishuCommandResult[] = [];
    if (parsed.skillSheet?.enabled) {
      const skillResult = await this.createSkillSheet(parsed, context, feishu, availability, commandResults, markdownPath, blocksPath);
      if (skillResult) return skillResult;
    }
    if (parsed.dryRun || !availability.available) {
      return FeishuDocumentResultSchema.parse({
        dryRun: parsed.dryRun,
        available: availability.available,
        localMarkdownPath: markdownPath,
        blocksJsonPath: blocksPath,
        commandResults,
        error: availability.available ? undefined : availability.message
      });
    }

    let docToken = parsed.docToken;
    let createdWithLarkMarkdown = false;
    if (!docToken) {
      const createResult = await feishu.createDocument({
        title: parsed.documentModel.title,
        folderToken: parsed.folderToken,
        markdown: markdownPath
      });
      commandResults.push(createResult);
      createdWithLarkMarkdown = createResult.command.includes("lark-cli");
      docToken = parseDocToken(createResult.stdout) ?? parseDocToken(createResult.stderr);
      if (createResult.exitCode !== 0) {
        return FeishuDocumentResultSchema.parse({
          dryRun: false,
          available: true,
          localMarkdownPath: markdownPath,
          blocksJsonPath: blocksPath,
          commandResults,
          error: {
            message: "createDocument 失败，已保留本地 markdown 和 blocks JSON。",
            command: createResult.command,
            args: createResult.args,
            stdout: createResult.stdout,
            stderr: createResult.stderr
          }
        });
      }
    }

    if (docToken && parsed.docToken) {
      const writeResult = await feishu.updateDocumentMarkdown(docToken, markdownPath, "overwrite");
      commandResults.push(writeResult);
      if (writeResult.exitCode !== 0) {
        return FeishuDocumentResultSchema.parse({
          dryRun: false,
          available: true,
          docToken,
          localMarkdownPath: markdownPath,
          blocksJsonPath: blocksPath,
          commandResults,
          error: {
            message: "updateDocumentMarkdown 失败，已保留本地 markdown 和 blocks JSON。",
            command: writeResult.command,
            args: writeResult.args,
            stdout: writeResult.stdout,
            stderr: writeResult.stderr
          }
        });
      }
    } else if (docToken && !createdWithLarkMarkdown) {
      const writeResult = await feishu.batchCreateBlocks(docToken, blocksPath);
      commandResults.push(writeResult);
      if (writeResult.exitCode !== 0) {
        return FeishuDocumentResultSchema.parse({
          dryRun: false,
          available: true,
          docToken,
          localMarkdownPath: markdownPath,
          blocksJsonPath: blocksPath,
          commandResults,
          error: {
            message: "batchCreateBlocks 失败，已保留本地 markdown 和 blocks JSON。",
            command: writeResult.command,
            args: writeResult.args,
            stdout: writeResult.stdout,
            stderr: writeResult.stderr
          }
        });
      }
    }

    return FeishuDocumentResultSchema.parse({
      dryRun: false,
      available: true,
      docToken,
      url: docToken ? `https://feishu.cn/docx/${docToken}` : undefined,
      localMarkdownPath: markdownPath,
      blocksJsonPath: blocksPath,
      commandResults
    });
  }

  private async createSkillSheet(
    parsed: FeishuDocumentInput,
    context: AgentContext,
    feishu: FeishuAdapter,
    availability: { available: boolean; command: string; message: string },
    commandResults: FeishuCommandResult[],
    markdownPath: string,
    blocksPath: string
  ): Promise<FeishuDocumentResult | undefined> {
    const skillSheet = parsed.skillSheet;
    if (!skillSheet?.enabled) return undefined;
    const templateUrl = skillSheet.templateUrl || "https://leiting.feishu.cn/wiki/LYi2wa7KKiOEJgkl768cjCgdnOb";
    const skillItems = await collectSkillItems({
      files: skillSheet.skillDocumentFiles,
      feishuDocs: skillSheet.skillDocumentFeishuDocs,
      feishu,
      commandResults
    });
    const title = `雷霆数娱《${skillSheet.projectName}》${skillSheet.vendorName || "声影创境"}_技能音效（${skillSheet.demandName || "需求名称"}）`;
    const sheetPlan = buildSkillSheetPlan(skillSheet, title, skillItems);
    const previewRows = sheetPlan.rows.slice(0, 50);
    await context.fileAdapter.writeJson(path.join(context.runDir, "skill_sheet_plan.json"), sheetPlan);
    await context.fileAdapter.writeMarkdown(
      markdownPath,
      [
        `# ${title}`,
        "",
        "本次选择的是技能音效表格模板。实际写入飞书时会复制原始飞书表格模板，并只更新日期、标题和技能清单单元格，以保留原表格样式。",
        "",
        `技能条目数：${skillItems.length}`,
        "",
        `阶段行数：${sheetPlan.rows.length}`,
        "",
        "| 技能编号 | 技能名称 | 阶段 | 美术表现描述 |",
        "|---|---|---|---|",
        ...previewRows.map((item) => `| ${escapeCell(item.generatedId)} | ${escapeCell(item.skillName)} | ${escapeCell(item.phaseType)} | ${escapeCell(item.artDescription)} |`)
      ].join("\n")
    );
    await context.fileAdapter.writeJson(blocksPath, []);

    if (parsed.dryRun || !availability.available) {
      return FeishuDocumentResultSchema.parse({
        dryRun: parsed.dryRun,
        available: availability.available,
        localMarkdownPath: markdownPath,
        blocksJsonPath: blocksPath,
        commandResults,
        error: availability.available ? undefined : availability.message
      });
    }

    const templateNode = await feishu.resolveWikiNode(templateUrl);
    commandResults.push(templateNode.result);
    const templateToken = templateNode.node?.objToken;
    if (templateNode.result.exitCode !== 0 || !templateToken) {
      return skillSheetError(markdownPath, blocksPath, commandResults, "读取技能表格模板失败。", templateNode.result);
    }

    let folderToken = parsed.folderToken;
    if (!folderToken) {
      const folder = await feishu.createDriveFolder("AI音频外包文档输出");
      commandResults.push(folder);
      folderToken = parseFolderToken(folder.stdout);
      if (folder.exitCode !== 0 || !folderToken) {
        return skillSheetError(markdownPath, blocksPath, commandResults, "创建飞书输出文件夹失败。", folder);
      }
    }

    const copied = await feishu.copyDriveFile({
      fileToken: templateToken,
      type: "sheet",
      name: title,
      folderToken
    });
    commandResults.push(copied);
    const copiedToken = parseCopiedFileToken(copied.stdout);
    const copiedUrl = parseCopiedFileUrl(copied.stdout) || (copiedToken ? `https://leiting.feishu.cn/sheets/${copiedToken}` : undefined);
    if (copied.exitCode !== 0 || !copiedToken) {
      return skillSheetError(markdownPath, blocksPath, commandResults, "复制技能表格模板失败。", copied);
    }

    for (const patch of sheetPlan.patches) {
      const write = await feishu.writeSheet({
        spreadsheetToken: copiedToken,
        sheetId: "cIvcpO",
        range: patch.range,
        values: patch.values
      });
      commandResults.push(write);
      if (write.exitCode !== 0) {
        return skillSheetError(markdownPath, blocksPath, commandResults, `写入技能表格失败：${patch.range}`, write, copiedToken, copiedUrl);
      }
    }

    for (const merge of sheetPlan.mergeRanges) {
      const merged = await feishu.mergeSheetCells({
        spreadsheetToken: copiedToken,
        sheetId: "cIvcpO",
        range: merge.range
      });
      commandResults.push(merged);
      if (merged.exitCode !== 0) {
        return skillSheetError(markdownPath, blocksPath, commandResults, `合并技能单元格失败：${merge.range}`, merged, copiedToken, copiedUrl);
      }
    }

    return FeishuDocumentResultSchema.parse({
      dryRun: false,
      available: true,
      docToken: copiedToken,
      url: copiedUrl,
      localMarkdownPath: markdownPath,
      blocksJsonPath: blocksPath,
      commandResults
    });
  }
}

type SkillPhase = {
  phaseType: string;
  rawDescription: string;
  polishedDescription: string;
};

type SkillItem = {
  generatedId: string;
  sourceId?: string;
  skillName: string;
  overview: string;
  phases: SkillPhase[];
};

type SkillSheetRow = {
  generatedId: string;
  skillName: string;
  phaseType: string;
  artDescription: string;
};

type SkillMergeRange = {
  range: string;
  reason: string;
};

async function collectSkillItems(input: {
  files: string[];
  feishuDocs: string[];
  feishu: FeishuAdapter;
  commandResults: FeishuCommandResult[];
}): Promise<SkillItem[]> {
  const items: SkillItem[] = [];
  for (const file of input.files) {
    items.push(...(await readSkillItemsFromFile(file)));
  }
  for (const doc of input.feishuDocs) {
    items.push(...(await readSkillItemsFromFeishu(doc, input.feishu, input.commandResults)));
  }
  const deduped = new Map<string, SkillItem>();
  for (const item of items) {
    const key = `${item.sourceId ?? ""}::${item.skillName}::${item.overview}::${item.phases.map((phase) => `${phase.phaseType}:${phase.rawDescription}`).join("|")}`;
    if (item.skillName && !deduped.has(key)) deduped.set(key, item);
  }
  return [...deduped.values()].map((item, index) => ({
    ...item,
    generatedId: String(index + 1)
  }));
}

async function readSkillItemsFromFile(filePath: string): Promise<SkillItem[]> {
  const text = await fs.readFile(path.resolve(process.cwd(), filePath), "utf8");
  if (/\.json$/i.test(filePath)) {
    return parseSkillItemsFromJson(JSON.parse(text));
  }
  return parseSkillItemsFromText(text);
}

async function readSkillItemsFromFeishu(reference: string, feishu: FeishuAdapter, commandResults: FeishuCommandResult[]): Promise<SkillItem[]> {
  const node = await feishu.resolveWikiNode(reference);
  commandResults.push(node.result);
  const token = node.node?.objToken;
  if (!token) return [];
  if (node.node?.objType === "sheet") {
    const info = await feishu.getSheetInfo({ spreadsheetToken: token });
    commandResults.push(info);
    const sheetIds = parseSheetIdsFromSheetInfoOutput(info.stdout);
    for (const sheetId of sheetIds.length > 0 ? sheetIds : ["cIvcpO"]) {
      const read = await feishu.readSheet({ spreadsheetToken: token, sheetId, range: "A1:Z200" });
      commandResults.push(read);
      if (read.exitCode !== 0) continue;
      const items = parseSkillItemsFromSheetOutput(read.stdout);
      if (items.length > 0) return items;
    }
    return [];
  }
  const content = await feishu.getDocumentBlocks(token);
  commandResults.push(content);
  return parseSkillItemsFromText(content.stdout);
}

function parseSkillItemsFromJson(value: unknown): SkillItem[] {
  if (Array.isArray(value)) {
    if (value.every((item) => Array.isArray(item))) return parseSkillItemsFromRows(value as unknown[][]);
    return value.flatMap((item) => {
      if (Array.isArray(item)) return rowToSkillItem(item);
      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        return createSkillItem({
          sourceId: firstRecordText(record, ["技能编号", "编号", "序号", "skillId", "id", "code"]),
          skillName: firstRecordText(record, ["技能名称", "技能名", "名称", "skillName", "name", "title"]),
          overview: firstRecordText(record, ["技能表现概述", "表现概述", "概述", "overview", "summary"]),
          performance: firstRecordText(record, ["技能表现", "表现", "performance", "description"])
        });
      }
      return [];
    });
  }
  if (value && typeof value === "object") {
    return parseSkillItemsFromJson(Object.values(value as Record<string, unknown>));
  }
  return [];
}

export function parseSkillItemsFromSheetOutput(text: string): SkillItem[] {
  try {
    const parsed = JSON.parse(text);
    const values = findSheetValues(parsed);
    return parseSkillItemsFromRows(values);
  } catch {
    return parseSkillItemsFromText(text);
  }
}

export function parseSheetIdsFromSheetInfoOutput(text: string): string[] {
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

function parseSkillItemsFromText(text: string): SkillItem[] {
  const rows = text
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^-+\s*\|/.test(line) && !/技能编号.*技能名称/.test(line));
  return rows.flatMap((line) => {
    const cells = line.includes("|")
      ? line.split("|").map((item) => item.trim()).filter(Boolean)
      : line.split(/\t|,|，/g).map((item) => item.trim()).filter(Boolean);
    return rowToSkillItem(cells);
  });
}

function rowToSkillItem(row: unknown): SkillItem[] {
  if (!Array.isArray(row) || row.length < 2) return [];
  return createSkillItem({
    sourceId: cellText(row[0]),
    skillName: cellText(row[1]),
    performance: cellText(row[2]),
    overview: cellText(row[3])
  });
}

function parseSkillItemsFromRows(values: unknown[][]): SkillItem[] {
  const header = findSkillHeader(values);
  if (!header) return values.flatMap((row) => rowToSkillItem(row));

  const items: SkillItem[] = [];
  for (const row of values.slice(header.rowIndex + 1)) {
    const skillName = cellText(row[header.skillNameIndex]);
    if (!skillName || isSkippedSkillName(skillName)) continue;
    const sourceId = header.idIndex === undefined ? "" : cellText(row[header.idIndex]);
    const overview = header.overviewIndex === undefined ? "" : cellText(row[header.overviewIndex]);
    const performance = header.performanceIndex === undefined ? "" : cellText(row[header.performanceIndex]);
    items.push(
      ...createSkillItem({
        sourceId,
        skillName,
        overview,
        performance
      })
    );
  }
  return items;
}

function findSkillHeader(values: unknown[][]):
  | {
      rowIndex: number;
      idIndex?: number;
      skillNameIndex: number;
      performanceIndex?: number;
      overviewIndex?: number;
    }
  | undefined {
  for (let rowIndex = 0; rowIndex < Math.min(values.length, 20); rowIndex += 1) {
    const normalized = values[rowIndex].map((value) => normalizeHeader(cellText(value)));
    const skillNameIndex = normalized.findIndex(isSkillNameHeader);
    if (skillNameIndex < 0) continue;
    const performanceIndex = normalized.findIndex(isPerformanceHeader);
    const overviewIndex = normalized.findIndex(isOverviewHeader);
    const idIndex = normalized.findIndex(isIdHeader);
    if (performanceIndex >= 0 || overviewIndex >= 0) {
      return {
        rowIndex,
        idIndex: idIndex >= 0 ? idIndex : undefined,
        skillNameIndex,
        performanceIndex: performanceIndex >= 0 ? performanceIndex : undefined,
        overviewIndex: overviewIndex >= 0 ? overviewIndex : undefined
      };
    }
  }
  return undefined;
}

function createSkillItem(input: { sourceId?: string; skillName: string; overview?: string; performance?: string }): SkillItem[] {
  const skillName = cleanText(input.skillName);
  const sourceId = cleanText(input.sourceId ?? "");
  const overview = cleanText(input.overview ?? "");
  const performance = cleanText(input.performance ?? "");
  if (!skillName || isSkippedSkillName(skillName)) return [];
  if (/编号|技能编号|序号/i.test(sourceId) || sourceId.startsWith("#")) return [];
  return [
    {
      generatedId: "",
      sourceId,
      skillName,
      overview,
      phases: parseSkillPhases(performance, overview)
    }
  ];
}

function parseSkillPhases(performance: string, overview: string): SkillPhase[] {
  const text = cleanText(performance);
  const matches = [
    ...text.matchAll(
      /\b(cast|damage\d*|bullet\d*|hit\d*|release|charge|loop|end|movement|buff\d*|debuff\d*|whoosh|impact|weapon|magic|shield|heal|summon)\b\s*[:：]/gi
    )
  ];
  if (matches.length === 0) {
    return [
      {
        phaseType: "整体",
        rawDescription: text,
        polishedDescription: polishArtDescription(overview, text)
      }
    ];
  }
  return matches.map((match, index) => {
    const phaseType = match[1].toLowerCase();
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index ?? text.length : text.length;
    const rawDescription = cleanText(text.slice(start, end));
    return {
      phaseType,
      rawDescription,
      polishedDescription: polishArtDescription(overview, rawDescription)
    };
  });
}

function polishArtDescription(overview: string, phaseDescription: string): string {
  const parts = [overview, phaseDescription]
    .map(cleanText)
    .filter(Boolean)
    .filter((item, index, arr) => arr.indexOf(item) === index);
  return parts.join("；");
}

function isSkippedSkillName(value: string): boolean {
  return /技能名称|视频名称|名称/.test(value) || value.startsWith("#");
}

function normalizeHeader(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

function isSkillNameHeader(value: string): boolean {
  return /技能(名称|名)|^名称$/.test(value);
}

function isPerformanceHeader(value: string): boolean {
  return value.includes("技能表现") && !value.includes("概述");
}

function isOverviewHeader(value: string): boolean {
  return value.includes("技能表现概述") || value.includes("表现概述");
}

function isIdHeader(value: string): boolean {
  return /^(技能编号|编号|序号|id|code)$/.test(value);
}

function firstRecordText(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    if (record[key] !== undefined) return cellText(record[key]);
  }
  return "";
}

function findSheetValues(value: unknown): unknown[][] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const direct = record.values;
  if (Array.isArray(direct)) return direct as unknown[][];
  const valueRange = record.valueRange ?? record.value_range;
  if (valueRange && typeof valueRange === "object" && Array.isArray((valueRange as Record<string, unknown>).values)) {
    return (valueRange as Record<string, unknown>).values as unknown[][];
  }
  const data = record.data;
  if (data && typeof data === "object") return findSheetValues(data);
  for (const nested of Object.values(record)) {
    const values = findSheetValues(nested);
    if (values.length > 0) return values;
  }
  return [];
}

function cellText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (Array.isArray(value)) return value.map(cellText).join("").trim();
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text.trim();
    return Object.values(record).map(cellText).join("").trim();
  }
  return "";
}

function cleanText(value: string): string {
  return value
    .replace(/\r?\n+/g, "；")
    .replace(/\s+/g, " ")
    .replace(/；\s*；+/g, "；")
    .replace(/^[：:；\s]+|[；\s]+$/g, "")
    .trim();
}

export function buildSkillSheetRowsForTest(skillItems: SkillItem[]): { rows: SkillSheetRow[]; mergeRanges: SkillMergeRange[] } {
  return flattenSkillSheetRows(skillItems);
}

function flattenSkillSheetRows(skillItems: SkillItem[]): { rows: SkillSheetRow[]; mergeRanges: SkillMergeRange[] } {
  const rows: SkillSheetRow[] = [];
  const mergeRanges: SkillMergeRange[] = [];
  for (const item of skillItems) {
    const phases = item.phases.length > 0 ? item.phases : parseSkillPhases("", item.overview);
    const startRow = 9 + rows.length;
    for (const phase of phases) {
      rows.push({
        generatedId: item.generatedId,
        skillName: item.skillName,
        phaseType: phase.phaseType,
        artDescription: phase.polishedDescription || phase.rawDescription || item.overview
      });
    }
    const endRow = 9 + rows.length - 1;
    if (endRow > startRow) {
      mergeRanges.push({ range: `A${startRow}:A${endRow}`, reason: `${item.generatedId} 编号合并` });
      mergeRanges.push({ range: `B${startRow}:B${endRow}`, reason: `${item.skillName} 名称合并` });
    }
  }
  return { rows, mergeRanges };
}

function buildSkillSheetPlan(skillSheet: NonNullable<FeishuDocumentInput["skillSheet"]>, title: string, skillItems: SkillItem[]) {
  const firstReturnDate = skillSheet.demoDate ? formatMonthDay(skillSheet.demoDate) : "xx/xx";
  const { rows, mergeRanges } = flattenSkillSheetRows(skillItems);
  const patches: Array<{ range: string; values: unknown[][] }> = [
    { range: "A1", values: [[title]] },
    {
      range: "E1",
      values: [[`发包时间：${formatSheetDate(skillSheet.packageDate)}     期望资源验收完成时间：${formatSheetDate(skillSheet.acceptanceDate)}`]]
    },
    {
      range: "F1",
      values: [[`希望 ${firstReturnDate} 前先返回其中一组技能，先返回其中一组技能音效确认风格，可以的话再继续往下做`]]
    }
  ];
  if (rows.length > 0) {
    patches.push({
      range: `A9:E${8 + rows.length}`,
      values: rows.map((item) => [item.generatedId, item.skillName, item.phaseType, "", item.artDescription])
    });
  }
  return {
    templateUrl: skillSheet.templateUrl || "https://leiting.feishu.cn/wiki/LYi2wa7KKiOEJgkl768cjCgdnOb",
    sheetId: "cIvcpO",
    title,
    skillItems,
    rows,
    mergeRanges,
    patches
  };
}

function formatSheetDate(value?: string): string {
  if (!value) return "20xx/xx/xx";
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return `${match[1]}/${match[2]}/${match[3]}`;
  return value.replaceAll("-", "/");
}

function formatMonthDay(value?: string): string {
  if (!value) return "xx/xx";
  const match = value.match(/^\d{4}-(\d{2})-(\d{2})$/);
  if (match) return `${match[1]}/${match[2]}`;
  const parts = value.split(/[-/]/);
  return parts.length >= 2 ? parts.slice(-2).join("/") : value;
}

function skillSheetError(
  markdownPath: string,
  blocksPath: string,
  commandResults: FeishuCommandResult[],
  message: string,
  result: FeishuCommandResult,
  docToken?: string,
  url?: string
): FeishuDocumentResult {
  return FeishuDocumentResultSchema.parse({
    dryRun: false,
    available: true,
    docToken,
    url,
    localMarkdownPath: markdownPath,
    blocksJsonPath: blocksPath,
    commandResults,
    error: {
      message,
      command: result.command,
      args: result.args,
      stdout: result.stdout,
      stderr: result.stderr
    }
  });
}

function parseFolderToken(text: string): string | undefined {
  return parseNestedString(text, ["folder_token", "token"]);
}

function parseCopiedFileToken(text: string): string | undefined {
  return parseNestedString(text, ["token"]);
}

function parseCopiedFileUrl(text: string): string | undefined {
  return parseNestedString(text, ["url"]);
}

function parseNestedString(text: string, keys: string[]): string | undefined {
  try {
    const parsed = JSON.parse(text);
    return findByKeys(parsed, keys);
  } catch {
    for (const key of keys) {
      const match = text.match(new RegExp(`${key}["':=\\s]+([A-Za-z0-9_:/.-]+)`));
      if (match) return match[1];
    }
  }
  return undefined;
}

function findByKeys(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  for (const item of Object.values(record)) {
    const nested = findByKeys(item, keys);
    if (nested) return nested;
  }
  return undefined;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function parseDocToken(text: string): string | undefined {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      const token = findToken(parsed);
      if (typeof token === "string") return token;
    } catch {
      // fall through to regex
    }
  }
  return text.match(/(?:docToken|document_token|token)["':=\s]+([A-Za-z0-9_-]+)/)?.[1];
}

function findToken(value: unknown): unknown {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const token = record.docToken ?? record.document_token ?? record.document_id ?? record.obj_token ?? record.token;
  if (typeof token === "string") return token;
  for (const item of Object.values(record)) {
    const nested = findToken(item);
    if (typeof nested === "string") return nested;
  }
  return undefined;
}
