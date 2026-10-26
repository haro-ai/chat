# Deploying haro-chat

Two hosts, two roles ([ARCHITECTURE.md §1](ARCHITECTURE.md)). Nothing is ever
exposed publicly — both hosts publish via `tailscale serve` (`*.ts.net` certs),
and each service binds **loopback only**, so the tailnet is the entire surface.

```
cobra (iPhone) ── https ──> dynames: static SPA only
             └── wss ────> haro: chat service ⇄ pi --mode rpc children
```

---

## dynames — SPA host (Docker)

Yes — it's clone-and-run:

```sh
git clone https://github.com/haro-ai/chat.git
cd chat

# Bake the seeded "haro" connection URL into the SPA bundle (build arg —
# per-user connections UI arrives in v0.3):
VITE_DEFAULT_WS_URL="wss://haro.<tailnet>.ts.net/ws" \
  docker compose up -d --build

sudo tailscale serve --bg http://127.0.0.1:8080
# → https://dynames.<tailnet>.ts.net
```

- Compose binds `127.0.0.1:8080` by default (`APP_BIND`/`APP_PORT` to override);
  nginx serves the static build with SPA fallback (R5: files only, no logs,
  nothing persisted — a disposable tier).
- `tailscale serve` gives the HTTPS origin the PWA needs (service worker,
  Add to Home Screen — the secure-context bits that plain HTTP kills).
- Update flow: `git pull && docker compose up -d --build` (hashed asset names
  mean old tabs keep working until refresh).

The same compose runs on any host if you want a staging SPA (it's just static
files) — but per the topology, dynames is the canonical origin.

## haro — chat service (native, NOT Docker)

Clone and run, but natively — the whole point of the service is spawning
`pi --mode rpc` children **inside haro's configured environment** (extensions,
skills, credentials: the same identity as the TUI, ARCH §5). A container would
hide `~/.pi` from the children. So: clone, install, systemd.

```sh
git clone https://github.com/haro-ai/chat.git ~/Code/haro-chat
cd ~/Code/haro-chat
pnpm install --frozen-lockfile

cp server/.env.example server/.env   # then edit: port, cwd, idle
sudo cp server/haro-chat.service /etc/systemd/system/
# edit the unit: User=, WorkingDirectory, PATH line for the pi user
sudo systemctl daemon-reload && sudo systemctl enable --now haro-chat

sudo tailscale serve --bg http://127.0.0.1:8787   # ws-capable proxy
# → wss://haro.<tailnet>.ts.net
```

(All of the above is exactly what haro can run itself — only the `sudo` lines
need privileges.)

Sanity checks:

```sh
systemctl status haro-chat        # journal shows "listening on 127.0.0.1:8787"
ls ~/.pi/agent/sessions/          # new phone sessions land here, next to SSH/TUI ones
tailscale serve status
```

### Config (`server/.env`)

| Var | Default | Meaning |
|---|---|---|
| `HARO_HOST`/`HARO_PORT` | `127.0.0.1:8787` | loopback bind — `tailscale serve` fronts it |
| `HARO_PI_BIN` | `pi` | resolved on the service PATH; must be **haro's** pi |
| `HARO_CWD` | `$HOME` | working directory pi children run in — the same dir the SSH `.bashrc` entry point drops into (ARCH §3) |
| `HARO_SESSIONS_DIR` | `~/.pi/agent/sessions` | pi's session store, scanned for the past-session listing |
| `HARO_PI_ARGS` | `--approve` | extra args for every pi child; `--approve` trusts the working folder (children are non-interactive and would deadlock on the TUI trust prompt) |
| `HARO_IDLE_TIMEOUT_MS` | `600000` | idle window before a conversation's pi child is recycled |
| `HARO_MAX_CHILDREN` | `4` | simultaneous pi children (LRU beyond) |

## Then, on cobra

Open `https://dynames.<tailnet>.ts.net/` → Add to Home Screen. The seeded
connection points at `VITE_DEFAULT_WS_URL` (or the placeholder if unset —
v0.3 adds the connections UI to edit it). Chat round-trip:
SPA → `wss://haro.<tailnet>.ts.net` → `pi --mode rpc` → streamed back.

## Removing / rolling back

```sh
# dynames
docker compose down && sudo tailscale serve --off
# haro
sudo systemctl disable --now haro-chat && sudo tailscale serve --off
sudo rm /etc/systemd/system/haro-chat.service
# sessions persist in pi's store (~/.pi/agent/sessions) — the system of record.
# Removing the service leaves them; TUI/SSH sessions keep working unchanged.
```