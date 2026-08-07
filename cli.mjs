#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, openSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { APP_DIR, appPaths, installedInfo } from './lib/paths.mjs'

const [cmd, ...rest] = process.argv.slice(2)
const LOG = join(homedir(), 'Library', 'Logs', 'clamicro.log')

const c = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
}

function usage() {
  console.log(`
  ${c.b('Clamicro')} ${c.dim('— 在手机上看 Claude Code 的状态、审批它要执行的操作')}

  ${c.b('install')}      安装：接入 hooks、信任网络、启动服务、打印二维码
  ${c.b('uninstall')}    卸载：只摘掉自己加的东西，配置保留
  ${c.b('qr')}           打印登录二维码（换手机 / 重新登录时用）
  ${c.b('status')}       服务、网络、待审批的当前状态
  ${c.b('start')}        前台启动服务（调试用；平时由 SessionStart hook 自动拉起）
  ${c.b('stop')}         停止服务
  ${c.b('autostart')}    开机自启：${c.dim('autostart on | off | status')}
  ${c.b('tunnel')}       公网隧道：${c.dim('tunnel on | off | status')}${c.dim('  ← 网络禁止设备互通时用')}
  ${c.b('trust')}        信任当前网络（陌生网络下服务只绑本机）
  ${c.b('networks')}     当前网络 + 已信任列表
  ${c.b('test-push')}    发一条测试通知
  ${c.b('logs')}         跟踪日志

  ${c.dim(`运行时装在 ${APP_DIR}`)}
`)
}

/** 除 install 外的命令都跑已安装的那份，而不是 npm 包里的副本 */
function runApp(args, opts = {}) {
  const { server } = appPaths()
  if (!existsSync(server)) {
    console.error(c.r('\n  还没安装。先执行： npx clamicro install\n'))
    process.exit(1)
  }
  const r = spawnSync(process.execPath, [server, ...args], { stdio: 'inherit', ...opts })
  process.exit(r.status ?? 0)
}

async function port() {
  const { loadConfig } = await import(`file://${join(APP_DIR, 'lib', 'config.mjs')}`)
  return loadConfig().port
}

function listeners(p) {
  const r = spawnSync('lsof', ['-ti', `tcp:${p}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
  return (r.stdout ?? '').trim().split('\n').filter(Boolean)
}

switch (cmd) {
  case 'install':
  case undefined:
    // 安装器跑的是 npm 包里的那份，它负责把运行时复制到 APP_DIR
    process.argv = [process.argv[0], 'install.mjs', ...rest]
    await import('./install.mjs')
    break

  case 'uninstall': {
    process.argv = [process.argv[0], 'install.mjs', '--uninstall', ...rest]
    await import('./install.mjs')
    break
  }

  case 'qr':
    runApp(['--qr'])
    break
  case 'trust':
    runApp(['--trust'])
    break
  case 'networks':
    runApp(['--networks'])
    break
  case 'test-push':
    runApp(['--test-push'])
    break

  case 'start': {
    const { server } = appPaths()
    spawnSync(process.execPath, [server], { stdio: 'inherit' })
    break
  }

  case 'stop': {
    const p = await port()
    const pids = listeners(p)
    for (const pid of pids) spawnSync('kill', [pid])
    console.log(pids.length ? c.g(`  ✓ 已停止（${pids.length} 个进程）`) : c.dim('  服务本来就没在跑'))
    break
  }

  case 'status': {
    const info = installedInfo()
    const p = await port()
    console.log(`\n  版本      ${info?.version ?? c.y('未安装')}`)
    console.log(`  运行时    ${c.dim(APP_DIR)}`)
    const alive = listeners(p).length > 0
    console.log(`  服务      ${alive ? c.g('运行中') : c.y('未运行')} ${c.dim(`:${p}`)}`)
    if (alive) {
      // 用量为空时区分两种情况，并且只在终端里催——「新开会话」这个动作
      // 只能在终端做，在手机上看到这句话是干着急
      try {
        const { loadConfig } = await import(`file://${join(APP_DIR, 'lib', 'config.mjs')}`)
        const token = loadConfig().token
        const r = await fetch(`http://127.0.0.1:${p}/api/sessions`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(1500),
        })
        const d = await r.json()
        if (d.limits) {
          const age = Math.round((Date.now() - d.limits.at) / 60000)
          console.log(
            `  用量      5h ${Math.round(d.limits.five_hour.pct)}%  ·  7d ${Math.round(d.limits.seven_day.pct)}%` +
              c.dim(`  (${age} 分钟前)`),
          )
        } else if (!d.statusLineSeenAt) {
          console.log(`  用量      ${c.y('无数据')}`)
          console.log(c.dim('            statusLine 是会话启动时读取的，已开着的会话不会上报。'))
          console.log(c.dim('            新开一个 Claude Code 会话即可。'))
        } else {
          console.log(`  用量      ${c.y('上报中但无额度字段')}`)
        }
      } catch {
        console.log(c.y('  端口被占用但没响应，可能是别的程序'))
      }
      runApp(['--networks'])
    }
    console.log()
    break
  }

  case 'autostart': {
    const { writeFileSync, rmSync } = await import('node:fs')
    const PLIST = join(homedir(), 'Library', 'LaunchAgents', 'com.clamicro.plist')
    const sub = rest[0] ?? 'status'
    const loaded = () =>
      (spawnSync('launchctl', ['list'], { encoding: 'utf8' }).stdout ?? '').includes('com.clamicro')

    if (sub === 'off') {
      spawnSync('launchctl', ['unload', PLIST], { stdio: 'ignore' })
      try { rmSync(PLIST) } catch { /* 本来就没有 */ }
      console.log(c.g('\n  ✓ 已关闭开机自启'))
      console.log(c.dim('  服务仍会在你打开 Claude Code 时由 SessionStart hook 拉起\n'))
    } else if (sub === 'on') {
      const { server } = appPaths()
      if (!existsSync(server)) {
        console.error(c.r('\n  还没安装。先执行： npx clamicro install\n'))
        process.exit(1)
      }
      writeFileSync(
        PLIST,
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.clamicro</string>
  <key>ProgramArguments</key>
  <array><string>${process.execPath}</string><string>${server}</string></array>
  <key>WorkingDirectory</key><string>${APP_DIR}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${join(homedir(), 'Library', 'Logs', 'clamicro.err.log')}</string>
</dict>
</plist>
`,
      )
      spawnSync('launchctl', ['unload', PLIST], { stdio: 'ignore' })
      const r = spawnSync('launchctl', ['load', PLIST], { stdio: 'ignore' })
      console.log(
        r.status === 0
          ? c.g('\n  ✓ 已开启开机自启（崩溃也会自动重启）\n')
          : c.y(`\n  ! 注册失败，可手动执行： launchctl load ${PLIST}\n`),
      )
    } else {
      console.log(`\n  开机自启  ${loaded() ? c.g('已开启') : c.y('未开启')}`)
      console.log(c.dim(`  ${PLIST}`))
      console.log(c.dim('  用 npx clamicro autostart on|off 切换\n'))
    }
    break
  }

  case 'tunnel': {
    const { hasCloudflared, startTunnel, stopTunnel, tunnelPid, TUNNEL_LOG } = await import(
      `file://${join(APP_DIR, 'lib', 'tunnel.mjs')}`
    )
    const { loadConfig, saveConfig } = await import(`file://${join(APP_DIR, 'lib', 'config.mjs')}`)
    const sub = rest[0] ?? 'on'

    if (sub === 'status') {
      const pid = tunnelPid()
      const cfg = loadConfig()
      console.log(`\n  隧道      ${pid ? c.g('运行中') + c.dim(` pid ${pid}`) : c.y('未运行')}`)
      if (cfg.publicBaseUrl && !pid) {
        // 配置里留着地址但进程没了 —— 这个地址已经作废，别让它看起来还能用
        console.log(`  公网地址  ${c.y('已失效')} ${c.dim(cfg.publicBaseUrl)}`)
        console.log(c.dim('            地址随隧道进程消失，服务已自动回落到局域网。'))
        console.log(c.dim('            需要的话重新开： npx clamicro tunnel on'))
      } else {
        console.log(`  公网地址  ${cfg.publicBaseUrl ?? c.dim('无')}`)
      }
      console.log(c.dim(`  日志      ${TUNNEL_LOG}\n`))
      break
    }

    if (sub === 'off') {
      const was = stopTunnel()
      const cfg = loadConfig()
      cfg.publicBaseUrl = null
      saveConfig(cfg)
      console.log(was ? c.g('\n  ✓ 隧道已关闭，地址退回局域网') : c.dim('\n  隧道本来就没开'))
      console.log(c.dim('  重启服务生效： npx clamicro stop && 打开一个 Claude Code 会话\n'))
      break
    }

    if (!hasCloudflared()) {
      console.log(c.y('\n  需要先装 cloudflared：'))
      console.log('    brew install cloudflared')
      console.log(c.dim('\n  它是 Cloudflare 官方工具，约 40MB，一次性安装。\n'))
      process.exit(1)
    }

    const cfg = loadConfig()
    console.log(c.dim('\n  正在建立隧道…'))
    const t = await startTunnel(cfg.port)
    if (!t) {
      console.error(c.r(`\n  隧道建立失败，看日志： ${TUNNEL_LOG}\n`))
      process.exit(1)
    }
    cfg.publicBaseUrl = t.url
    saveConfig(cfg)
    console.log(`  ${c.g('✓')} ${t.url}`)
    console.log(c.dim(`    pid ${t.pid}`))
    console.log(c.y('\n  ⚠️ Cloudflare 会终结 TLS —— 技术上看得到你的命令内容。'))
    console.log(c.dim('     只在局域网直连不可用时使用（比如网络禁止设备互通）。'))
    console.log(c.dim('     地址是临时的，隧道重启后会变，需要重新扫码。'))
    console.log(c.dim('\n  现在重启服务让它认这个地址，然后 npx clamicro qr\n'))
    break
  }

  case 'logs':
    spawnSync('tail', ['-f', LOG], { stdio: 'inherit' })
    break

  case 'help':
  case '--help':
  case '-h':
    usage()
    break

  default:
    console.error(c.r(`\n  未知命令：${cmd}`))
    usage()
    process.exit(1)
}
