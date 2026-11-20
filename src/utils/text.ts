export function splitKeywords(input: string | string[] | undefined): string[] {
  if (!input) return [];
  const values = Array.isArray(input) ? input : [input];
  return values
    .flatMap((value) => value.split(/[,\n，、;]/g))
    .map((value) => value.trim())
    .filter(Boolean);
}

export function compactText(parts: Array<string | undefined>, fallback = "资料不足，需补充。"): string {
  const text = parts
    .filter((part): part is string => Boolean(part?.trim()))
    .map((part) => part.trim())
    .join("\n\n");
  return text || fallback;
}

export function normalizeTerm(value: string): string {
  return value
    .trim()
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9\u4e00-\u9fa5]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function truncate(value: string, max = 1200): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
