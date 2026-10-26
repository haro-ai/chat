#!/usr/bin/env bash
# haro chat service launcher — native run on the pi (NOT dockerized):
# pi children must inherit haro's configured environment (extensions,
# skills, credentials) so they answer with the same identity as the TUI
# (ARCHITECTURE.md §2.3/§5, PRD Q5).
#
# Used by server/haro-chat.service. Run from anywhere; cds to the repo root.
set -euo pipefail

cd "$(dirname "$0")/.."

# pnpm via corepack if it isn't on PATH (systemd default PATH won't have it).
if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable >/dev/null
fi

exec pnpm --filter @haro/server start