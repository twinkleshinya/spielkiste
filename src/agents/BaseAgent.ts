import path from "node:path";
import { FileAdapter } from "../adapters/FileAdapter.js";
import { AgentName } from "../schemas/index.js";
import { serializeError } from "../utils/errors.js";

export interface AgentContext {
  runId: string;
  runDir: string;
  projectName: string;
  dryRun: boolean;
  fileAdapter: FileAdapter;
  log: {
    info: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
  };
}

export abstract class BaseAgent<TInput, TOutput> {
  abstract readonly name: AgentName;
  abstract run(input: TInput, context: AgentContext): Promise<TOutput>;

  protected agentDir(context: AgentContext): string {
    return path.join(context.runDir, "agents", this.name);
  }

  protected async persistInput(input: TInput, context: AgentContext): Promise<string> {
    const outputPath = path.join(this.agentDir(context), "input.json");
    await context.fileAdapter.writeJson(outputPath, input);
    return outputPath;
  }

  protected async persistOutput(output: TOutput, context: AgentContext, fileName: string): Promise<string> {
    const outputPath = path.join(this.agentDir(context), fileName);
    await context.fileAdapter.writeJson(outputPath, output);
    return outputPath;
  }

  protected async persistError(error: unknown, context: AgentContext): Promise<string> {
    const outputPath = path.join(this.agentDir(context), "error.json");
    await context.fileAdapter.writeJson(outputPath, serializeError(error));
    return outputPath;
  }

  async execute(input: TInput, context: AgentContext, outputFileName: string): Promise<TOutput> {
    await this.persistInput(input, context);
    try {
      const output = await this.run(input, context);
      await this.persistOutput(output, context, outputFileName);
      return output;
    } catch (error) {
      await this.persistError(error, context);
      throw error;
    }
  }
}
