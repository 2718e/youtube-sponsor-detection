#!/usr/bin/env bash
# Fetch the local model runtime this project can drive.
#
# Kev speaks the same wire protocol as hosted Jev (POST /v1/systemone), so once
# it is running the extension and the web app reach it by configuration alone.
# See vendor/README.md.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="$root/vendor/kev"
repo="${KEV_REPO:-https://github.com/jaredpalmer/kev}"

command -v uv >/dev/null || { echo "uv is needed (https://docs.astral.sh/uv)." >&2; exit 1; }

if [ -d "$target/.git" ]; then
  echo "Updating $target"
  git -C "$target" pull --ff-only
else
  echo "Cloning $repo into $target"
  git clone --depth 1 "$repo" "$target"
fi

cd "$target"
uv sync --extra serve

echo
echo "Kev is in $target"
echo "Start it with: npm run local:serve"
