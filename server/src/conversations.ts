import type { WebSocket } from "ws";
import { PiChild } from "./pi-child.js";
import { listSessions } from "./sessions.js";
import type { Config } from "./config.js";
import { ENVELOPE_VERSION, type Envelope } from "@haro/shared";

/**
 * Per-conversation state: one WS, one lazy pi child (Model A — ARCH §3).
 * In-memory only — the registry is the "conv→child map" from ARCH §1; the
 * durable conversation lives in pi's session store, keyed by the session file
 * path the client passes back in `hello`.
 */
export class Conversation {
  readonly conv: string;
  readonly child: PiChild;
  lastActivity = Date.now();
  /** Session file to resume on the next child spawn (from ctl hello). */
  private sessionPath: string | null = null;
  /** hello received? Pi records before it must not trigger the spawn. */
  private helloSeen = false;
  /** Fallback spawn timer if hello never arrives (compat with old clients). */
  private helloFallback: NodeJS.Timeout | null = null;

  private idleTimer: NodeJS.Timeout | null = null;
  private outSeq = 0;
  private pending: unknown[] = [];
  private spawning = false;
  /** Current client socket — re-attached on reconnect (child survives it). */
  private ws: WebSocket | null = null;

  /** Bind the conversation's client socket. Reconnects rebind here; the pi
   *  child outlives any single WS (ARCH §2.3). */
  attach(ws: WebSocket): void {
    this.ws = ws;
    this.touch();
  }

  constructor(
    private readonly config: Config,
    private readonly onDispose: (conv: string) => void,
    conv: string,
  ) {
    this.conv = conv;
    this.child = new PiChild(config, conv);
  }

  /** Any activity (WS message, pi stdout) resets the idle countdown. */
  touch(): void {
    this.lastActivity = Date.now();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.dispose(), this.config.idleTimeoutMs);
  }

  async handleCtl(payload: unknown): Promise<void> {
    if (typeof payload !== "object" || payload === null) return;
    const ctl = (payload as { ctl?: string }).ctl;

    switch (ctl) {
      case "hello": {
        const { sessionPath } = payload as { sessionPath?: string | null };
        this.sessionPath = typeof sessionPath === "string" && sessionPath ? sessionPath : null;
        this.helloSeen = true;
        if (this.helloFallback) {
          clearTimeout(this.helloFallback);
          this.helloFallback = null;
        }
        await this.ensureChild();
        break;
      }
      case "list_sessions": {
        const sessions = await listSessions(this.config.sessionsDir);
        this.sendCtl({ ctl: "sessions", sessions });
        break;
      }
    }
  }

  private async ensureChild(): Promise<void> {
    if (this.child.running || this.spawning) return;
    this.spawning = true;
    try {
      this.child.spawn(
        (record) => this.sendPiOut(record),
        (code) => console.error(`[conv ${this.conv}] pi child exited (code ${code})`),
        this.sessionPath,
      );
    } finally {
      this.spawning = false;
    }
    // Client records queued while the spawn was pending → flush in order.
    for (const record of this.pending.splice(0)) {
      if (!this.child.send(record)) {
        console.error(`[conv ${this.conv}] dropped queued record (child not running)`);
      }
    }
  }

  /** Client → pi. Queued if the child isn't running yet (spawn is async).
   *  Records that arrive before hello are held: spawning on them would bind
   *  the child before sessionPath lands and resumed sessions would start
   *  fresh. A short fallback timer covers clients that never say hello. */
  sendPi(payload: unknown): void {
    if (!this.helloSeen && !this.child.running) {
      this.pending.push(payload);
      if (!this.helloFallback) {
        this.helloFallback = setTimeout(() => {
          this.helloFallback = null;
          this.helloSeen = true;
          void this.ensureChild();
        }, 2_000);
      }
      return;
    }
    if (!this.child.send(payload)) {
      this.pending.push(payload);
      void this.ensureChild();
    }
  }

  /** pi → client: wrap a record in a `kind:"pi"` envelope. */
  private sendPiOut(payload: unknown): void {
    this.sendEnvelope("pi", payload);
    this.touch();
  }

  /** Service → client control message (session listings). */
  sendCtl(payload: unknown): void {
    this.sendEnvelope("ctl", payload);
  }

  private sendEnvelope(kind: "pi" | "ctl", payload: unknown): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== ws.OPEN) return;
    this.outSeq += 1;
    const env: Envelope = {
      v: ENVELOPE_VERSION,
      conv: this.conv,
      seq: this.outSeq,
      kind,
      payload,
    };
    ws.send(JSON.stringify(env));
  }

  async dispose(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.helloFallback) clearTimeout(this.helloFallback);
    this.helloFallback = null;
    // The session file lives in pi's store (Model A) — stopping the child
    // ends the conversation's residency; nothing else to clean up.
    this.child.stop();
    this.onDispose(this.conv);
  }
}

/** conv → Conversation, plus lazy LRU bookkeeping. */
export class ConversationRegistry {
  private readonly convs = new Map<string, Conversation>();

  constructor(private readonly config: Config) {}

  get(conv: string): Conversation {
    let c = this.convs.get(conv);
    if (!c) {
      c = new Conversation(this.config, (id) => this.convs.delete(id), conv);
      this.convs.set(conv, c);
      this.evictLru();
    }
    return c;
  }

  private evictLru(): void {
    while (this.convs.size > this.config.maxChildren) {
      const lru = [...this.convs.values()].sort(
        (a, b) => a.lastActivity - b.lastActivity,
      )[0];
      if (!lru) return;
      console.log(`[registry] LRU evicting conv ${lru.conv}`);
      void lru.dispose();
    }
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.convs.values()].map((c) => c.dispose()));
  }
}
