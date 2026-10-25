#!/usr/bin/env bash
# For WSL: copy extension/ to a Windows folder Chrome can load unpacked, e.g.
#   scripts/sync-extension.sh /mnt/c/Users/<you>/job-applier-extension
# then chrome://extensions → Developer mode → Load unpacked → that folder.
# Re-run after changing the extension, then press the reload icon on its card in chrome://extensions.
set -euo pipefail
src="$(cd "$(dirname "$0")/.." && pwd)/extension"
dest="${1:?usage: scripts/sync-extension.sh <windows folder, e.g. /mnt/c/Users/you/job-applier-extension>}"
mkdir -p "$dest"
rm -rf "$dest"/lib
cp -r "$src"/. "$dest"/
echo "Copied to $dest"
