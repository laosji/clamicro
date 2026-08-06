#!/bin/bash
# clamicro statusLine 中继。
#
# 每次响应更新都会跑，所以必须极快（~10ms）。这里不解析 JSON——
# 直接把原始载荷 POST 给本地服务，服务端渲染好状态栏文本回来，
# curl 的输出就是状态栏内容。因此不依赖 jq，也不需要 Node 启动。
#
# 服务没起时 curl 失败、输出为空，走后面的兜底文案，绝不阻塞终端。

cat | curl -s -m 1 -X POST \
  -H 'Content-Type: application/json' \
  --data-binary @- \
  "http://127.0.0.1:${CLAMICRO_PORT:-8765}/statusline?render=1" \
  || printf 'Clamicro 未运行'
