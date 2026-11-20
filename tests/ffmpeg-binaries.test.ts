import assert from "node:assert/strict";

export async function testWindowsFfmpegInvocationUsesBinaryDirectly() {
  const binaries: any = await import("../src/sfx/FfmpegBinaries.js");
  assert.equal(typeof binaries.ffmpegInvocation, "function", "FFmpeg invocation helper should exist");
  const invocation = binaries.ffmpegInvocation(["__ffprobe__", "-v", "error", "video.mp4"]);
  assert.notEqual(invocation.command.toLowerCase(), "powershell.exe");
  assert.deepEqual(invocation.args, ["-v", "error", "video.mp4"]);
}

export async function testWindowsFfmpegPermissionFallbacks() {
  const binaries: any = await import("../src/sfx/FfmpegBinaries.js");
  assert.equal(binaries.isSpawnPermissionError({ code: "EPERM" }), true);
  assert.equal(binaries.isSpawnPermissionError(new Error("spawn EPERM")), true);
  assert.equal(binaries.isSpawnPermissionError(new Error("invalid media")), false);
  const fallbacks = binaries.ffmpegFallbackInvocations({ command: "C:\\Program Files\\ffmpeg\\bin\\ffprobe.exe", args: ["-v", "error", "video.mp4"] });
  assert.ok(fallbacks.some((item: any) => item.command.toLowerCase() === "cmd.exe" || item.command.toLowerCase().endsWith("\\cmd.exe")), "Windows permission failures need a cmd.exe fallback");
  assert.ok(fallbacks.some((item: any) => item.windowsHide === false), "the retry must allow a visible process");
}
