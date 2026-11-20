import path from "node:path";
import { execa, execaCommand } from "execa";

export interface MossAudioFileResult {
  filePath: string;
  fileName: string;
  analysisText: string;
  confidence: number;
  error?: string;
}

export class MossAudioAdapter {
  async checkAvailability(): Promise<{ available: boolean; message: string }> {
    const command = process.env.MOSS_AUDIO_COMMAND?.trim();
    if (command) {
      return { available: true, message: "已配置 MOSS_AUDIO_COMMAND。" };
    }

    const script = process.env.MOSS_AUDIO_SCRIPT?.trim();
    if (!script) {
      return {
        available: false,
        message: "未配置 MOSS_AUDIO_COMMAND 或 MOSS_AUDIO_SCRIPT；将生成可人工补充的声音参考分析框架。"
      };
    }

    const python = process.env.MOSS_AUDIO_PYTHON?.trim() || "python";
    const result = await execa(python, ["--version"], { reject: false });
    return result.exitCode === 0
      ? { available: true, message: `已检测到 Python：${result.stdout || result.stderr}` }
      : { available: false, message: `Python 不可用：${result.stderr || result.stdout}` };
  }

  async analyzeAudioFiles(filePaths: string[], prompt: string): Promise<MossAudioFileResult[]> {
    const availability = await this.checkAvailability();
    if (!availability.available) {
      return filePaths.map((filePath) => ({
        filePath,
        fileName: path.basename(filePath),
        analysisText: `待 MOSS-Audio 分析：${path.basename(filePath)}。${availability.message}`,
        confidence: 0.2
      }));
    }

    const results: MossAudioFileResult[] = [];
    for (const filePath of filePaths) {
      results.push(await this.analyzeOne(filePath, prompt));
    }
    return results;
  }

  private async analyzeOne(filePath: string, prompt: string): Promise<MossAudioFileResult> {
    const fileName = path.basename(filePath);
    try {
      const command = process.env.MOSS_AUDIO_COMMAND?.trim();
      const result = command
        ? await execaCommand(renderCommand(command, { audioPath: filePath, prompt }), { reject: false })
        : await this.runPythonScript(filePath, prompt);

      if (result.exitCode !== 0) {
        return {
          filePath,
          fileName,
          analysisText: result.stdout || "MOSS-Audio 未返回可用分析文本。",
          confidence: 0.25,
          error: result.stderr || `MOSS-Audio exitCode=${result.exitCode}`
        };
      }

      return {
        filePath,
        fileName,
        analysisText: (result.stdout || result.stderr || "").trim() || "MOSS-Audio 未返回可用分析文本。",
        confidence: 0.75
      };
    } catch (error) {
      return {
        filePath,
        fileName,
        analysisText: `MOSS-Audio 调用失败：${error instanceof Error ? error.message : String(error)}`,
        confidence: 0.2,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async runPythonScript(filePath: string, prompt: string) {
    const python = process.env.MOSS_AUDIO_PYTHON?.trim() || "python";
    const script = process.env.MOSS_AUDIO_SCRIPT?.trim();
    if (!script) {
      throw new Error("缺少 MOSS_AUDIO_SCRIPT。");
    }
    const args = [
      script,
      "--audio-path",
      filePath,
      "--prompt",
      prompt
    ];
    const modelPath = process.env.MOSS_AUDIO_MODEL_PATH?.trim();
    if (modelPath) {
      args.push("--model-path", modelPath);
    }
    return execa(python, args, { reject: false, timeout: Number(process.env.MOSS_AUDIO_TIMEOUT_MS ?? 300000) });
  }
}

function renderCommand(command: string, values: { audioPath: string; prompt: string }): string {
  return command
    .replaceAll("{{audioPath}}", quoteForShell(values.audioPath))
    .replaceAll("{{prompt}}", quoteForShell(values.prompt))
    .replaceAll("{{audioPathRaw}}", values.audioPath)
    .replaceAll("{{promptRaw}}", values.prompt);
}

function quoteForShell(value: string): string {
  return `"${value.replace(/(["`$\\])/g, "\\$1")}"`;
}
