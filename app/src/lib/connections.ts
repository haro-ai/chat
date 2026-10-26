/**
 * Connections ("servers") — user data in localStorage (R3, ARCH §4).
 * Small, sync, instant restore. Each connection is independent: own WS,
 * own conversations. Under the hybrid model the durable identity of a
 * conversation is pi's session file on the agent host — the client remembers
 * only the last one it had open, so reopening the app resumes where you
 * left off.
 */
export interface Connection {
  id: string;
  name: string;
  /** wss:// base URL of the agent host's chat service */
  url: string;
  dateAdded: number;
  /** pi session file on the agent host of the last-open conversation */
  lastSessionPath: string | null;
  prefs: Record<string, unknown>;
}

import { uuid } from "@haro/shared";

const KEY = "haro-chat:connections";

/** First server — haro on the tailnet (hardcoded seed for v0.1, PRD §4).
 *  Set VITE_DEFAULT_WS_URL at build time (Dockerfile ARG / DEPLOY.md) to bake
 *  the real URL into the static bundle; per-user connections UI is v0.3. */
const DEFAULT_WS_URL =
  import.meta.env.VITE_DEFAULT_WS_URL || "wss://haro.<tailnet>.ts.net/ws";

export const DEFAULT_CONNECTION: Omit<Connection, "id" | "dateAdded"> = {
  name: "haro",
  url: DEFAULT_WS_URL,
  lastSessionPath: null,
  prefs: {},
};

export function loadConnections(): Connection[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Connection[];
  } catch {
    /* corrupted storage falls back to reseed */
  }
  return [seed()];
}

function seed(): Connection {
  const c: Connection = {
    ...DEFAULT_CONNECTION,
    id: uuid(),
    dateAdded: Date.now(),
  };
  saveConnections([c]);
  return c;
}

export function saveConnections(connections: Connection[]): void {
  localStorage.setItem(KEY, JSON.stringify(connections));
}

export function addConnection(name: string, url: string): Connection {
  const connections = loadConnections();
  const c: Connection = {
    id: uuid(),
    name,
    url,
    dateAdded: Date.now(),
    lastSessionPath: null,
    prefs: {},
  };
  saveConnections([...connections, c]);
  return c;
}

export function removeConnection(id: string): void {
  saveConnections(loadConnections().filter((c) => c.id !== id));
}

export function setLastSessionPath(id: string, sessionPath: string | null): void {
  saveConnections(
    loadConnections().map((c) =>
      c.id === id ? { ...c, lastSessionPath: sessionPath } : c,
    ),
  );
}
