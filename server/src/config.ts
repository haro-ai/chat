import os from "node:os";
import path from "node:path";

/**
 * Service config. Binds localhost on haro; published via `tailscale serve`
 * (ARCH §1). Conversation content only ever lives in the scratch dir —
 * nothing durable is written by this service (R5).
 */
export interface Config {
  /** localhost bind — tailscale serve fronts this with TLS */
  host: string;
  port: number;
  /** pi binary + args for `--mode rpc` children */
  piBin: string;
  /** root of transient scratch session dirs (deleted on idle) */
  scratchRoot: string;
  /** recycle a conversation's pi child after this idle window (ms) */
  idleTimeoutMs: number;
  /** max simultaneously spawned pi children (LRU beyond this) */
  maxChildren: number;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  return v ? Number(v) : fallback;
}

export function loadConfig(): Config {
  return {
    host: process.env.HARO_HOST ?? "127.0.0.1",
    port: num("HARO_PORT", 8787),
    piBin: process.env.HARO_PI_BIN ?? "pi",
    scratchRoot:
      process.env.HARO_SCRATCH_ROOT ??
      path.join(os.tmpdir(), "haro-chat-scratch"),
    idleTimeoutMs: num("HARO_IDLE_TIMEOUT_MS", 10 * 60_000),
    maxChildren: num("HARO_MAX_CHILDREN", 4),
  };
}
