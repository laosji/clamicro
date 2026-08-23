#!/bin/bash
# Codex hook 中继：把 Codex 的 hook 事件转成一次本地 HTTP 调用，再把回包原样吐回去。
#
# 为什么要这层脚本——Claude Code 那边是 hook 直接发 HTTP（settings.json 里的
# `type: "http"`），Codex 没有这种 handler，它只认 command / prompt / agent。
# 所以这里补上那一跳：读 stdin 的事件 JSON，POST 到 /hooks/<端点>，把响应打到
# stdout 交还给 Codex。
#
# 三条纪律，坏一条都会造成「看起来正常、其实不对」的故障：
#
#   1. **服务没起来时不表态**。连不上就什么都不输出、退出 0 = 本 hook 无意见，
#      Codex 走它自己的权限流程（终端里问你）。反过来「连不上就拒绝」会让
#      clamicro 一关，Codex 就没法干活了——而用户根本不会把两件事联系起来。
#   2. **拒绝要说两遍**。既输出 JSON，也用退出码 2 再说一次。Codex 的 deny
#      线格式跟 Claude Code 同构但还没在真机上验过（见 docs/codex-bridge.zh-CN.md
#      §4），万一 JSON 那条它没读懂，退出码是第二道闸。方向必须是这一侧：
#      漏掉一次拒绝 = 假审批，是这个产品最不能出的错。
#   3. **除了审批，任何一条都不许把 Codex 拖住**。状态上报统统给短超时，
#      失败就算了，手机上少一行时间线而已。

set -uo pipefail   # 故意不要 -e：中间任何一步失败都必须走到最后的 exit 0

endpoint="${1:-}"
if [ -z "$endpoint" ]; then exit 0; fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${CLAMICRO_PORT:-8765}"
BASE="http://127.0.0.1:${PORT}"
URL="${BASE}/hooks/${endpoint}?agent=codex"

# SessionStart 交给现成的那个脚本：它顺带负责「服务没在跑就拉起来」，
# 那段逻辑（还有换 Wi-Fi 后重绑地址）只该有一份。exec 会把 stdin 一起交过去，
# 所以这一步必须在读 stdin 之前。
if [ "$endpoint" = "session-start" ]; then
  exec "${DIR}/session-start.sh" codex
fi

input=$(cat)

if [ "$endpoint" = "permission-request" ]; then
  # 唯一会挂住的一条。超时给 590s：必须比 clamicro 自己的审批时限（最长 570s）
  # 更长，短了会在用户还盯着手机读命令的时候把请求掐掉，而那条审批还挂着。
  hdr="$(mktemp -t clamicro-hook)"
  body=$(curl -sS -m 590 -D "$hdr" -X POST -H 'Content-Type: application/json' \
    --data-binary "$input" "$URL" 2>/dev/null)
  code=$?
  decision=$(tr -d '\r' < "$hdr" | awk 'tolower($1) == "x-clamicro-decision:" { print tolower($2) }' | tail -1)
  rm -f "$hdr"

  # 连不上 / 超时 / 空回包 —— 不表态，让 Codex 自己问人。见上面第 1 条。
  if [ "$code" -ne 0 ] || [ -z "$body" ]; then exit 0; fi

  printf '%s' "$body"
  [ "$decision" = "deny" ] && exit 2
  exit 0
fi

# 其余都是状态上报（外加 pre-tool-use 的暂停/取消闸门、stop 的消息注入），
# 短超时、失败即弃。回包可能带指令（比如 {"continue": false}），所以照样打出去。
body=$(curl -sS -m 5 -X POST -H 'Content-Type: application/json' \
  --data-binary "$input" "$URL" 2>/dev/null) || exit 0
[ -n "$body" ] && printf '%s' "$body"
exit 0
