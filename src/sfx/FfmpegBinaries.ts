import fs from "node:fs";
import path from "node:path";
import { execa, type Options } from "execa";
import {taskCheckpoint,taskSignal} from './TaskControl.js';

export type FfmpegProcessInvocation = { command: string; args: string[] };
export type FfmpegFallbackInvocation = FfmpegProcessInvocation & { windowsHide: boolean };
const fallbackModeByCommand = new Map<string, number>();

function windowsCandidates(): string[] {
  const candidates = [process.env.FFMPEG_PATH?.trim()];
  const wingetRoot = path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Packages");
  try {
    for (const packageName of fs.readdirSync(wingetRoot).filter(name => /^Gyan\.FFmpeg[_\.]/i.test(name))) {
      const packageRoot = path.join(wingetRoot, packageName);
      for (const version of fs.readdirSync(packageRoot).filter(name => /^ffmpeg-/i.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) candidates.push(path.join(packageRoot, version, "bin", "ffmpeg.exe"));
    }
  } catch { /* FFmpeg may be installed via PATH or a custom location. */ }
  candidates.push("C:\\ffmpeg\\bin\\ffmpeg.exe", "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe");
  return candidates.filter((value): value is string => Boolean(value));
}

export function ffmpegBinary() {
  if (process.platform === "win32") return windowsCandidates().find(candidate => fs.existsSync(candidate)) || "ffmpeg.exe";
  return process.env.FFMPEG_PATH || "ffmpeg";
}

export function ffprobeBinary() {
  if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
  const binary = ffmpegBinary();
  return binary.toLowerCase().endsWith("ffmpeg.exe") ? path.join(path.dirname(binary), "ffprobe.exe") : process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
}

export function ffmpegInvocation(args: string[]): FfmpegProcessInvocation {
  const isProbe = args[0] === "__ffprobe__";
  return {
    command: isProbe ? ffprobeBinary() : ffmpegBinary(),
    args: isProbe ? args.slice(1) : args
  };
}

export function isSpawnPermissionError(error: unknown): boolean {
  const candidate = error as { code?: unknown; errno?: unknown; message?: unknown } | undefined;
  return candidate?.code === "EPERM" || candidate?.errno === -4048 || /\bspawn\s+EPERM\b/i.test(String(candidate?.message ?? error));
}

function quoteCmdArg(value: string): string {
  if (value.length > 0 && !/[\s"&|<>^]/.test(value)) return value;
  // CommandLineToArgvW-compatible quoting for paths and filter expressions.
  return `"${value.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/g, "$1$1")}"`;
}

function quotePowerShellArg(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function ffmpegFallbackInvocations(invocation: FfmpegProcessInvocation): FfmpegFallbackInvocation[] {
  if (process.platform !== "win32") return [];
  const commandLine = [invocation.command, ...invocation.args].map(quoteCmdArg).join(" ");
  const powershell = ["&", quotePowerShellArg(invocation.command), ...invocation.args.map(quotePowerShellArg)].join(" ");
  return [
    { command: "cmd.exe", args: ["/d", "/s", "/c", commandLine], windowsHide: true },
    { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", powershell], windowsHide: false }
  ];
}

export async function runFfmpeg(args: string[], options?: Options): Promise<{ stdout: string; stderr: string }> {
  await taskCheckpoint();
  const invocation = ffmpegInvocation(args);
  const baseOptions = { ...options, cancelSignal:taskSignal(options?.cancelSignal), encoding: "utf8" as const };
  const run = async (command: string, commandArgs: string[], windowsHide: boolean) => {await taskCheckpoint();const result=await execa(command, commandArgs, { ...baseOptions, windowsHide });await taskCheckpoint();return result;};
  const knownFallback = fallbackModeByCommand.get(invocation.command);
  if (knownFallback !== undefined) {
    const fallback = ffmpegFallbackInvocations(invocation)[knownFallback];
    return run(fallback.command, fallback.args, fallback.windowsHide).catch(async error => {
      if (!isSpawnPermissionError(error)) throw error;
      fallbackModeByCommand.delete(invocation.command);
      return run(invocation.command, invocation.args, options?.windowsHide ?? true);
    }) as Promise<{ stdout: string; stderr: string }>;
  }
  return run(invocation.command, invocation.args, options?.windowsHide ?? true)
    .catch(async error => {
      if (process.platform !== "win32" || !isSpawnPermissionError(error)) throw error;
      let lastError: unknown = error;
      for (const [index, fallback] of ffmpegFallbackInvocations(invocation).entries()) {
        try {
          const result = await run(fallback.command, fallback.args, fallback.windowsHide);
          fallbackModeByCommand.set(invocation.command, index);
          return result;
        } catch (fallbackError) {
          lastError = fallbackError;
          if (!isSpawnPermissionError(fallbackError)) throw fallbackError;
        }
      }
      throw lastError;
    }) as Promise<{ stdout: string; stderr: string }>;
}
