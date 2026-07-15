#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist/installers"
BUNDLE="$ROOT/apps/desktop/src-tauri/target/release/bundle"

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

for app in "$BUNDLE"/macos/*.app; do
  zip_path="$OUT/$(basename "${app%.app}").app.zip"
  ditto -c -k --keepParent "$app" "$zip_path"
  echo "→ $zip_path"
  copied=1
done

if [[ "$copied" -eq 0 ]]; then
  echo "未找到安装包，请检查: $BUNDLE" >&2
  exit 1
fi

if [[ "$(uname -s)" == "Darwin" ]]; then
  for app in "$BUNDLE"/macos/*.app; do
    if codesign --verify --deep --strict "$app" 2>/dev/null; then
      echo "✓ 已签名: $(basename "$app")"
    else
      echo "⚠ 签名校验失败: $app" >&2
      exit 1
    fi
  done
fi
