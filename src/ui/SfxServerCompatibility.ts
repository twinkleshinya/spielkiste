export const SFX_API_VERSION = "2026-11-22";

export const SFX_REQUIRED_CAPABILITIES = [
  "add-described-event",
  "locate-event",
  "quick-edit",
  "edit-preview",
  "reaper-portable-export",
  "keyword-priority",
  "reaper-native-conversion",
  "ai-config",
  "ai-multimodal-check",
  "reaper-name-extension",
  "library-exclusions",
  "ai-reasoning-effort",
  "style-research",
  "reference-work-style",
  "style-conflict-clarification",
  "style-conflict-options",
  "folder-keyword-search",
  "creative-brief",
  "project-git-export",
  "library-index-cache",
  "analysis-without-total-deadline",
  "audio-output-mode"
] as const;

type HealthPayload = {
  ok?: unknown;
  standard?: { workflow?: unknown };
  apiVersion?: unknown;
  capabilities?: unknown;
};

export function isSfxHealth(value: unknown): value is HealthPayload {
  const payload = value as HealthPayload | null | undefined;
  return payload?.ok === true && payload.standard?.workflow === "reference-v6";
}

export function isCurrentSfxHealth(value: unknown): boolean {
  if (!isSfxHealth(value)) return false;
  const payload = value as HealthPayload;
  if (payload.apiVersion !== SFX_API_VERSION || !Array.isArray(payload.capabilities)) return false;
  const capabilities = payload.capabilities as unknown[];
  return SFX_REQUIRED_CAPABILITIES.every(capability => capabilities.includes(capability));
}

