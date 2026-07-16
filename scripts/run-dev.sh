#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
unset CARGO_TARGET_DIR
exec pnpm --filter @codex-3d-pet/desktop tauri dev
