/**
 * 提醒通道。**只负责把你叫过来，不承载任何决策。**
 *
 * 现在只剩 macOS 本地通知，完全不联网。
 *
 * ## 为什么把远程推送删掉了
 *
 * 曾经有两条：ntfy 双 topic 中转（能在锁屏通知里直接批准），后来换成 Bark
 * （只发通知，点开跳局域网页面）。两条都删了，理由是同一个——
 *
 * 锁屏可达必须走 APNs，这一步没法只用 Wi-Fi。于是不管做得多克制，
 * 「有个操作在等你审批」这件事本身总要经过第三方服务器，而它换来的
 * 只是「人不在电脑边时能被叫一下」。这个产品的前提是**近场**：
 * 人在电脑边，Mac 出声就够了；人不在电脑边，收到提醒也走不完
 * 「掏手机、解锁、连上同一个 Wi-Fi、打开页面」这一串。
 *
 * 代价要说清楚：**离开电脑后没有任何东西会提醒你**。高风险操作会一直等到
 * 超时（默认 570 秒）然后被自动拒绝，那一轮任务因此失败。这是有意的默认——
 * 「人不在就不该放行 rm -rf」。想主动看的话，手机浏览器随时能打开看板。
 */

/** 本地通知。osascript 的字符串要转义引号和反斜杠，否则命令会被截断。 */
async function notifyMac(msg) {
  const { spawn } = await import('node:child_process')
  const esc = (s) => String(s ?? '').replace(/["\\]/g, '\\$&').slice(0, 200)
  const script = `display notification "${esc(msg.body)}" with title "${esc(msg.title)}" sound name "Ping"`
  await new Promise((resolve) => {
    const p = spawn('osascript', ['-e', script], { stdio: 'ignore' })
    p.on('close', resolve)
    p.on('error', resolve)
  })
}

export function makeNotifier(config) {
  return async function notify(msg) {
    if (!config.notify.macNotify) return
    try {
      await notifyMac(msg)
      console.log(`[notify] ${msg.title}`)
    } catch (err) {
      // 提醒失败绝不能影响 hook 链路——工具调用还等着这个请求返回
      console.error(`[notify] 失败: ${err.message}`)
    }
  }
}
