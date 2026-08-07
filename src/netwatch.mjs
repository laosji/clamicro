import { spawn } from 'node:child_process'

/**
 * 网络变化监听。
 *
 * ## 为什么不是轮询
 *
 * 服务的生命周期跟着 Claude Code 走（SessionStart hook 拉起、地址过期时重启），
 * 再加一条定时心跳等于第二套状态机。这里用的是 `route -n monitor`：
 * 内核的路由套接字，网络起落、默认路由变更时它才吐字节，平时一动不动。
 * 是操作系统来通知我们，不是我们去问它。
 *
 * 试过 `scutil -w State:/Network/Global/IPv4`，不行——它等的是 key **出现**，
 * 而这个 key 一直存在，所以立刻返回 0。名字里的 wait 容易误导。
 *
 * ## 它补的是哪个洞
 *
 * 网络信任闸门原先只在进程启动时判一次。笔记本从家里带到咖啡厅、中途不重启
 * 服务的话，局域网监听会一直开着——而闸门的全部意义就是「陌生网络上别开」。
 *
 * 多数情况下换网络会同时换 IP，旧套接字绑的地址不再属于本机，暴露面自然
 * 消失。但**换到一个不同的网络却恰好拿到相同的 IP**（192.168.1.x 到处都是）
 * 时，套接字依旧有效，人就真的暴露在陌生网络上了。窄，但不是零。
 *
 * ## 抖动
 *
 * 一次 Wi-Fi 切换会在几百毫秒内产生一串路由事件。全部处理会重复判定、
 * 重复推送。所以合并成一次，且延后一点等网络稳定下来——刚切换时
 * `route get default` 拿到的可能还是旧网关。
 */
const SETTLE_MS = 2500

export function watchNetwork(onChange) {
  let child = null
  let timer = null
  let stopped = false

  const fire = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      try {
        onChange()
      } catch (err) {
        console.error(`[netwatch] 处理网络变化时出错: ${err.message}`)
      }
    }, SETTLE_MS)
    timer.unref?.()
  }

  const start = () => {
    if (stopped) return
    try {
      child = spawn('route', ['-n', 'monitor'], { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch (err) {
      console.warn(`[netwatch] 无法监听网络变化（${err.message}），换网络时需手动重启服务`)
      return
    }
    child.stdout.on('data', fire)
    child.on('error', (err) => {
      console.warn(`[netwatch] 监听中断: ${err.message}`)
    })
    child.on('exit', () => {
      child = null
      // route monitor 正常情况下不该退出。真退了就隔一会重来，
      // 但别原地重启形成忙循环。
      if (!stopped) setTimeout(start, 5_000).unref?.()
    })
    child.unref?.()
  }

  start()

  return () => {
    stopped = true
    clearTimeout(timer)
    child?.kill()
    child = null
  }
}
