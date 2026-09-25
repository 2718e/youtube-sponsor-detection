#!/usr/bin/env bash
# Serve a local Jev-compatible model on 127.0.0.1, for the extension's "Model
# provider" fields and for MODEL_URL in .env.
#
#   npm run local:serve
#   KEV_MODEL=jaredpalmer/kev-4b KEV_PORT=8010 npm run local:serve

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
kev="$root/vendor/kev"
model="${KEV_MODEL:-jaredpalmer/kev-0.8b}"
port="${KEV_PORT:-8009}"

[ -d "$kev" ] || { echo "No $kev yet — run: npm run local:setup" >&2; exit 1; }

cd "$kev"
exec uv run --extra serve python -m kev.serve --run "$model" --port "$port"
