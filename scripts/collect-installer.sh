#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist/installers"
BUNDLE="$ROOT/apps/desktop/src-tauri/target/release/bundle"

# Cursor / custom cargo target dir
if [[ -n "${CARGO_TARGET_DIR:-}" && -d "$CARGO_TARGET_DIR/release/bundle" ]]; then
  BUNDLE="$CARGO_TARGET_DIR/release/bundle"
fi

mkdir -p "$OUT"
shopt -s nullglob

copied=0
for f in "$BUNDLE"/dmg/*.dmg "$BUNDLE"/nsis/*-setup.exe; do
  cp "$f" "$OUT/"
  echo "→ $OUT/$(basename "$f")"
  copied=1
done

if [[ "$copied" -eq 0 ]]; then
  echo "未找到安装包，请检查: $BUNDLE" >&2
  exit 1
fi
