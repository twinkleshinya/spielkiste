#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { OrchestratorAgent } from "./orchestrator/OrchestratorAgent.js";
import { TemplateManagerAgent } from "./agents/TemplateManagerAgent.js";
import { FileAdapter } from "./adapters/FileAdapter.js";
import { createLogger } from "./utils/logger.js";
import { AgentNameSchema, ProjectConfig } from "./schemas/index.js";

const program = new Command();
program.name("game-audio-outsourcing-doc-tool").description("游戏音频外包文档自动生成工具").version("0.1.0");

program
  .command("init")
  .description("初始化输出目录和示例配置")
  .action(async () => {
    const fileAdapter = new FileAdapter(process.cwd());
    await fileAdapter.ensureDir(".output/runs");
    await fileAdapter.ensureDir("examples/references");
    console.log("初始化完成：.output/runs 与 examples/references 已准备好。");
  });

program
  .command("ingest")
  .argument("[posInput]", "本地视频文件夹")
  .argument("[posProject]", "项目名")
  .option("--input <dir>", "本地视频文件夹")
  .option("--project <name>", "项目名")
  .description("扫描本地视频并生成 video_manifest.json")
  .action(async (posInput, posProject, options) => {
    const input = stringOption(options.input) ?? envOption("input") ?? posInput;
    const project = stringOption(options.project) ?? envOption("project") ?? posProject;
    if (!input || !project) throw new Error("ingest 需要 --input 和 --project。");
    const orchestrator = new OrchestratorAgent();
    const result = await orchestrator.run({
      input,
      projectName: project,
      dryRun: true,
      only: ["VideoIngestionAgent"]
    });
    console.log(`扫描完成：${result.runDir}`);
  });

program
  .command("template:add")
  .argument("[posName]", "模板名称")
  .argument("[posSource]", "local 或 feishu")
  .option("--name <name>", "模板名称")
  .option("--source <source>", "local 或 feishu")
  .option("--path <path>", "本地模板路径")
  .option("--doc-token <token>", "飞书模板文档 token")
  .description("注册模板")
  .action(async (posName, posSource, options) => {
    const name = stringOption(options.name) ?? envOption("name") ?? posName;
    const source = stringOption(options.source) ?? envOption("source") ?? posSource;
    if (!name || !source) throw new Error("template:add 需要 --name 和 --source。");
    const context = makeTemplateContext();
    const output = await new TemplateManagerAgent().execute(
      {
        projectName: "TemplateRegistry",
        action: "add",
        add: {
          name,
          source,
          path: stringOption(options.path) ?? envOption("path"),
          docToken: stringOption(options.docToken) ?? envOption("doc_token")
        }
      },
      context,
      "template_registry.json"
    );
    console.log(`模板已注册，共 ${output.registry.templates.length} 个。`);
  });

program
  .command("template:list")
  .description("列出模板")
  .action(async () => {
    const context = makeTemplateContext();
    const output = await new TemplateManagerAgent().execute(
      { projectName: "TemplateRegistry", action: "list" },
      context,
      "template_registry.json"
    );
    for (const template of output.registry.templates) {
      console.log(`${template.name}\t${template.source}\t${template.path ?? template.docToken ?? ""}`);
    }
  });

program
  .command("run")
  .argument("[posInput]", "本地视频文件夹")
  .argument("[posProject]", "项目名")
  .argument("[posRequirement]", "需求说明 markdown 路径或文本")
  .argument("[posReferences]", "参考资料目录或文件")
  .argument("[posStyle]", "音频风格说明 markdown 路径或文本")
  .option("--input <dir>", "本地视频文件夹")
  .option("--project <name>", "项目名")
  .option("--requirement <pathOrText>", "需求说明 markdown 路径或文本")
  .option("--references <dirOrFile>", "参考资料目录或文件")
  .option("--style <pathOrText>", "音频风格说明 markdown 路径或文本")
  .option("--audio-reference <paths>", "声音参考文件，多个用逗号分隔")
  .option("--moss-audio", "启用 MOSS-Audio 声音参考分析")
  .option("--template <name>", "模板名称")
  .option("--folder-token <token>", "飞书文件夹 token")
  .option("--doc-token <token>", "更新已有飞书文档 token")
  .option("--dry-run", "只生成本地 markdown/blocks，不写飞书")
  .option("--only <agents>", "只跑指定 agent，逗号分隔")
  .option("--start-date <date>", "排期开始日期 YYYY-MM-DD")
  .option("--due-date <date>", "截止日期 YYYY-MM-DD")
  .option("--people <n>", "外包人数", parseInt)
  .description("完整运行")
  .action(async (posInput, posProject, posRequirement, posReferences, posStyle, options) => {
    const orchestrator = new OrchestratorAgent();
    const config = parseRunOptions(options, { posInput, posProject, posRequirement, posReferences, posStyle });
    if (!config.projectName) throw new Error("run 需要 --project。");
    const result = await orchestrator.run(config);
    printResult(result.runId, result.runDir, result.state.feishuResult?.localMarkdownPath);
  });

program
  .command("resume")
  .argument("[posRunId]", "runId")
  .option("--run-id <id>", "runId")
  .option("--dry-run", "覆盖为 dry-run")
  .option("--only <agents>", "只跑指定 agent，逗号分隔")
  .description("从 .output/runs/{runId} 继续")
  .action(async (posRunId, options) => {
    const runId = stringOption(options.runId) ?? envOption("run_id") ?? posRunId;
    if (!runId) throw new Error("resume 需要 --run-id。");
    const orchestrator = new OrchestratorAgent();
    const result = await orchestrator.resume(runId, {
      dryRun: options.dryRun ?? envBool("dry_run") ?? undefined,
      only: parseOnly(stringOption(options.only) ?? envOption("only"))
    });
    printResult(result.runId, result.runDir, result.state.feishuResult?.localMarkdownPath);
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

function parseRunOptions(
  options: Record<string, unknown>,
  positional: {
    posInput?: string;
    posProject?: string;
    posRequirement?: string;
    posReferences?: string;
    posStyle?: string;
  }
): Partial<ProjectConfig> {
  return {
    input: stringOption(options.input) ?? envOption("input") ?? positional.posInput,
    projectName: stringOption(options.project) ?? envOption("project") ?? positional.posProject,
    requirement: stringOption(options.requirement) ?? envOption("requirement") ?? positional.posRequirement,
    references: stringOption(options.references) ?? envOption("references") ?? positional.posReferences,
    style: stringOption(options.style) ?? envOption("style") ?? positional.posStyle,
    audioReferenceFiles: splitList(stringOption(options.audioReference) ?? envOption("audio_reference")),
    enableMossAudioAnalysis: Boolean(options.mossAudio) || Boolean(envBool("moss_audio")),
    template: stringOption(options.template) ?? envOption("template"),
    folderToken: stringOption(options.folderToken) ?? envOption("folder_token"),
    docToken: stringOption(options.docToken) ?? envOption("doc_token"),
    dryRun: Boolean(options.dryRun) || Boolean(envBool("dry_run")),
    only: parseOnly(stringOption(options.only) ?? envOption("only")),
    schedule: {
      startDate: stringOption(options.startDate) ?? envOption("start_date"),
      dueDate: stringOption(options.dueDate) ?? envOption("due_date"),
      outsourcingPeople: typeof options.people === "number" ? options.people : numberOption(envOption("people")),
      deliveryRounds: 3,
      reviewNodes: []
    }
  };
}

function parseOnly(value?: string) {
  if (!value) return undefined;
  return value.split(",").map((item) => AgentNameSchema.parse(item.trim()));
}

function splitList(value?: string): string[] {
  return value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function stringOption(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function envOption(name: string): string | undefined {
  const value = stringOption(process.env[`npm_config_${name}`]);
  if (value === "true" || value === "false") return undefined;
  return value;
}

function envBool(name: string): boolean | undefined {
  const value = stringOption(process.env[`npm_config_${name}`]);
  if (value === undefined) return undefined;
  return value === "true" || value === "1";
}

function numberOption(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function printResult(runId: string, runDir: string, markdownPath?: string) {
  console.log(`runId: ${runId}`);
  console.log(`runDir: ${runDir}`);
  if (markdownPath) console.log(`markdown: ${markdownPath}`);
}

function makeTemplateContext() {
  const fileAdapter = new FileAdapter(process.cwd());
  return {
    runId: "template",
    runDir: ".output",
    projectName: "TemplateRegistry",
    dryRun: true,
    fileAdapter,
    log: createLogger("template")
  };
}
