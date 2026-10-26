/**
 * Minimal pi RPC record surface — the subset both sides need at the type
 * level today. The full typed surface ships with pi as `rpc-types.ts`
 * (https://pi.dev/docs/latest/rpc-commands); refine these as features land.
 */

/** A request the client sends (tunneled verbatim through the service). */
export interface PiRequest {
  id?: string;
  type: string;
  [key: string]: unknown;
}

/** Response to a command — correlate by `id` (ARCHITECTURE.md §2.2). */
export interface PiResponse {
  id: string;
  type: "response";
  command?: string;
  success: boolean;
  data?: unknown;
  error?: unknown;
}

/** Anything pi streams on stdout that is not a `response`. */
export interface PiEvent {
  type: string;
  [key: string]: unknown;
}

export type PiRecord = PiResponse | PiEvent;

export function isPiResponse(value: unknown): value is PiResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "response"
  );
}

/** Agent finished: read events until this, not `agent_end` (ARCH §2.2). */
export const AGENT_SETTLED = "agent_settled";
