export const PREFIX = "/blast-radius";

export function cmd(op: string, extra = ""): string {
  const tail = extra.trim();
  return tail ? `${PREFIX} ${op} ${tail}` : `${PREFIX} ${op}`;
}

export function parseCmd(content: string): { op: string; extra: string } | null {
  const trimmed = content.trim();
  if (trimmed.includes("\n")) return null;
  const m = trimmed.match(/^\/blast-radius\s+([a-zA-Z0-9_-]+)(?:\s+(\S+))?$/);
  if (!m) return null;
  return { op: m[1].toLowerCase(), extra: (m[2] ?? "").replace(/[`#]/g, "") };
}

export function result(op: string, extra: string, line: string): string {
  return `${cmd(op, extra)}\n\n${line}`;
}

export function matchesSha(extra: string, sha: string): boolean {
  const needle = extra.trim().toLowerCase();
  if (!needle) return false;
  const full = sha.toLowerCase();
  const short = full.slice(0, 7);
  return full.startsWith(needle) || needle.startsWith(short) || needle === short;
}
