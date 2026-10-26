import os from "node:os";
import path from "node:path";

/**
 * Service config. Binds localhost on haro; published via `tailscale serve`
 * (ARCH §1). Model A (ARCH §3): pi children run in the user's home directory
 * against pi's real session store — the same place the SSH .bashrc entry
 * point lands — so phone and TUI sessions are interchangeable.
 */
export interface Config {
  /** localhost bind — tailscale serve fronts this with TLS */
  host: string;
  port: number;
  /** pi binary + args for `--mode rpc` children */
  piBin: string;
  /** working directory pi children run in (the SSH entry point's cwd) */
  cwd: string;
  /** pi's session store — scanned to list past sessions */
  sessionsDir: string;
  /** extra args for every pi child (e.g. trust flags) */
  piArgs: string[];
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
    cwd: process.env.HARO_CWD ?? os.homedir(),
    sessionsDir:
      process.env.HARO_SESSIONS_DIR ??
      path.join(os.homedir(), ".pi", "agent", "sessions"),
    // --approve: pi children are non-interactive; trust the working folder's
    // project-local files rather than deadlock on a TUI-only prompt. The cwd
    // is the user's own home dir on a tailnet-only box they own.
    piArgs: process.env.HARO_PI_ARGS?.split(" ").filter(Boolean) ?? ["--approve"],
    idleTimeoutMs: num("HARO_IDLE_TIMEOUT_MS", 10 * 60_000),
    maxChildren: num("HARO_MAX_CHILDREN", 4),
  };
}
