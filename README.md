# haro-chat

Phone-first chat app for **haro** (and, over time, every other pi-powered helper on the tailnet). Read [PRD.md](PRD.md) for the product view and [ARCHITECTURE.md](ARCHITECTURE.md) for the blocks — this repo implements them.

```
cobra (iPhone PWA)  ⇄  dynames (static SPA host)  ·  wss ⇄ haro (Raspberry Pi: chat service + `pi --mode rpc`)
```

- **Server-authoritative sessions, client cache** — pi children run in the same cwd an SSH session lands in, against pi's real session store: resume any conversation — started here or over SSH — from anywhere on the tailnet. The browser keeps an offline cache that re-syncs whenever a conversation opens; sending is online-only.
- **pi RPC over WS** — the SPA speaks pi's RPC protocol directly; the chat service is a dumb pump. No bespoke chat API.
- **Tailnet-only** — everything is published via `tailscale serve`; nothing touches the public internet.

## Layout

| Path | What | Runs on |
|---|---|---|
| `app/` | React + Vite SPA (PWA): connections (localStorage), conversation list + past-session picker, chat UI, offline cache (Dexie/IndexedDB, synced on open), envelope WS client | cobra (served from dynames) |
| `server/` | Chat service: WS per conversation, conv→child map, `pi --mode rpc` children in the user's home dir, past-session listing from pi's session store | haro |
| `shared/` | Envelope protocol + minimal pi RPC types — the contract both sides speak | — |

## Dev

```sh
pnpm install
pnpm dev            # app (Vite) + server (tsx watch) in parallel
pnpm build          # typecheck + build all packages
pnpm typecheck      # tsc --noEmit everywhere
```

- App: http://localhost:5173 (dev); `pnpm --filter @haro/app build` → static bundle in `app/dist/` for dynames.
- Server: binds `127.0.0.1:8787` (config via `server/.env.example`).

## Deploy

See [DEPLOY.md](DEPLOY.md): Dockerfile + compose for the SPA (dynames),
native systemd unit for the chat service (haro), both behind
`tailscale serve`.

## Status

v0.2 (hybrid model, ARCH §3): server-authoritative pi sessions (Model A) with SSH↔phone resume, past-session picker, sync-on-open/settle client cache, online-only composer. At-rest cache crypto and recovery export land in v0.3.

Icons in `app/public/icons/` are solid-color placeholders — replace before shipping the Home Screen install.