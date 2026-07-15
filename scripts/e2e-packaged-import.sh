#!/usr/bin/env bash
# 用打包版 .app + 样本 VRM 跑自检，验证贴图能加载
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/apps/desktop/src-tauri/target/release/bundle/macos/Codex 3D 桌宠.app"
BIN="$APP/Contents/MacOS/codex-3d-pet"
VRM="$ROOT/apps/desktop/test-fixtures/sample.vrm"
RESULT="$HOME/Library/Application Support/com.codex3dpet.desktop/self-test-result.json"
SHOT="$ROOT/dist/installers/e2e-verified-screenshot.png"

[[ -x "$BIN" ]] || { echo "缺少二进制，请先 pnpm package" >&2; exit 1; }
[[ -f "$VRM" ]] || { echo "缺少测试 VRM: $VRM" >&2; exit 1; }

node "$ROOT/apps/desktop/scripts/verify-vrm-structure.mjs" "$VRM"

killall "codex-3d-pet" 2>/dev/null || true
rm -f "$RESULT"
sleep 1

echo "→ 启动自检导入"
CODEX_PET_SELF_TEST="$VRM" "$BIN" >/tmp/codex-pet-self-test.log 2>&1 &
APP_PID=$!

for i in $(seq 1 30); do
  if [[ -f "$RESULT" ]]; then
    break
  fi
  sleep 1
done

if [[ ! -f "$RESULT" ]]; then
  echo "✗ 超时：未写出 self-test-result.json" >&2
  echo "--- log ---" >&2
  cat /tmp/codex-pet-self-test.log >&2 || true
  kill "$APP_PID" 2>/dev/null || killall "codex-3d-pet" 2>/dev/null || true
  exit 1
fi

echo "→ 自检结果:"
cat "$RESULT"
echo

OK=$(node -e "const r=require(process.argv[1]); process.exit(r.ok?0:1)" "$RESULT" && echo yes || echo no)

BOUNDS=$(osascript -e 'tell application "System Events" to tell process "codex-3d-pet" to tell window 1 to get {position, size}' 2>/dev/null || true)
if [[ -n "$BOUNDS" ]]; then
  X=$(echo "$BOUNDS" | awk -F',' '{gsub(/ /,"",$1); print $1}')
  Y=$(echo "$BOUNDS" | awk -F',' '{gsub(/ /,"",$2); print $2}')
  W=$(echo "$BOUNDS" | awk -F',' '{gsub(/ /,"",$3); print $3}')
  H=$(echo "$BOUNDS" | awk -F',' '{gsub(/ /,"",$4); print $4}')
  mkdir -p "$ROOT/dist/installers"
  screencapture -x -R${X},${Y},${W},${H} "$SHOT" || true
  echo "→ 截图: $SHOT"
fi

kill "$APP_PID" 2>/dev/null || killall "codex-3d-pet" 2>/dev/null || true

if [[ "$OK" != "yes" ]]; then
  echo "✗ 自检失败：角色仍像白模 / 无贴图" >&2
  exit 1
fi

echo "✓ 打包版导入自检通过（样本 VRM 贴图/材质可用）"
