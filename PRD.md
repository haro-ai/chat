# haro-chat — PRD

Companion to [ARCHITECTURE.md](ARCHITECTURE.md) (which defines the blocks). This document covers the product view: what we're building and for whom, milestones, future ideas, open questions, and the decision log.

---

## 1. Background & vision

Kivlor's helper **haro** runs on a Raspberry Pi in the tailnet, powered by [pi](https://pi.dev) (`pi --mode rpc` gives programmatic control of the agent). Today haro is only reachable via SSH into a shell — awkward from a phone.

**haro-chat is a phone-first chat app for haro — and, over time, for every other pi-powered helper on the tailnet.**

- The SPA is served statically from **dynames** (Docker host) and installed by the user onto their iPhone (**cobra**) as a Home Screen app.
- The SPA holds a list of **"servers"** (agent hosts). The first is **haro**, exposed by a small chat service on the pi; any host can be added later by pasting its URL.
- **All chat history lives on the clients.** dynames stores nothing; haro's service stores nothing durable. No cloud, no third-party relay — everything stays on the tailnet.

**North star:** talking to haro from the phone should feel as natural as running `pi` at a terminal on the pi — same agent identity, same capabilities, zero distance.

---

## 2. Users & environments

| Host | Machine | Role in this product |
|---|---|---|
| **cobra** | iPhone | Client — Home Screen PWA, connections + chat history in local storage |
| **dynames** | Small Docker server | Static SPA host. Stores/relays nothing |
| **haro** | Raspberry Pi | The agent host. Runs `pi`; runs the small chat service. First "server" |
| *(future hosts)* | — | Any other pi/helpers, added as further "server" connections |

Today: one user (Kivlor), own everything, all on one tailnet. iOS Safari is the primary browser; the desktop SPA view is a convenience, not a target.

---

## 3. Product requirements

### Must (v0.x)

- **R1 — Talk to haro from cobra.** Send prompts to haro, see streaming replies. Reachable only via tailnet URL.
- **R2 — Home Screen app.** Installable PWA (standalone display, icon, cached shell) on iOS.
- **R3 — Connections are user data in localStorage.** Users edit, add multiple servers starting with haro (each connection independent: own WS, own conversations, own history).
- **R4 — Chat history is client-owned.** A conversation survives refresh, app restart, and dynames/haro downtime; deleting the SPA's storage kills the history (with warning), and a **recovery export/import** for full restoration (v0.3 scope).
- **R5 — Zero server-side chat persistence.** dynames serves static files only; haro's service keeps conversation bytes only in memory while a turn runs. Nothing readable is written to either host's durable storage. Sessions carried client-side in pi's session format.
- **R6 — Graceful mobile behavior.** iOS backgrounding, network loss, and process death recover cleanly: reconnect + resume, queued outbound prompts (outbox), history visible offline.

### Should (v0.x–v0.4)

- Multiple conversations per server; conversation list, rename, delete (with confirm — that data is unrecoverable).
- Abort/interrupt (`abort`), steer while a run is in progress, show when the model is still busy / `agent_settled`.
- At-rest encryption of IndexedDB with a local passphrase + recovery export; `navigator.storage.persist()`.
- Render assistant markdown/pi tool events sensibly; system-style bubbles for provider errors (never silence).

### Could / later (backlog → §5)

- Past-conversation management, dashboards, sessions, attachments (v0.4+).
- Extension UI dialogs, per-session extensions, dashboard-lite.
- Multi-agent hosts beyond haro proven with a second; connection health indicators.
- Web Push for "haro finished your prompt" (opaque payload, no chat content), voice input/output.

---

## 4. Milestones (map: each phase ships a coherent increment)

### v0.1 — "It lives" (prove round-trip on the phone)

**Outcome:** cobra, served by dynames, chats with haro over the direct tailnet connection.

| Deliverable | Detail |
|---|---|
| haro chat service (first version) | Small Node service on the pi; WS per conversation; spawns `pi --mode rpc` children per active conversation. Speaks the [envelope + pi RPC protocol](ARCHITECTURE.md#4-the-haro-chat-service-protocol) |
| Minimal SPA | Loads from `https://dynames.<tailnet>.ts.net`; one connection is hardcoded (no manual add); one conversation; composer + streaming renderer; keeps a shallow client-side mirror |
| dynames serving | Static file host behind `tailscale serve`; zero logs of content |
| **Success gate** | A message round-trips cobra → dynames-served SPA → haro → pi → back, streamed; refresh preserves history (client mirror); dynames logs show no content |

### v0.2 — "Portable sessions & resilience"

**Outcome:** history is genuinely client-owned (system of record), and the app survives network hits.

| Deliverable | Detail |
|---|---|
| Portable session plumbing | Client stores conversations as [pi-format session JSONL in IndexedDB](ARCHITECTURE.md#3-data-ownership-model-the-critical-design-decision), keyed by client-generated convIds; hands the snapshot (or delta) to haro each turn; receives and stores deltas back |
| Scratch lifecycle on haro | Snapshot written to temp dir; `--session-dir` for pi children; **scratch files deleted on idle** — nothing durable on haro |
| Multi-conversation | List, create, switch, rename, delete (with confirm) per connection |
| Resilience | Auto-reconnect on iOS visibility/foreground/online; per-connection outbox queue; `get_messages`-based reconciliation if the socket drops mid-run |
| **Success gate** | Background the phone mid-reply → resume → reply completes and record appends; kill the WS → reconnect recovers; haro's temp dir empties after idle; `~/.pi/agents/sessions/` never gains these conversations |

### v0.3 — "Client hardening"

**Outcome:** the stored history on phones is encrypted, persistent, and recoverable — safe as the system of record.

| Deliverable | Detail |
|---|---|
| At-rest encryption | Passphrase-derived AES-256-GCM over IndexedDB sessions |
| `persist()` | Nav storage persistence requested on first write; UI shows retention state |
| Recovery export/import | Full history (all connections) to a file; restore on fresh device/install |
| Connections UX | Add/remove servers; URL validation; per-connection deletion sweep (warn) |
| **Success gate** | Wipe cobra → reinstall → recovery import → conversations return; locked IDB rejects unencrypted reads |

### v0.4 — "Parity with the pi TUI, text-first"

**Outcome:** day-to-day conversation features reach a TUI-like baseline.

| Deliverable | Detail |
|---|---|
| Rich model controls | `set_model`/`cycle_thinking_level`/steering-mode UI from `get_available_*` |
| Images in prompts | Via `prompt.images` (base64) — session-file path caveats resolved first |
| Agent states | Busy/settled indicators; abort mid-run; error bubbles |
| Markdown/renderer polish | Code blocks, tool-call summaries, thinking blocks |
| **Success gate** | A phone session through basic TUI flows without ever opening a terminal |

### v1+ — idea pool (uncommitted)

See §5. Second agent host (proving generic-server model), web push, voice, off-tailnet relay revival.

---

## 5. Future ideas (parking lot)

- **Second agent host** — the real proof of the "servers" concept; conformance of any pi host's chat service to the [envelope protocol](ARCHITECTURE.md#4-the-haro-chat-service-protocol).
- **Web push** for "haro settled/finished" without delivering content via the server; requires a push-relay role for one host or dynames; design it so the push payload is opaque and history still lives only on clients.
- **Voice in/out** — record on cobra (mic requires HTTPS; iOS Safari quirks), transcribe on haro (Parakeet), or locally; assistant speech via TTS on haro or client. piface's `Mic → Text` pattern is the blueprint.
- **Off-tailnet fallback** — blind relay (Worker/DO; shipped refrained in this design). If a device ever needs to chat from the internet without Tailscale, revive the relay + sealed-envelope pattern documented [here](ARCHITECTURE.md#8-prior-art-summary-what-we-take--drop) with no redesign of the client.
- **Past-conversation reuse (fdn/fork)** — a conversation can be seeded/forked by exporting the same pi session file across any device or into any pi TUI directly (format is shared).
- **Attachment pipeline** — files/images/audio into pi sessions, path-resolution on agent hosts covered; likely scoped only for haro v1, later for other hosts.
- **Group chat** — multiple humans on one thread; heavy either in server-side state or E2EE-multiparty semantics — revisit before building.
- **Haro's proactive/admin channels** — over time haro-chat may evolve from chat-with-agent to inbox-for-events-from-agent; design space to revisit on demand.
- Theming/skins galore on the SPA; piface shows these are cheap endorphins (not core).
- **Vercel AI SDK `useChat` bridging** — try shadcn AI Elements' chat state machine against a custom transport pointed at our haro WS, as an alternative to owning the state layer outright. Cheap to spike once AI Elements are in as visuals; keep it optional, since pi's session-entry model (tool calls, thinking blocks, tree branches) is richer than the AI SDK message model.

---

## 6. Open questions

| # | Question | Impacts | Status |
|---|---|---|---|
| Q1 | Does the SPA get **connection-level auth** against each server beyond the tailnet (e.g. one-time pairing codes, an `allowlist`, or `Tailscale-User-Login` checks)? | haro service code surface; risk posture | Lean "no" for v0.x (tailnet is the trust boundary, home-lab scale); revisit the moment non-personal devices join |
| Q2 | How do **long sessions** stay cheap in Model B? | compaction-before-export thresholds; UX when a session ships megabytes over wire | Design in v0.2; measure first with real chats |
| Q3 | Where do **images/attachments** actually live (client base64 each turn vs. pi temp store on haro)? | R5 strictness, model cost | Deferred to v0.4; must be resolved before attachments ship |
| Q4 | Is **dynames-hosted SPA caching** (service worker) enough for offline read-only history, or do we cache the haro WS handshake? | offline UX tests on iOS | Prototype in v0.1 |
| Q5 | What's minimum haro-service **deployment story** on the pi (systemd unit? docker? run script)? | reproducibility, upgrades | Decide at v0.2 close |
| Q6 | If a **second agent host** exists someday, do all hosts run identical service code (shared repo) or per-host variants? | repo layout, protocol governance | Allowed to stay open until then |
| Q7 | **SPA identity across servers on iOS**: same localStorage origin on dynames forever — any impact if dynames URL ever changes? | backup/restore UX; URL stability | Note in recovery export design (v0.3) |

---

## 7. Decision log

| Date* | Decision | Rationale | Status |
|---|---|---|---|
| D1 | Chat protocol = **pi RPC tunneled over WS** (no bespoke chat API) | Reuse pi's stable, typed protocol; keeps the server blind by construction | ✅ Adopted (ARCH §2) |
| D2 | **Model B — portable sessions**: client owns history in pi session format on IndexedDB; haro gets transient scratch copies | Satisfies "NOTHING on the chat server" while keeping full TUI fidelity | ✅ Adopted (ARCH §3) |
| D3 | **All-tailnet transport** — direct connections from cobra to dynames (HTTPS) and haro (WSS), both published via `tailscale serve`; **no relay, no cloud rendezvous** | Every device already on the tailnet incl. cellular; WireGuard + tailnet boundary is the trust model; relay demoted to off-tailnet fallback | ✅ Adopted (ARCH §1) |
| D4 | Model A (agent-side pi session persistence on haro) **not chosen**, kept as documented fallback | Conflicts with strict client-ownership; revisit only if Model B wire costs bite | 🔌 Fallback (ARCH §3) |
| D5 | Model B variant "raw turn-by-turn with transcript re-prompting" **rejected** | Loses tool/thinking fidelity, O(n) token cost | ❌ Rejected (ARCH §3) |
| D6 | Server (haro service) sees traffic in transit but **stores nothing durable** — stated as design invariant, not cryptographic guarantee | Honest trust framing on hardware you own | ✅ Adopted (ARCH §6) |
| D7 | Client at-rest **encryption + `persist()`** | The phone is the only durable copy of chats; phone is the lossy surface | ✅ Adopted, v0.3 (ARCH §4) |

\* decision order, not calendar dates.

---

## 8. Non-goals

- **Group chat** (multiple humans on one thread) — out of scope until explicitly re-scoped.
- **Cross-device conversation sync** — each device holds its own conversations; no cloud sync layer.
- **Public exposure** — no feature may put any component on the open internet; the tailnet is the deployment universe.
- **Generalizing beyond pi-hosts** — arbitrary chat backends (OpenAI key-holder pages, etc.) are not part of this product.

---

## 9. Prior art

- **[jbn/piface](https://github.com/jbn/piface)** — closest analog: browser → WS → `pi --mode rpc`, with excellent iOS reconnect mechanics and Tailscale-serve HTTPS. We copy its mechanics; we invert its storage model (client-owned; server memory-only).
- **[superagent-relay](https://github.com/pungme/superagent-relay)** & **[Sideband ADR-016](https://sideband.tech/adr/016-relay-server-design)** — blind-relay patterns; shelved (not needed on one tailnet), revived in §5 if ever.
- **Pi docs:** [RPC](https://pi.dev/docs/latest/rpc) · [RPC commands](https://pi.dev/docs/latest/rpc-commands) · [session format](https://pi.dev/docs/latest/session-format).
