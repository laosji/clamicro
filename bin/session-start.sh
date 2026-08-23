#!/bin/bash
# SessionStart hook：确保 clamicro 服务在跑**且绑的是当前网络地址**，然后转发事件。
#
# 这样「打开 Claude Code」就等于「服务可用」，不需要单独记得启动它，
# 也不需要非得装 LaunchAgent。服务已在跑时这里只多一次本地 healthz，约 5ms。
#
# 为什么还要看 stale：
#   监听套接字绑在进程启动那一刻的局域网 IP 上。DHCP 续租、换 Wi-Fi 之后，
#   那个地址就不属于本机了——服务进程还活着、healthz 也照常回 ok，但手机
#   连过来是超时。终端里一片安静，没有任何信号指向问题所在。
#   服务本来就跟着 Claude Code 的生命周期走，所以就在这里跟：地址过期了
#   就重启一次，顺带让网络信任闸门也重新判一遍当前网络。

set -euo pipefail
input=$(cat)

# 可选的第一个参数是后端名（Codex 的中继会传 codex 进来）。不传就是 Claude Code，
# 也就是这个脚本原来的唯一用法——服务端对没写 agent 的上报落回 claude-code。
AGENT="${1:-}"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${CLAMICRO_PORT:-8765}"
BASE="http://127.0.0.1:${PORT}"
LOG="$HOME/Library/Logs/clamicro.log"
NODE="$(command -v node || echo /usr/local/bin/node)"

health() { curl -s -m 1 "${BASE}/healthz" 2>/dev/null; }
alive() { curl -s -m 1 -o /dev/null "${BASE}/healthz" 2>/dev/null; }

start() {
  nohup "$NODE" "${DIR}/server.mjs" >>"$LOG" 2>&1 &
  disown 2>/dev/null || true
  # 最多等 3 秒。等不到就放弃，绝不能拖住会话启动。
  for _ in $(seq 1 30); do
    alive && break
    sleep 0.1
  done
}

if ! alive; then
  start
elif health | grep -q '"stale":true'; then
  # 绑的地址已经不属于本机了。杀掉重启，让它绑到当前地址。
  echo "[clamicro] 局域网地址已变，重启服务以绑定新地址" >>"$LOG"
  lsof -ti "tcp:${PORT}" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
  for _ in $(seq 1 20); do
    alive || break
    sleep 0.1
  done
  start
fi

URL="${BASE}/hooks/session-start"
[ -n "$AGENT" ] && URL="${URL}?agent=${AGENT}"

curl -s -m 2 -X POST -H 'Content-Type: application/json' \
  --data-binary "$input" "$URL" >/dev/null 2>&1 || true

exit 0
