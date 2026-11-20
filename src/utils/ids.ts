export function createRunId(projectName?: string): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 8);
  const project = (projectName ?? "run")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
  return `${stamp}-${project || "run"}-${suffix}`;
}

export function stableId(parts: Array<string | number | undefined>): string {
  return parts
    .filter((part) => part !== undefined && `${part}`.length > 0)
    .map((part) =>
      `${part}`
        .trim()
        .replace(/\.[^.]+$/, "")
        .replace(/[^a-zA-Z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
    )
    .filter(Boolean)
    .join("_")
    .slice(0, 96);
}
