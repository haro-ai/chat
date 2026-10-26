# haro-chat

Phone-first chat app for **haro** (and, over time, every other pi-powered helper on the tailnet). Read [PRD.md](PRD.md) for the product view and [ARCHITECTURE.md](ARCHITECTURE.md) for the blocks — this repo implements them.

```
cobra (iPhone PWA)  ⇄  dynames (static SPA host)  ·  wss ⇄ haro (Raspberry Pi: chat service + `pi --mode rpc`)
```

- **Client-owned history** — conversations live in the browser (localStorage + IndexedDB); the server stores nothing durable.
- **pi RPC over WS** — the SPA speaks pi's RPC protocol directly; the chat service is a dumb pump. No bespoke chat API.
- **Tailnet-only** — everything is published via `tailscale serve`; nothing touches the public internet.

## Layout

| Path | What | Runs on |
|---|---|---|
| `app/` | React + Vite SPA (PWA): connections (localStorage), conversation list, chat UI, client-owned history (Dexie/IndexedDB), envelope WS client | cobra (served from dynames) |
| `server/` | Chat service: WS per conversation, conv→child map, `pi --mode rpc` children, transient scratch files (deleted on idle) | haro |
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

## Deploy (tailscale serve, both hosts)

```sh
# dynames — static SPA only (no content ever transits this host)
tailscale serve --bg https+insecure://127.0.0.1:$(static-file-port)

# haro — chat service (WS-capable proxy, TLS via ts.net cert)
HARO_PI_BIN=pi pnpm --filter @haro/server start &
tailscale serve --bg http://127.0.0.1:8787
```

Then set the SPA's first connection URL to `wss://haro.<tailnet>.ts.net/ws`.

## Status

v0.1 scaffold ("It lives" — PRD §4): envelope protocol, WS service with per-conversation pi children + scratch lifecycle, minimal SPA with streaming renderer and shallow IndexedDB mirror, PWA shell. Portable sessions (Model B snapshot/delta), at-rest crypto, and recovery export land in v0.2/v0.3.

Icons in `app/public/icons/` are solid-color placeholders — replace before shipping the Home Screen install.