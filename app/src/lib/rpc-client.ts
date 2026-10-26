import { ENVELOPE_VERSION, isEnvelope, type Ctl, type Envelope } from "@haro/shared";

export type ConnStatus = "idle" | "connecting" | "open" | "closed";

export interface RpcClientOptions {
  /** base WS URL of the agent host's chat service, e.g. wss://haro.<tailnet>.ts.net/ws */
  baseUrl: string;
  /** client-generated conversation UUID (Model B — ids live where the data lives) */
  convId: string;
  /** pi RPC records from the agent host (responses + streamed events) */
  onRecord: (record: unknown) => void;
  onStatus?: (status: ConnStatus) => void;
}

/**
 * One WS per conversation (ARCH §2.1). Speaks the envelope protocol:
 * `kind:"pi"` envelopes are pi RPC records passed verbatim in both directions;
 * `kind:"ctl"` carries hello/snapshot/delta/presence/idle_ack.
 *
 * v0.1 keeps a per-connection outbox (queued while disconnected) and a
 * rebind() hook for iOS resilience (visibilitychange/pageshow/online).
 * v0.2 adds get_messages-based reconciliation after mid-run socket loss.
 */
export class RpcClient {
  private ws: WebSocket | null = null;
  private outbox: Envelope[] = [];
  private outSeq = 0;
  private lastInSeq = 0;
  private status: ConnStatus = "idle";
  private readonly clientId = crypto.randomUUID();

  constructor(private readonly opts: RpcClientOptions) {}

  private setStatus(status: ConnStatus): void {
    this.status = status;
    this.opts.onStatus?.(status);
  }

  /** Connect (idempotent — no-op while open/connecting). */
  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.setStatus("connecting");
    const url = `${this.opts.baseUrl}?conv=${encodeURIComponent(this.opts.convId)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.setStatus("open");
      this.sendCtl({ ctl: "hello", clientId: this.clientId, lastEntryId: null });
      // flush outbox in order
      for (const env of this.outbox.splice(0)) {
        ws.send(JSON.stringify(env));
      }
    };

    ws.onmessage = (ev: MessageEvent) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (!isEnvelope(parsed)) return;
      const env = parsed as Envelope;
      // monotonic per direction; dedupe on replay
      if (env.seq <= this.lastInSeq) return;
      this.lastInSeq = env.seq;
      if (env.kind === "pi") this.opts.onRecord(env.payload);
      // ctl from the service (idle_ack etc.) — nothing to do in v0.1.
    };

    ws.onclose = () => {
      this.setStatus("closed");
    };

    ws.onerror = () => {
      /* surface via onclose → status */
    };
  }

  /** iOS resilience hook: foreground/pageshow/online → reconnect if needed. */
  rebind(): void {
    this.connect();
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
    this.setStatus("idle");
  }

  sendPi(record: unknown): void {
    this.enqueue("pi", record);
  }

  sendCtl(ctl: Ctl): void {
    this.enqueue("ctl", ctl);
  }

  private enqueue(kind: "pi" | "ctl", payload: unknown): void {
    this.outSeq += 1;
    const env: Envelope = {
      v: ENVELOPE_VERSION,
      conv: this.opts.convId,
      seq: this.outSeq,
      kind,
      payload,
    };
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(env));
    } else {
      this.outbox.push(env);
    }
  }
}