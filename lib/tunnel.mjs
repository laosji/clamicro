import { spawn, spawnSync } from 'node:child_process'
import { openSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_DIR } from './config.mjs'

const LOG = join(homedir(), 'Library', 'Logs', 'clamicro-tunnel.log')
const PID_FILE = join(CONFIG_DIR, 'tunnel.pid')

/**
 * Cloudflare Quick Tunnel。
 *
 * 存在的理由：有些网络（公司、酒店、访客 Wi-Fi）开启了客户端隔离——
 * 同一网段的设备在链路层就被禁止互相通信，ARP 都解析不到。
 * 那种网络上局域网直连**根本不可能**工作，与配置无关。
 *
 * 隧道是唯一不需要在手机上装任何东西的出路：Mac 上一条命令，
 * 手机直接开 https 地址，不限网络。代价是 Cloudflare 终结 TLS，
 * 技术上看得到内容——所以它是可选项，不是默认。
 *
 * 注意 quick tunnel 的地址是临时的，每次重启都会变，得重新扫码。
 */
export function hasCloudflared() {
  return spawnSync('which', ['cloudflared'], { stdio: 'ignore' }).status === 0
}

export function tunnelPid() {
  if (!existsSync(PID_FILE)) return null
  const pid = Number(readFileSync(PID_FILE, 'utf8').trim())
  if (!pid) return null
  // 进程还活着吗
  try {
    process.kill(pid, 0)
    return pid
  } catch {
    unlinkSync(PID_FILE)
    return null
  }
}

export function stopTunnel() {
  const pid = tunnelPid()
  if (!pid) return false
  try {
    process.kill(pid)
  } catch {
    /* 已经没了 */
  }
  try {
    unlinkSync(PID_FILE)
  } catch {
    /* 无所谓 */
  }
  return true
}

/** 启动隧道并等它吐出地址。超时返回 null。 */
export async function startTunnel(port, timeoutMs = 30_000) {
  stopTunnel()
  writeFileSync(LOG, '')
  const fd = openSync(LOG, 'a')
  const child = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], {
    detached: true,
    stdio: ['ignore', fd, fd],
  })
  child.unref()
  writeFileSync(PID_FILE, String(child.pid))

  // cloudflared 把地址打在日志里，轮询等它出现
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500))
    let text = ''
    try {
      text = readFileSync(LOG, 'utf8')
    } catch {
      continue
    }
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(text)
    if (m) return { url: m[0], pid: child.pid }
    if (/failed to (create|connect)/i.test(text)) break
  }
  stopTunnel()
  return null
}

export const TUNNEL_LOG = LOG
