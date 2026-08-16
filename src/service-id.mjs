import { spawnSync } from 'node:child_process'

/**
 * 端口上监听的那个进程，是不是我们自己的服务。
 *
 * ## 为什么需要
 *
 * `stop` 和安装流程都会 kill 掉端口上的监听者。原来拿到 PID 就直接杀，
 * 不校验身份——可 8765 不是保留端口。被别的程序占着的话，
 * `npx clamicro stop` 会**杀掉一个无辜进程**，还照样打印「✓ 已停止」。
 * 安装流程更糟：它是自动跑的，用户没有机会喊停。
 *
 * ## 两条判据，任一成立即认
 *
 * 1. `/healthz` 回 `service: 'clamicro'` —— 服务自己签的名，最可靠。
 *    这个字段只对回环返回（见 server.mjs），局域网上的扫描者拿不到。
 *
 * 2. `/healthz` 有 `stale` 这个布尔字段，**且**该 PID 的命令行看着像我们的
 *    server.mjs —— 这条是给**升级**留的：旧版本的服务没有 `service` 字段，
 *    只认第 1 条的话，新版 CLI 会判定「这不是 clamicro」，于是
 *    **新版停不掉旧版**，升级当场卡死。这不是假想，是实测撞到的。
 *
 * 命令行只用来**验证一个已知 PID**，不用来查找进程——查找靠端口。
 * （`node server.mjs` 和 `node /opt/clamicro/server.mjs` 形状不一样，
 * 拿命令行去搜是不可靠的；但拿来确认「这个特定 PID 长得像不像我们的」够用。）
 *
 * 拿不准一律返回 false：**宁可不杀，也不杀错**。代价只是让用户自己处理，
 * 而杀错的代价是别人的进程没了，且他不会知道是我们干的。
 */
export async function isOurService(port, pids = []) {
  let health
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) })
    if (!r.ok) return false
    health = await r.json()
  } catch {
    // 根本不响应 HTTP —— 那就更不该是我们的服务
    return false
  }

  if (health?.service === 'clamicro') return true

  // 旧版本兼容：没有 service 字段，但 healthz 的形状对得上
  if (typeof health?.stale !== 'boolean') return false
  return pids.some((pid) => looksLikeOurServer(pid))
}

/**
 * 读一个 PID 的命令行。进程不在或读不到就返回空串。
 *
 * **PID 本身从来不足以标识一个进程。** 系统会回收 PID：一个进程死掉之后，
 * 它的号可以被分配给完全无关的新进程。所以任何「我记下了 PID，之后拿它
 * 做事」的地方，动手前都要再确认一次这个号现在归谁。
 *
 * 这个项目里有两处踩这条：服务的 stop（见上），以及隧道的 tunnelAlive /
 * stopTunnel（见 config.mjs）。共用这一个读取口，判据各自定。
 */
export function commandOf(pid) {
  return spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout ?? ''
}

/** 这个 PID 的命令行像不像我们的 server.mjs */
function looksLikeOurServer(pid) {
  const out = commandOf(pid)
  // 两个条件都要：光有 server.mjs 太泛（谁都能有这个文件名），
  // 光有 clamicro 也不够（可能是别的相关工具）
  return /server\.mjs/.test(out) && /clamicro|cc-monitor/.test(out)
}
