// 附加通知通道。主通道是 lib/relay.mjs 的 ntfy 双 topic 中转（带通知内按钮）。
// Bark 没有通知内按钮，点开只能跳详情页，因此它需要 publicBaseUrl 可达才有完整用处。

async function pushBark(cfg, msg) {
  if (!cfg.key) throw new Error('未配置 push.bark.key')
  const res = await fetch(`${cfg.server}/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device_key: cfg.key,
      title: msg.title,
      body: msg.body,
      url: msg.url,
      group: msg.group,
      level: msg.level, // active | timeSensitive | critical
      isArchive: 1,
    }),
    signal: AbortSignal.timeout(8000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Bark HTTP ${res.status}: ${text.slice(0, 200)}`)
  return text.slice(0, 200)
}

/**
 * macOS 本地通知。完全不联网——「近场」场景下人就在电脑边，
 * 由 Mac 自己出声提醒，不需要任何公网链路。
 */
async function pushMac(msg) {
  const { spawn } = await import('node:child_process')
  const esc = (s) => String(s ?? '').replace(/["\\]/g, '\\$&').slice(0, 200)
  const script = `display notification "${esc(msg.body)}" with title "${esc(msg.title)}" sound name "Ping"`
  await new Promise((resolve) => {
    const p = spawn('osascript', ['-e', script], { stdio: 'ignore' })
    p.on('close', resolve)
    p.on('error', resolve)
  })
}

export function makePusher(config) {
  return async function push(msg) {
    // 本地通知与远程推送互不排斥，可以同时开
    if (config.push.macNotify) {
      try {
        await pushMac(msg)
        console.log(`[push:mac] ${msg.title}`)
      } catch (err) {
        console.error(`[push:mac] 失败: ${err.message}`)
      }
    }
    const provider = config.push.provider
    if (provider === 'none') return
    try {
      if (provider !== 'bark') throw new Error(`未知 push.provider: ${provider}`)
      console.log(`[push:bark] ${msg.title} → ${await pushBark(config.push.bark, msg)}`)
    } catch (err) {
      // 推送失败绝不能影响 hook 链路
      console.error(`[push:${provider}] 失败: ${err.message}`)
    }
  }
}
