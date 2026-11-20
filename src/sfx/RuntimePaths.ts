import path from "node:path";

/** Installed resources are immutable; project paths continue to resolve from the writable data cwd. */
export function appResource(...segments:string[]) {
  const root=path.resolve(process.env.SPIELKISTE_RESOURCE_ROOT || process.cwd());
  const result=path.resolve(root,...segments);
  const relative=path.relative(root,result);
  if(relative===".."||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))throw new Error("无效资源路径");
  return result;
}
