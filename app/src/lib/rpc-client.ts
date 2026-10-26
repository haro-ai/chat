import { ENVELOPE_VERSION, isEnvelope, uuid, type Ctl, type Envelope } from "@haro/shared";
import type { PiResponse } from "@haro/shared";

export type ConnStatus = "idle" | "connecting" | "open" | "closed";

export interface RpcClientOptions {
  /** base WS URL of the agent host's chat service, e.g. wss://haro.<tailnet>.ts.net/ws */
  baseUrl: string;
  /** client-generated conversation UUID (WS routing key — not the session id) */
  convId: string;
  /** pi session file on the agent host to resume; null = fresh session */
  sessionPath: string | null;
  /** pi RPC records from the agent host (responses + streamed events) */
  onRecord: (record: unknown) => void;
  /** control messages from the service (sessions listing) */
  onCtl?: (ctl: Ctl) => void;
  onStatus?: (status: ConnStatus) => void;
}

/**
 * One WS per conversation (ARCH §2.1). Speaks the envelope protocol:
 * `kind:"pi"` envelopes are pi RPC records passed verbatim in both directions;
 * `kind:"ctl"` carries hello / list_sessions / sessions.
 *
 * Hybrid model (ARCH §3): the server's pi session store is the system of
 * record; the client syncs on open with `request()` (get_messages /
 * get_entries) and streams live via onRecord. A per-connection outbox queues
 * records while disconnected; rebind() is the iOS resilience hook.
 */
export class RpcClient {
  private ws: WebSocket | null = null;
  private outbox: Envelope[] = [];
  private outSeq = 0;
  private lastInSeq = 0;
  private status: ConnStatus = "idle";
  private readonly clientId = uuid();
  /** in-flight command requests, correlated by pi response `id` */
  private readonly pending = new Map<string, (r: PiResponse) => void>();
  /** rejectors for in-flight requests, drained on disconnect/close */
  private readonly rejectors = new Set<(err: Error) => void>();

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
      // hello MUST go out before any queued/sync pi records: the server spawns
      // the pi child on the first record it sees, and only hello carries the
      // sessionPath — otherwise resumed conversations spawn a fresh session
      // and their history is lost (reproduce: open a past conversation and
      // watch the WS trace — pi, pi, hello = wrong; hello, pi, pi = right).
      this.sendCtl({
        ctl: "hello",
        clientId: this.clientId,
        sessionPath: this.opts.sessionPath,
      });
      this.setStatus("open");
      // flush outbox in order (sync-on-open requests follow hello)
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
      if (env.kind === "ctl") {
        this.opts.onCtl?.(env.payload as Ctl);
        return;
      }
      // Correlate responses for request() callers; everything else streams.
      if (isResponseWithId(env.payload)) {
        const id = env.payload.id;
        const resolve = this.pending.get(id);
        if (resolve) {
          this.pending.delete(id);
          resolve(env.payload);
          return;
        }
      }
      // (unmatched responses fall through to onRecord — e.g. prompt failures)
      this.opts.onRecord(env.payload);
    };

    ws.onclose = () => {
      this.setStatus("closed");
      this.rejectAll(new Error("connection closed"));
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
    this.rejectAll(new Error("client closed"));
  }

  /** Fire-and-forget pi record (streaming events come back via onRecord). */
  sendPi(record: unknown): void {
    this.enqueue("pi", record);
  }

  /** Service control message (list_sessions). */
  sendCtl(ctl: Ctl): void {
    this.enqueue("ctl", ctl);
  }

  /** Send a pi command and resolve with its response (correlated by `id`).
   *  Used for the sync-on-open reconciliation (get_messages, get_state). */
  request(record: Record<string, unknown>, timeoutMs = 30_000): Promise<PiResponse> {
    const id = uuid();
    return new Promise<PiResponse>((resolve, reject) => {
      const rejector = (err: Error) => {
        this.rejectors.delete(rejector);
        clearTimeout(timer);
        reject(err);
      };
      const timer = setTimeout(
        () => rejector(new Error(`pi request timed out (${String(record.type)})`)),
        timeoutMs,
      );
      this.rejectors.add(rejector);
      this.pending.set(id, (r) => {
        this.rejectors.delete(rejector);
        clearTimeout(timer);
        resolve(r);
      });
      this.sendPi({ id, ...record });
    });
  }

  private rejectAll(err: Error): void {
    this.pending.clear();
    const rejectors = [...this.rejectors];
    this.rejectors.clear();
    for (const reject of rejectors) reject(err);
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

function isResponseWithId(value: unknown): value is PiResponse & { id: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "response" &&
    typeof (value as { id?: unknown }).id === "string"
  );
}
