# haro-chat — Architecture

The blocks: what the system is made of, how the pieces talk, and where data lives. Product view (vision, milestones, future ideas, open questions) lives in [PRD.md](PRD.md).

> Terminology note: the pi flag is `pi --mode rpc` (not `--rpc`) — everything here is grounded in [pi's RPC docs](https://pi.dev/docs/latest/rpc).

Devices on the tailnet: **cobra** (iPhone, client PWA) · **dynames** (Docker host, static SPA only) · **haro** (Raspberry Pi, runs `pi` + the chat service).

---

## 1. Topology

```
┌────────────────────── cobra (iPhone, PWA / Home Screen) ───────────────────┐
│  Chat UI (React SPA)                                        │
│  - Connections ("servers") in localStorage: {id, name, url, …}             │
│  - Conversation cache in IndexedDB — offline mirror, synced on open (§3)   │
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
                                          │  │  - session-list scan (headers  │ │
                                          │  │    only, metadata never)       │ │
                                          │  └────────────┬───────────────────┘ │
                                          └───────────────┼─────────────────────┘
                                                          │ stdio JSONL
                                          ┌───────────────▼────────────────────┐
                                          │ pi --mode rpc (N children, run in  │
                                          │ the SSH entry point's cwd; real    │
                                          │ ~/.pi/agent/sessions/ store)       │
                                          └────────────────────────────────────┘
```

| Block | Host | Does | Never does |
|---|---|---|---|
| **SPA** (chat client) | cobra (served from dynames) | Connection list (localStorage), conversation/chat UI, offline cache synced on open (§3), speaks pi RPC, outbox + reconnect | Own the durable copy of history |
| **SPA host** | dynames | Serves static files | Store, log, or proxy chat content |
| **Chat service** | haro | WS per conversation; conv→child mapping; pumps pi stdin/stdout verbatim; scans session-store headers for the listing | Understand message content |
| **pi children** | haro | Agent runs, tools, streaming events, session persistence (Model A, §3) | — |

Two implications worth naming:

- **"Chat to many" has two axes** (milestones in [PRD §4](PRD.md#4-milestones-map-each-phase-ships-a-coherent-increment) prove each): multiple agent hosts (each a "server" connection in the SPA) and multiple client devices (each its own cache + session pointers). No client↔client sync — every device re-syncs from the agent host's session store, which is the shared system of record.
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
  conv: string;           // client-generated conversation UUID (WS routing key)
  seq: number;            // monotonic per direction; dedupe on replay
  kind: "pi" | "ctl";     // pi = pi-RPC record; ctl = control
  payload: unknown;       // JSON of the record
};
```

Control (`ctl`) kinds: `hello` (carries the session file to resume, or null for a fresh session), `list_sessions` (client → service), `sessions` (service → client: session-store metadata listing). Content is only ever `kind:"pi"`, passed verbatim.

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

- One `pi --mode rpc` child **per active conversation**, spawned lazily **in the configured cwd (the user's home dir — the same entry point an SSH `.bashrc` drops into)**, from haro's configured environment (extensions/skills/etc. — same identity as the TUI), recycled after idle (cap + LRU — piface's proven `session_manager`/`pi_session` split).
- Resume: `hello.sessionPath` names a file in pi's real session store; the child spawns with `--session <path>`. A fresh conversation spawns without it and pi creates the session file; the client learns the path from `get_state` (`sessionFile`) and persists it in localStorage.
- Session listing: the service scans `<sessionsDir>/*/*.jsonl` and reads each file's `SessionHeader` line (id/timestamp/cwd) plus a bounded tail scan for the newest `session_info` entry (display name). Metadata only — never message content.

---

## 3. Data ownership: Model A — server-authoritative sessions, client cache (hybrid)

Model B (client-owned portable sessions pushed to haro as scratch copies) was implemented first, then **replaced** by this hybrid: pi's own session store is the system of record, and the client keeps a disposable IndexedDB cache for instant open and offline reading. What forced the flip: the killer feature — *resume on the phone a conversation you started over SSH* — is native Model A behavior (same session file, same store), while under Model B every SSH/TUI session lived outside the chat system entirely.

The facts it builds on (unchanged from Model B):

1. **pi session files are self-contained JSONL** ([Session File Format](https://pi.dev/docs/latest/session-format)) — a `SessionHeader` line plus a tree of message/tool/reasoning entries with `id`/`parentId`.
2. **pi resumes any session by path** (`--session <path>` on spawn, `switch_session` over RPC).

So:

1. **pi children spawn in the user's home directory** (the same cwd the SSH `.bashrc` entry point lands in) against pi's **real** session store. No `--session-dir` scratch indirection — the scratch lifecycle is gone.
2. The durable conversation identity is the **session file path** on the agent host. The client learns it from `get_state.sessionFile` (which passes verbatim through the pump) and stores it in localStorage per connection. The conv→child map stays in-memory; after a service restart the client re-attaches with `hello.sessionPath` and the child is re-spawned with `--session`.
3. **Sync on open:** when a conversation opens (or the WS reconnects), the client sends `get_messages` and **fully replaces** its cached message list — the cache never merges, so there is no divergence or dedup machinery. `get_state` in the same round-trip adopts the session path + name.
4. **Sync on settle:** after `agent_settled` the same full replace runs, so every turn lands in the cache exactly as pi wrote it. An optimistic user bubble covers the send-to-sync gap and is dropped on the next sync; if the sync can't reach the server, the streamed text is committed as fallback.
5. **Offline = read-only cache.** The composer is enabled only while the WS is open; cached history renders but accepts nothing new. No outbox-with-reconciliation complexity beyond the transient in-flight prompt.

**What Model B bought that this gives up:** strict "nothing durable on haro." Conversation history now persists in pi's store on the pi itself — hardware you own, on your tailnet, readable only by the pi user. The client-side at-rest crypto story (§4) is downgraded from "the only durable copy" to "cache hygiene."

**Residual Model B discipline kept:** the haro chat service itself still persists nothing and understands nothing — the session store is pi's, written by pi children, exactly as the TUI would. The one added server-side read is the session listing: header lines + a bounded tail scan per file, metadata only.

**Rejected-for-now alternative:** Model B retained with an import/resume shim (spawn a transient `--continue` child, copy the session into scratch, mirror back to clients). Rejected because it re-introduces two session representations (SSH-side and phone-side copies) and a one-way import that fights the bidirectional resume this design gets for free.

**Honest caveats:** a session can be live in a TUI and a phone child simultaneously — pi doesn't lock session files, so concurrent appends can branch (same risk exists with two SSH terminals). Long sessions make `get_messages` full-replace heavier than a delta protocol would be; the escape hatch is `get_entries` with a `since` cursor, kept out of v0.1 for simplicity.

### 3.1 What each host durably stores

| Host | Durable stores |
|---|---|
| **dynames** | The SPA static build. Nothing else |
| **haro** | Service config; **pi's session store** (written by pi children — the system of record) |
| **clients** | Connections + last session path (localStorage); cached messages per conversation (IndexedDB — disposable mirror, rebuilt on open); identity/prefs |

---

## 4. Client blocks (cobra PWA)

| Block | Storage | Notes |
|---|---|---|
| **Connections** ("servers") | `localStorage` | `{id, name, url, dateAdded, lastSessionPath, prefs}` — small, sync, instant restore; the "connections in local-storage" requirement |
| **Conversation cache** (mirror of the server's sessions, per conv) | IndexedDB | Disposable offline mirror; full-replace sync on open/settle (§3); never authoritative |
| **At-rest crypto** | IndexedDB | Downgraded by Model A: the durable copy lives in pi's store on haro, so client-side encryption only protects the *cache*. Kept as a future nicety, not a correctness requirement ([Chrome client-side encryption guidance](https://github.com/GoogleChrome/modern-web-guidance/blob/main/skills/modern-web-guidance/guides/security/client-side-encryption.md)) |
| **PWA shell** | service worker | `manifest.json` (`display: standalone`, apple-touch-icon, `black-translucent`); offline = **read-only history viewer**; outbox queues prompts per connection; `persist()` ([WebKit policy](https://webkit.org/blog/14403/updates-to-storage-policy/), [MDN eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)) |
| **Resilience logic** | runtime | `visibilitychange`/`pageshow`/`online` → reconnect per connection (piface-proven iOS heuristics); `get_messages`-based reconciliation if a run was mid-flight |

---

## 5. Stack decisions

| Decision | Choice | Why |
|---|---|---|
| Chat service language | TypeScript / Node | pi ships `rpc-types.ts` and the exported [`RpcClient`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/rpc/rpc-client.ts) (subprocess + id-correlation + events); pipe-pump nearly off-the-shelf. Python fine (piface) but buys nothing |
| Chat service process handling | One service process; one pi child per active conversation, lazy, capped + LRU | piface's proven split; per-conversation isolation; simple restart semantics |
| SPA framework | **React** + Vite, static build (no meta-framework — routing is connection list → chat view) | LLM-author fluency + user's React familiarity; **shadcn/ui + AI Elements** as source-owned components (Registry refreshes for React first; Preact-compat/Radix edge cases are the avoidable friction). Deliberate choice: own the chat state (Dexie + pi-RPC store) and use AI Elements' `Chat`/`Message`/`Reasoning`/`Tool` components as presentational code — do **not** build on the Vercel AI SDK `useChat` model, which assumes provider-stream lifecycles rather than our pi-session protocol (`shadcn`'s AI-SDK helper supports streaming a canned/own transport path — possible later, not load-bearing; recorded for adoption in PRD parking lot) |
| Client data layer | Dexie (IndexedDB) + preact-free plain stores | Typed IndexedDB cache of server sessions (full-replace sync, §3); keeps streaming state out of the component tree |
| dynames serving | Docker container (nginx/Caddy) behind `tailscale serve` | Static files only — disposable tier |
| HTTPS certs | `tailscale serve` on both dynames and haro | `*.ts.net` certs, zero public exposure, tailnet-only trust model |
| pi invocation | `pi --mode rpc` inside haro's configured environment | haro's full setup (extensions, skills, memory) is exactly what answers in chat |

---

## 6. Trust & threat model

| Where | Who/what | Posture |
|---|---|---|
| PWA on cobra | Your phone | Cache of chats (offline read-only, rebuilt on open); at-rest encryption is cache hygiene, not the durable copy |
| Tailnet | Tailscale between cobra, dynames, haro | WireGuard transport + device identity; off-tailnet attackers find nothing to connect to |
| dynames | Docker host serving static files | Zero sessions, zero DB, zero message knowledge. Worst case (compromise) = public tampering with SPA JS — keep the deploy reproducible |
| haro chat service | The pi | Tunnels through memory; session store is pi's (written by pi children, as the TUI would); session listing reads headers only; **sees traffic in transit while relaying** (design invariant, not crypto blindness) |
| `pi --mode rpc` child | The agent itself | Full trust — runs tools, reads files, produces answers |

---

## 7. Prior art (what this borrows)

- **[jbn/piface](https://github.com/jbn/piface)** — the transport (WS ⇄ pi stdin/stdout, per-session children, `get_messages` replay, iOS reconnect heuristics, Tailscale-serve HTTPS). We keep the mechanics; we invert the storage model: piface's backend persists state; ours persists nothing and dynames is dumber.
- **[superagent-relay](https://github.com/pungme/superagent-relay)** / **[Sideband ADR-016](https://sideband.tech/adr/016-relay-server-design)** — blind rendezvous relay patterns. Not needed on one tailnet; shelved in PRD §5 for the off-tailnet case.
- **Pi docs:** [rpc.md](https://pi.dev/docs/latest/rpc) · [rpc-commands](https://pi.dev/docs/latest/rpc-commands) · [json events](https://pi.dev/docs/latest/json) · [session format](https://pi.dev/docs/latest/session-format) · [message types](https://pi.dev/docs/latest/message-types).
