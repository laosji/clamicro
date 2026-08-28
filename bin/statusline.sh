#!/bin/bash
# clamicro statusLine 中继。
#
# 每次响应更新都会跑，所以必须极快（~10ms）。这里不解析 JSON——
# 直接把原始载荷 POST 给本地服务，服务端渲染好状态栏文本回来，
# curl 的输出就是状态栏内容。因此不依赖 jq，也不需要 Node 启动。
#
# 服务没起时 curl 失败、输出为空，走后面的兜底文案，绝不阻塞终端。

# 宿主进程 PID。SessionStart 也带（bin/session-start.sh），但那个**一个会话
# 只发一次**——服务一旦重启就再也收不到，于是它对「谁在用」一无所知，而
# lifecycle 那边曾经把「一无所知」当成「没人用」直接关掉自己。
#
# statusLine 在 Claude Code 渲染状态栏时跑，所以它是重启之后重新认识宿主的
# 第二条路（SessionStart 一个会话只发一次，重启前发过的不会再发）。
#
# **不是保证。** 某些环境下 Claude Code 压根不渲染状态栏，这条就不会跑——
# 那时重启前开着的会话，宿主补不上，auto-exit 要等下一个新会话。
# 失败方向是「多跑一会儿」，可以接受，见 src/lifecycle.mjs。
#
# 猜错了也不伤：多出来的 pid 只会让服务**多跑一会儿**，不会让它提前关。
cat | curl -s -m 1 -X POST \
  -H 'Content-Type: application/json' \
  --data-binary @- \
  "http://127.0.0.1:${CLAMICRO_PORT:-8765}/statusline?render=1&owner=${PPID}" \
  || printf 'Clamicro 未运行'
