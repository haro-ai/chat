/**
 * Envelope protocol — client ⇄ chat service, one WS per conversation.
 * See ARCHITECTURE.md §2.1.
 *
 * `kind:"pi"`  → payload is a pi RPC record, passed verbatim.
 * `kind:"ctl"` → payload is a control message (hello / snapshot / delta /
 *                presence / idle_ack).
 */
export const ENVELOPE_VERSION = 1;

export type EnvelopeKind = "pi" | "ctl";

export interface Envelope {
  v: number;
  /** client-generated conversation UUID */
  conv: string;
  /** monotonic per direction; dedupe on replay */
  seq: number;
  kind: EnvelopeKind;
  payload: unknown;
}

/** Control kinds (ARCHITECTURE.md §2.1). Content is only ever `kind:"pi"`. */
export type Ctl =
  | { ctl: "hello"; clientId: string; lastEntryId: string | null }
  /** full session JSONL — Model B snapshot, client → haro scratch file */
  | { ctl: "snapshot"; lines: string[] }
  /** entries past a known entry id */
  | { ctl: "delta"; afterEntryId: string | null; lines: string[] }
  | { ctl: "presence"; active: boolean }
  /** service → client: conversation idle, scratch deleted, child recycled */
  | { ctl: "idle_ack" };

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
