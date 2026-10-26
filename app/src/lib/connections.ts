/**
 * Connections ("servers") — user data in localStorage (R3, ARCH §4).
 * Small, sync, instant restore. Each connection is independent: own WS,
 * own conversations, own history.
 */
export interface Connection {
  id: string;
  name: string;
  /** wss:// base URL of the agent host's chat service */
  url: string;
  dateAdded: number;
  lastConvId: string | null;
  prefs: Record<string, unknown>;
}

const KEY = "haro-chat:connections";

/** First server — haro on the tailnet (hardcoded seed for v0.1, PRD §4). */
export const DEFAULT_CONNECTION: Omit<Connection, "id" | "dateAdded"> = {
  name: "haro",
  url: "wss://haro.<tailnet>.ts.net/ws",
  lastConvId: null,
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
    id: crypto.randomUUID(),
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
    id: crypto.randomUUID(),
    name,
    url,
    dateAdded: Date.now(),
    lastConvId: null,
    prefs: {},
  };
  saveConnections([...connections, c]);
  return c;
}

export function removeConnection(id: string): void {
  saveConnections(loadConnections().filter((c) => c.id !== id));
}

export function setLastConvId(id: string, convId: string | null): void {
  saveConnections(
    loadConnections().map((c) => (c.id === id ? { ...c, lastConvId: convId } : c)),
  );
}
