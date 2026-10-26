import type { WebSocket } from "ws";
import { PiChild } from "./pi-child.js";
import { Scratch } from "./scratch.js";
import type { Config } from "./config.js";
import { ENVELOPE_VERSION, type Envelope } from "@haro/shared";

/**
 * Per-conversation state: one WS, one lazy pi child, one scratch file.
 * In-memory only — the registry is the "conv→child map" from ARCH §1.
 */
export class Conversation {
  readonly conv: string;
  readonly scratch: Scratch;
  readonly child: PiChild;
  lastActivity = Date.now();

  private idleTimer: NodeJS.Timeout | null = null;
  private outSeq = 0;
  private pending: unknown[] = [];
  private spawning = false;

  constructor(
    private readonly config: Config,
    private readonly onDispose: (conv: string) => void,
    conv: string,
  ) {
    this.conv = conv;
    this.scratch = new Scratch(config, conv);
    this.child = new PiChild(config, this.scratch.dir, conv);
  }

  /** Any activity (WS message, pi stdout) resets the idle countdown. */
  touch(): void {
    this.lastActivity = Date.now();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.dispose(), this.config.idleTimeoutMs);
  }

  async handleCtl(payload: unknown, ws: WebSocket): Promise<void> {
    if (typeof payload !== "object" || payload === null) return;
    const ctl = (payload as { ctl?: string }).ctl;

    switch (ctl) {
      case "hello": {
        await this.ensureChild(ws);
        break;
      }
      case "snapshot": {
        const { lines } = payload as { lines?: string[] };
        await this.scratch.writeSnapshot(lines ?? []);
        await this.ensureChild(ws);
        break;
      }
      case "delta": {
        const { lines } = payload as { lines?: string[] };
        await this.scratch.appendDelta(lines ?? []);
        await this.ensureChild(ws);
        break;
      }
      case "presence": {
        // active/inactive hint from the client; the idle timer is the source
        // of truth server-side (v0.2 reconciles via get_messages).
        break;
      }
      // idle_ack is service → client only.
    }
  }

  private async ensureChild(ws: WebSocket): Promise<void> {
    if (this.child.running || this.spawning) return;
    this.spawning = true;
    try {
      await this.scratch.ensureDir();
      this.child.spawn(
        (record) => this.sendPiOut(ws, record),
        (code) => console.error(`[conv ${this.conv}] pi child exited (code ${code})`),
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

  /** Client → pi. Queued if the child isn't running yet (spawn is async). */
  sendPi(ws: WebSocket, payload: unknown): void {
    if (!this.child.send(payload)) {
      this.pending.push(payload);
      void this.ensureChild(ws);
    }
  }

  /** pi → client: wrap a record in a `kind:"pi"` envelope. */
  private sendPiOut(ws: WebSocket, payload: unknown): void {
    if (ws.readyState !== ws.OPEN) return;
    this.outSeq += 1;
    const env: Envelope = {
      v: ENVELOPE_VERSION,
      conv: this.conv,
      seq: this.outSeq,
      kind: "pi",
      payload,
    };
    ws.send(JSON.stringify(env));
    this.touch();
  }

  async dispose(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.child.stop();
    await this.scratch.destroy();
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