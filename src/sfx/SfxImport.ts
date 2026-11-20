import path from "node:path";

export function importedLibraryPath(sessionRoot: string) {
  return path.join(path.resolve(sessionRoot), "audio_references");
}

export function importedVideoPath(sessionRoot: string, fileName: string) {
  const root = path.resolve(sessionRoot);
  const safeName = path.basename(fileName);
  const target = path.resolve(root, "videos", safeName);
  if (safeName !== fileName || !target.toLowerCase().startsWith(`${path.join(root, "videos").toLowerCase()}${path.sep}`)) {
    throw new Error("非法视频文件名");
  }
  return target;
}
