/**
 * Envelope protocol — client ⇄ chat service, one WS per conversation.
 * See ARCHITECTURE.md §2.1.
 *
 * `kind:"pi"`  → payload is a pi RPC record, passed verbatim.
 * `kind:"ctl"` → payload is a control message (hello / list_sessions /
 *                sessions).
 */
export const ENVELOPE_VERSION = 1;

export type EnvelopeKind = "pi" | "ctl";

export interface Envelope {
  v: number;
  /** client-generated conversation UUID (WS routing key — not the session id) */
  conv: string;
  /** monotonic per direction; dedupe on replay */
  seq: number;
  kind: EnvelopeKind;
  payload: unknown;
}

/**
 * Metadata for one past session on the agent host (Model A — ARCH §3):
 * read from the session file's `SessionHeader` line plus a tail scan for the
 * newest `session_info` entry (display name). The `path` is the resume key —
 * pass it back in `hello` to reopen the session.
 */
export interface SessionInfo {
  /** absolute path of the session file on the agent host */
  path: string;
  /** pi session id (UUID, from the header) */
  id: string;
  /** ISO timestamp the session started */
  timestamp: string;
  /** working directory the session belongs to (pi groups sessions by cwd) */
  cwd: string;
  /** display name set via /name, if any */
  name: string | null;
  /** file mtime (ms) — proxy for last activity; sessions sort by this */
  mtime: number;
}

/** Control kinds (ARCHITECTURE.md §2.1). Content is only ever `kind:"pi"`. */
export type Ctl =
  | {
      ctl: "hello";
      clientId: string;
      /** pi session file on the agent host to resume; null = fresh session */
      sessionPath: string | null;
    }
  /** client → service: list past sessions on this agent host (metadata only) */
  | { ctl: "list_sessions" }
  /** service → client: the session listing (a fresh envelope, not a response) */
  | { ctl: "sessions"; sessions: SessionInfo[] };

export function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Partial<Envelope>;
  return (
    e.v === ENVELOPE_VERSION &&
    typeof e.conv === "string" &&
    typeof e.seq === "number" &&
    (e.kind === "pi" || e.kind === "ctl") &&
    "payload" in e
  );
}
