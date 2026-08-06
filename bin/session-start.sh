#!/bin/bash
# SessionStart hook：确保 clamicro 服务在跑，然后转发事件。
#
# 这样「打开 Claude Code」就等于「服务可用」，不需要单独记得启动它，
# 也不需要非得装 LaunchAgent。服务已在跑时这里只多一次本地 healthz，
# 约 5ms。

set -euo pipefail
input=$(cat)

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${CLAMICRO_PORT:-8765}"
BASE="http://127.0.0.1:${PORT}"
LOG="$HOME/Library/Logs/clamicro.log"

alive() { curl -s -m 1 -o /dev/null "${BASE}/healthz"; }

if ! alive; then
  NODE="$(command -v node || echo /usr/local/bin/node)"
  nohup "$NODE" "${DIR}/server.mjs" >>"$LOG" 2>&1 &
  disown 2>/dev/null || true
  # 最多等 3 秒。等不到就放弃，绝不能拖住会话启动。
  for _ in $(seq 1 30); do
    alive && break
    sleep 0.1
  done
fi

curl -s -m 2 -X POST -H 'Content-Type: application/json' \
  --data-binary "$input" "${BASE}/hooks/session-start" >/dev/null 2>&1 || true

exit 0
