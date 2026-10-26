import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { createLineSplitter } from "./framing.js";
import type { Config } from "./config.js";

/**
 * One `pi --mode rpc` child for one conversation (ARCH §2.3).
 *
 * - spawned lazily in the configured cwd (the SSH .bashrc entry point's
 *   directory), against pi's real session store (Model A — ARCH §3);
 * - an existing session is resumed by passing its file path as `--session`;
 * - stdin/stdout are a verbatim JSONL pump — this service never interprets
 *   content;
 * - child stderr → service log (connection health only, never content).
 */
export class PiChild {
  readonly conv: string;
  private child: ChildProcess | null = null;
  private exited = false;

  constructor(
    private readonly config: Config,
    conv: string,
  ) {
    this.conv = conv;
  }

  get running(): boolean {
    return this.child !== null && !this.exited;
  }

  spawn(
    onRecord: (record: unknown) => void,
    onExit: (code: number | null) => void,
    sessionPath?: string | null,
  ) {
    if (this.child) return;
    const { piBin, piArgs, cwd } = this.config;
    const args = ["--mode", "rpc", ...piArgs];
    if (sessionPath) args.push("--session", sessionPath);
    this.child = spawn(piBin, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    const c = this.child;
    this.exited = false;

    const split = createLineSplitter((line) => {
      try {
        onRecord(JSON.parse(line));
      } catch {
        // A non-JSON line from stdout is a framing bug somewhere; log and drop.
        console.error(`[conv ${this.conv}] unparsable stdout line dropped`);
      }
    });
    c.stdout!.setEncoding("utf8");
    c.stdout!.on("data", split);

    const stderr = createInterface({ input: c.stderr! });
    stderr.on("line", (l) => console.error(`[conv ${this.conv}][pi] ${l}`));

    c.on("exit", (code) => {
      this.exited = true;
      this.child = null;
      onExit(code);
    });
    c.on("error", (err) => {
      console.error(`[conv ${this.conv}] spawn error:`, err.message);
      this.exited = true;
      this.child = null;
      onExit(null);
    });
  }

  /** Send a pi RPC record (already-parsed JSON) as one JSONL line to stdin.
   *  Returns false when the child isn't (yet) running — caller queues. */
  send(record: unknown): boolean {
    const c = this.child;
    if (!c || this.exited || !c.stdin?.writable) {
      return false;
    }
    c.stdin.write(JSON.stringify(record) + "\n");
    return true;
  }

  /** Best-effort stop. */
  stop(): void {
    if (!this.child) return;
    try {
      this.child.stdin?.end();
    } catch {
      /* already closed */
    }
    this.child.kill("SIGTERM");
    this.child = null;
  }
}
