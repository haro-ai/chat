/**
 * pi session JSONL helpers — the portable-session format shared with the
 * pi TUI (Session File Format, https://pi.dev/docs/latest/session-format).
 * Lines are kept opaque here; we only need entry ids for delta sync.
 */
export interface SessionEntry {
  id: string;
  parentId: string | null;
  [key: string]: unknown;
}

export function parseLine(line: string): SessionEntry | null {
  try {
    const parsed = JSON.parse(line);
    return typeof parsed?.id === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** Full snapshot: every line of the conversation's JSONL. */
export function snapshot(lines: string[]): string[] {
  return lines;
}

/** Delta: lines past the last exchanged entry id (ARCH §3 step 2). */
export function delta(lines: string[], afterEntryId: string | null): string[] {
  if (afterEntryId === null) return lines;
  const idx = lines.findIndex((l) => parseLine(l)?.id === afterEntryId);
  return idx === -1 ? lines : lines.slice(idx + 1);
}

export function lastEntryId(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const id = parseLine(lines[i])?.id;
    if (id) return id;
  }
  return null;
}
