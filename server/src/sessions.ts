import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { SessionInfo } from "@haro/shared";

/**
 * Read-only scan of pi's session store (Model A — ARCH §3). Pi writes one
 * self-contained JSONL file per session under
 * `<sessionsDir>/--<path>--/<timestamp>_<session-id>.jsonl`
 * (https://pi.dev/docs/latest/session-format); the first line is a
 * `SessionHeader` carrying `id`, `timestamp`, `cwd`. This module reads the
 * header of every file (metadata only — never message content) plus a tail
 * scan for the newest `session_info` entry, which carries the display name
 * set via `/name`.
 *
 * This is the one server-side read the feature needs; it exposes no content.
 */

/** How far into a file's tail to look for the newest `session_info` entry. */
const NAME_TAIL_BYTES = 256 * 1024;

export async function listSessions(sessionsDir: string): Promise<SessionInfo[]> {
  const out: SessionInfo[] = [];
  let projects: string[];
  try {
    projects = await readdir(sessionsDir);
  } catch {
    return out; // no store yet (or unreadable) → empty listing
  }
  for (const project of projects) {
    const dir = path.join(sessionsDir, project);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const filePath = path.join(dir, file);
      let st;
      try {
        st = await stat(filePath);
      } catch {
        continue; // deleted mid-scan
      }
      const header = await readHeader(filePath);
      if (!header) continue;
      out.push({
        path: filePath,
        id: header.id,
        timestamp: header.timestamp,
        cwd: header.cwd,
        name: await readName(filePath, st.size),
        mtime: st.mtimeMs,
      });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

interface SessionHeader {
  id: string;
  timestamp: string;
  cwd: string;
}

/** First line of the file — `{"type":"session","version":3,…}` (metadata). */
async function readHeader(filePath: string): Promise<SessionHeader | null> {
  const fd = await open(filePath, "r");
  try {
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    const firstLine = buf.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
    try {
      const h = JSON.parse(firstLine) as {
        type?: string;
        id?: string;
        timestamp?: string;
        cwd?: string;
      };
      if (h?.type === "session" && typeof h.id === "string") {
        return {
          id: h.id,
          timestamp: h.timestamp ?? "",
          cwd: h.cwd ?? "",
        };
      }
    } catch {
      return null; // not a pi session file
    }
    return null;
  } finally {
    await fd.close();
  }
}

/**
 * Newest `session_info` entry = the session's display name. Reading only the
 * tail keeps large sessions cheap; a name older than the tail window is
 * reported as unset (cosmetic, not functional).
 */
async function readName(filePath: string, size: number): Promise<string | null> {
  if (size === 0) return null;
  const fd = await open(filePath, "r");
  try {
    const start = Math.max(0, size - NAME_TAIL_BYTES);
    const length = size - start;
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fd.read(buf, 0, length, start);
    const tail = buf.subarray(0, bytesRead).toString("utf8");
    let name: string | null = null;
    for (const line of tail.split("\n")) {
      if (!line.includes('"session_info"')) continue;
      try {
        const entry = JSON.parse(line) as { type?: string; name?: unknown };
        if (entry?.type === "session_info" && typeof entry.name === "string") {
          name = entry.name;
        }
      } catch {
        /* truncated line at the tail window boundary — skip */
      }
    }
    return name;
  } finally {
    await fd.close();
  }
}
