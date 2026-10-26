# haro-chat — Architecture

The blocks: what the system is made of, how the pieces talk, and where data lives. Product view (vision, milestones, future ideas, open questions) lives in [PRD.md](PRD.md).

> Terminology note: the pi flag is `pi --mode rpc` (not `--rpc`) — everything here is grounded in [pi's RPC docs](https://pi.dev/docs/latest/rpc).

Devices on the tailnet: **cobra** (iPhone, client PWA) · **dynames** (Docker host, static SPA only) · **haro** (Raspberry Pi, runs `pi` + the chat service).

---

## 1. Topology

```
┌────────────────────── cobra (iPhone, PWA / Home Screen) ───────────────────┐
│  Chat UI (Solid or Svelte SPA)                              │
│  - Connections ("servers") in localStorage: {id, name, url, …}             │
│  - Chat history = client-owned pi session JSONL (IndexedDB, Model B §3)    │
│  - Speaks the pi RPC protocol directly, one WS per conversation            │
└──────┬────────────────────────────────────────────────┬────────────────────┘
       │ https://dynames.<tailnet>.ts.net               │ wss://haro.<tailnet>.ts.net/…
       │ (loads SPA once; after that, purely local)     │ (direct to each agent host)
┌──────▼───────────────────────┐          ┌─────────────▼──────────────────────┐
│ dynames — Docker host        │          │ haro — raspberry pi                  │
│ Static SPA files only.       │          │  ┌────────────────────────────────┐ │
│ No DB, no WS, no logs of     │          │  │ haro chat service (small WS    │ │
│ content, nothing persisted   │          │  │ server) — §2                   │ │
└──────────────────────────────┘          │  │  - one WS per conversation     │ │
                                          │  │  - in-memory conv→child map    │ │
                                          │  │  - transient scratch JSONL     │ │
                                          │  │    in temp dir, deleted idle   │ │
                                          │  └────────────┬───────────────────┘ │
                                          └───────────────┼─────────────────────┘
                                                          │ stdio JSONL
                                          ┌───────────────▼────────────────────┐
                                          │ pi --mode rpc (N children,         │
                                          │ temp --session-dir, transient)     │
                                          └────────────────────────────────────┘
```

| Block | Host | Does | Never does |
|---|---|---|---|
| **SPA** (chat client) | cobra (served from dynames) | Connection list (localStorage), conversation/chat UI, owns history (system of record, ⓘ §3), speaks pi RPC, outbox + reconnect | — |
| **SPA host** | dynames | Serves static files | Store, log, or proxy chat content |
| **Chat service** | haro | WS per conversation; conv→child mapping; pumps pi stdin/stdout verbatim; manages scratch files | Persist a conversation durably; understand message content |
| **pi children** | haro | Agent runs, tools, streaming events | Write to haro's real sessions dir |

Two implications worth naming:

- **"Chat to many" has two axes** (milestones in [PRD §4](PRD.md#4-milestones-map-each-phase-ships-a-coherent-increment) prove each): multiple agent hosts (each a "server" connection in the SPA) and multiple client devices (each its own conversations + own history). No sync between either — clients only own what they wrote.
- **Both dynames and haro publish via Tailscale Serve** (`*.ts.net` certs). The SPA is served over HTTPS, which forces every WS to be `wss://` too; haro's service binds localhost on the pi and is published by `tailscale serve` (same pattern piface documents for phone clients).

---

## 2. Protocol blocks

The breakthrough simplification: **the PWA speaks the [pi RPC protocol](https://pi.dev/docs/latest/rpc-commands) directly**, and the chat service is a dumb pump between WebSocket and pi stdin/stdout. No bespoke chat API; nobody in between understands the content.

```
  client → haro → pi stdin:  {"id":"1","type":"prompt","message":"hello"}
  pi stdout → haro → client: {"id":"1","type":"response","command":"prompt","success":true,
                              "data":{"disposition":"started"}}
  pi stdout → haro → client: {"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Hi"}}
  pi stdout → haro → client: {"type":"agent_settled"}
```

### 2.1 Envelope (client ⇄ chat service, one WS per conversation)

```ts
type Envelope = {
  v: 1;
  conv: string;           // client-generated conversation UUID
  seq: number;            // monotonic per direction; dedupe on replay
  kind: "pi" | "ctl";     // pi = pi-RPC record; ctl = control
  payload: unknown;       // JSON of the record (or session snapshot, §3)
};
```

Control (`ctl`) kinds: `hello`, `snapshot` (full session JSONL), `delta` (entries past a known entry id), `presence`, `idle_ack`. Content is only ever `kind:"pi"`, passed verbatim.

### 2.2 Client command surface ([RPC Commands](https://pi.dev/docs/latest/rpc-commands))

| Client action | pi command | Notes |
|---|---|---|
| Send a message | `{"id":"…","type":"prompt","message":"…"}` (+ `images` base64 later) | `data.disposition:"handled"` ⇒ **no run started** (don't wait for `agent_settled`) |
| Interrupt | `{"type":"abort"}` | |
| Mid-run nudge | `{"type":"steer","message":"…"}` | |
| New conversation | `{"type":"new_session"}` | Client generates the conv UUID |
| Model controls | `set_model`, `set_thinking_level`, `set_steering_mode`, … | Populated via `get_available_models` / `get_available_thinking_levels` |
| Introspection | `get_state`, `get_session_stats`, `get_commands` | Header badges/settings |

Protocol discipline per [rpc.md](https://pi.dev/docs/latest/rpc):
- correlate responses by `id`; commands overlap asynchronously;
- read events until `agent_settled` (not `agent_end` — retries/compaction/steering can continue);
- failed command = single `{"success":false,…}` response; runtime failures surface only in the **event stream** → render as system bubbles;
- JSONL framing is LF-only (WebSocket handles message framing; hi markdown never splittable on `U+2028/2029` — daemon side must not use Node's `readline`, it splits on those too).

### 2.3 Conversation → pi child mapping (service)

- One `pi --mode rpc` child **per active conversation**, spawned lazily from haro's configured environment (extensions/skills/etc. — same identity as the TUI), recycled after idle (cap + LRU — piface's proven `session_manager`/`pi_session` split).
- Scratch cycle: snapshot → `$TMPDIR/<conv>.jsonl`; child runs with `--session-dir $TMPDIR`; scratch deleted on idle; WS drops don't destroy scratch mid-run (best-effort finish, then clean).

---

## 3. Data ownership: Model B — portable session (system of record = client)

Two facts from pi's docs unlock "nothing on the server, everything on the clients":

1. **pi session files are self-contained JSONL** ([Session File Format](https://pi.dev/docs/latest/session-format)) — a `SessionHeader` line plus a tree of message/tool/reasoning entries with `id`/`parentId`.
2. **`switch_session` loads any path**: `{"type":"switch_session","sessionPath":"/any/session.jsonl"}`.

So:

1. The client stores each conversation as a pi-format session JSONL in **IndexedDB**, keyed by a **convId the client generated**. (Local-only. No server- or haro-assigned id; conversation lives where its data lives.)
2. Each turn: client sends the session snapshot — or only the **delta past the last exchanged entry `id`** — to haro, which writes it to a scratch file.
3. pi child runs with `--session-dir` pointed at the temp **scratch dir** — so **haro's real `~/.pi/agents/sessions/` never gains a copy**.
4. pi streams events back; client appends its own copy of the JSONL; client is the single durable copy.
5. haro's snapshot/scratch files are deleted on idle. On haro, at-rest history is transient (on hardware you own; strictly temp-dir scoped).

This preserves full fidelity (tool calls, thinking blocks, system-prompt patches, tree structure — the same bytes the TUI writes). **Rejected alternative** (and kept documented for honesty): raw turn-by-turn `--no-session` re-prompting — pi's `prompt` takes a single message, no full-transcript injection primitive; O(n) token cost, loss of tool/thinking structure. **Fallback alternative** (if wire costs bite): Model A — agent-side pi sessions persist on haro itself (documented in the PRD decision log D2–D5).

**Honest scope note:** at-rest history unavoidably transits haro in scratch files while pi is generating, and the haro service could in principle observe traffic in transit (TLS terminates there); both are bounded by the invariant above — designs that store **nothing** durably server-side, not cryptographic blindness.

### 3.1 What each host durably stores

| Host | Durable stores |
|---|---|
| **dynames** | The SPA static build. Nothing else |
| **haro** | Service config only; conversation content only as temp-dir scratch, deleted on idle |
| **clients** | Connections (localStorage); session JSONL per conversation (IndexedDB, at-rest encryptable §5.3); identity/prefs |

---

## 4. Client blocks (cobra PWA)

| Block | Storage | Notes |
|---|---|---|
| **Connections** ("servers") | `localStorage` | `{id, name, url, dateAdded, lastConvId, prefs}` — small, sync, instant restore; the "connections in local-storage" requirement |
| **Sessions** (pi-format JSONL per conv, per connection) | IndexedDB | System of record; append-only entries (to last entry-id pointer) |
| **At-rest crypto** | IndexedDB | Non-extractable `CryptoKey`s cannot survive `localStorage` string round-trips — must live in IndexedDB ([Chrome client-side encryption guidance](https://github.com/GoogleChrome/modern-web-guidance/blob/main/skills/modern-web-guidance/guides/security/client-side-encryption.md)); passphrase → PBKDF2/HKDF → AES-256-GCM is the same pattern as [ETHOS](https://github.com/aitherapp/ethos-core) and [PartyLayer](https://github.com/PartyLayer/PartyLayer/blob/main/packages/session/src/crypto.ts) |
| **PWA shell** | service worker | `manifest.json` (`display: standalone`, apple-touch-icon, `black-translucent`); offline = **read-only history viewer**; outbox queues prompts per connection; `persist()` ([WebKit policy](https://webkit.org/blog/14403/updates-to-storage-policy/), [MDN eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)) |
| **Resilience logic** | runtime | `visibilitychange`/`pageshow`/`online` → reconnect per connection (piface-proven iOS heuristics); `get_messages`-based reconciliation if a run was mid-flight |

---

## 5. Stack decisions

| Decision | Choice | Why |
|---|---|---|
| Chat service language | TypeScript / Node | pi ships `rpc-types.ts` and the exported [`RpcClient`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/rpc/rpc-client.ts) (subprocess + id-correlation + events); pipe-pump nearly off-the-shelf. Python fine (piface) but buys nothing |
| Chat service process handling | One service process; one pi child per active conversation, lazy, capped + LRU | piface's proven split; per-conversation isolation; simple restart semantics |
| SPA framework | **React** + Vite, static build (no meta-framework — routing is connection list → chat view) | LLM-author fluency + user's React familiarity; **shadcn/ui + AI Elements** as source-owned components (Registry refreshes for React first; Preact-compat/Radix edge cases are the avoidable friction). Deliberate choice: own the chat state (Dexie + pi-RPC store) and use AI Elements' `Chat`/`Message`/`Reasoning`/`Tool` components as presentational code — do **not** build on the Vercel AI SDK `useChat` model, which assumes provider-stream lifecycles rather than our pi-session protocol (`shadcn`'s AI-SDK helper supports streaming a canned/own transport path — possible later, not load-bearing; recorded for adoption in PRD parking lot) |
| Client data layer | Dexie (IndexedDB) + preact-free plain stores | LLM-blueprinted typed IndexedDB (Model B's session JSONL append store); keeps streaming state out of the component tree |
| dynames serving | Docker container (nginx/Caddy) behind `tailscale serve` | Static files only — disposable tier |
| HTTPS certs | `tailscale serve` on both dynames and haro | `*.ts.net` certs, zero public exposure, tailnet-only trust model |
| pi invocation | `pi --mode rpc` inside haro's configured environment | haro's full setup (extensions, skills, memory) is exactly what answers in chat |

---

## 6. Trust & threat model

| Where | Who/what | Posture |
|---|---|---|
| PWA on cobra | Your phone | **The only durable copy of chats.** At-rest encrypted, `persist()`ed, recoverable by export |
| Tailnet | Tailscale between cobra, dynames, haro | WireGuard transport + device identity; off-tailnet attackers find nothing to connect to |
| dynames | Docker host serving static files | Zero sessions, zero DB, zero message knowledge. Worst case (compromise) = public tampering with SPA JS — keep the deploy reproducible |
| haro chat service | The pi | Tunnels through memory; scratch temp-scoped; **sees traffic in transit while relaying** (design invariant, not crypto blindness) |
| `pi --mode rpc` child | The agent itself | Full trust — runs tools, reads files, produces answers |

---

## 7. Prior art (what this borrows)

- **[jbn/piface](https://github.com/jbn/piface)** — the transport (WS ⇄ pi stdin/stdout, per-session children, `get_messages` replay, iOS reconnect heuristics, Tailscale-serve HTTPS). We keep the mechanics; we invert the storage model: piface's backend persists state; ours persists nothing and dynames is dumber.
- **[superagent-relay](https://github.com/pungme/superagent-relay)** / **[Sideband ADR-016](https://sideband.tech/adr/016-relay-server-design)** — blind rendezvous relay patterns. Not needed on one tailnet; shelved in PRD §5 for the off-tailnet case.
- **Pi docs:** [rpc.md](https://pi.dev/docs/latest/rpc) · [rpc-commands](https://pi.dev/docs/latest/rpc-commands) · [json events](https://pi.dev/docs/latest/json) · [session format](https://pi.dev/docs/latest/session-format) · [message types](https://pi.dev/docs/latest/message-types).
