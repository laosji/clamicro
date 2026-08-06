#!/usr/bin/env node
import { createInterface } from 'node:readline/promises'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, openSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, CONFIG_FILE } from './lib/config.mjs'
import { install, uninstall, SETTINGS_FILE } from './lib/settings.mjs'
import { fingerprint, isTrusted, trust } from './lib/network.mjs'
import { saveConfig } from './lib/config.mjs'
import { syncApp, appPaths, APP_DIR } from './lib/paths.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLIST_NAME = 'com.clamicro.plist'
const PLIST_DEST = join(homedir(), 'Library', 'LaunchAgents', PLIST_NAME)
// 先占位，install 流程里会先 syncApp() 再取真实路径
let STATUSLINE = appPaths().statusLine
let SESSIONSTART = appPaths().sessionStart

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const YES = has('--yes') || has('-y')

/**
 * 停掉占用端口的旧服务。
 * 不能用 pkill 匹配命令行——`node server.mjs`（相对路径启动）和
 * `node /opt/clamicro/server.mjs` 长得不一样，模式很难同时覆盖。
 * 按端口找监听者才是准的。
 */
function listening(port) {
  const r = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
  return (r.stdout ?? '').trim().split('\n').filter(Boolean)
}

/**
 * 停掉占用端口的旧服务，并等端口真正释放。
 *
 * 不等的话新实例会撞 EADDRINUSE 直接退出，而旧实例还在服务——
 * 表现是「升级完了但跑的还是旧版」，且没有任何报错。踩过。
 */
function stopExisting(port) {
  const pids = listening(port)
  for (const pid of pids) spawnSync('kill', [pid], { stdio: 'ignore' })
  for (let i = 0; i < 30 && listening(port).length; i++) {
    spawnSync('sleep', ['0.1'])
  }
  // 还赖着就强杀
  const stubborn = listening(port)
  for (const pid of stubborn) spawnSync('kill', ['-9', pid], { stdio: 'ignore' })
  if (stubborn.length) spawnSync('sleep', ['0.5'])
  return pids.length
}

const c = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
}
const say = (s = '') => console.log(s)

/**
 * 自己缓冲行队列，而不是用 rl.question()。
 *
 * 管道输入（`printf 'y\nn\n' | node install.mjs`）时 stdin 会立刻 EOF，
 * readline 把所有行一次性发完——第二行在第二次提问注册之前就丢了，
 * 随后 EOF，question() 的 promise 永不 settle，进程挂死。
 * 队列 + close 时回落默认值可以同时覆盖 TTY 和管道。
 */
let rl = null
const queued = []
const waiting = []
let closed = false

function initPrompt() {
  if (rl) return
  rl = createInterface({ input: process.stdin })
  rl.on('line', (line) => (waiting.length ? waiting.shift()(line) : queued.push(line)))
  rl.on('close', () => {
    closed = true
    while (waiting.length) waiting.shift()('') // 没输入了，按默认（是）处理
  })
}

/**
 * @param q      问题
 * @param optIn  true 表示这一项在 --yes 下也**不**自动同意。
 *               注册 LaunchAgent 是持久的系统级改动，不该被一次批量确认捎带过去。
 */
async function confirm(q, optIn = false) {
  if (YES) return !optIn
  initPrompt()
  process.stdout.write(`${q} ${c.dim('[Y/n]')} `)
  const line = queued.length
    ? queued.shift()
    : closed
      ? ''
      : await new Promise((resolve) => waiting.push(resolve))
  if (closed || !process.stdin.isTTY) process.stdout.write(`${line}\n`)
  const a = line.trim().toLowerCase()
  return a === '' || a === 'y' || a === 'yes'
}

const closePrompt = () => {
  rl?.close()
  process.stdin.unref?.()
}

// ---------------- 卸载 ----------------
if (has('--uninstall')) {
  say(c.b('\n  卸载 clamicro\n'))
  const { removed, backupPath } = uninstall({ statusLinePath: STATUSLINE })
  say(`  ${c.g('✓')} 已从 settings.json 摘除：${removed.length ? removed.join('、') : '（无）'}`)
  say(`  ${c.dim(`备份 ${backupPath}`)}`)

  if (existsSync(PLIST_DEST)) {
    spawnSync('launchctl', ['unload', PLIST_DEST], { stdio: 'ignore' })
    say(`  ${c.g('✓')} 已停止开机自启（plist 保留在 ${PLIST_DEST}）`)
  }
  const n = stopExisting(loadConfig().port)
  say(`  ${c.g('✓')} 已停止服务${n ? '' : c.dim('（本来就没在跑）')}`)
  say(`\n  ${c.dim(`配置与数据仍在 ${CONFIG_FILE}，可手动删除`)}\n`)
  process.exit(0)
}

// ---------------- 安装 ----------------
say(c.b('\n  clamicro 安装\n'))

// 0. 把运行时复制到固定位置。
// hooks 写的是绝对路径，而 npx 缓存目录和全局安装路径都会变——
// 指向 npm 包会导致某天路径失效、所有 hook 静默失败。
const synced = syncApp()
;({ statusLine: STATUSLINE, sessionStart: SESSIONSTART } = appPaths())
say(`  ${c.g('✓')} 运行时 v${synced.version} → ${c.dim(APP_DIR)}`)

// 1. 环境检查
const nodeMajor = Number(process.versions.node.split('.')[0])
const curlOk = spawnSync('which', ['curl'], { stdio: 'ignore' }).status === 0
const config = loadConfig()

say(c.b('  环境'))
say(`    Node        ${nodeMajor >= 18 ? c.g('✓') : c.r('✗')} v${process.versions.node}${nodeMajor >= 18 ? '' : c.r('  需要 ≥ 18')}`)
say(`    curl        ${curlOk ? c.g('✓') : c.r('✗')}`)
say(
  `    局域网 IP   ${config.lanIp ? c.g('✓') + ' ' + config.lanIp : c.y('✗ 未探测到')}` +
    (config.lanIp ? '' : c.dim('  手机将无法访问，只能在 Mac 上用')),
)
if (nodeMajor < 18 || !curlOk) {
  say(c.r('\n  环境不满足，已中止。\n'))
  process.exit(1)
}

// 2. settings.json —— 先干跑，让用户看清会改什么
say(`\n  ${c.b('将要修改')} ${c.dim(SETTINGS_FILE)}`)
const preview = install({ port: config.port, statusLinePath: STATUSLINE, sessionStartPath: SESSIONSTART, dryRun: true })
let conflict = false
for (const ch of preview.changes) {
  if (ch.kind === 'conflict') {
    conflict = true
    say(`    ${c.y('!')} ${ch.event}  ${c.y(ch.why)}`)
  } else if (ch.kind === 'skip') {
    say(`    ${c.y('!')} ${ch.event}  ${ch.why}`)
  } else if (ch.kind === 'noop') {
    say(`    ${c.dim('·')} ${ch.event}  ${c.dim('已是最新')}`)
  } else {
    const add = ch.kind === 'add'
    const kept = ch.kept ? c.dim(`（保留你已有的 ${ch.kept} 条）`) : ''
    say(`    ${c.g(add ? '+' : '~')} ${ch.event.padEnd(20)}${add ? '新增' : '更新'} ${kept}`)
  }
}
say(c.dim('\n    你已有的 hook 配置会被完整保留，只追加不替换。会自动备份。'))
if (conflict) say(c.y('    statusLine 已被别的工具占用，额度数据将无法采集。'))

if (!(await confirm('\n  继续？'))) {
  say(c.dim('\n  已取消。\n'))
  closePrompt()
  process.exit(0)
}
const applied = install({ port: config.port, statusLinePath: STATUSLINE, sessionStartPath: SESSIONSTART })
say(`  ${c.g('✓')} 已写入，备份 ${c.dim(applied.backupPath ?? '（原文件不存在）')}`)

// 3. 网络信任 —— 不做这步，服务只绑回环，手机连不上，装完等于白装
const net = fingerprint(config.lanIp)
if (config.lanIp && net.id && !isTrusted(config, net)) {
  say(`\n  ${c.b('当前网络')} ${net.label}${net.gateway ? c.dim(`  网关 ${net.gateway}`) : ''}`)
  say(c.dim('    手机要连上服务，需要把服务暴露到这个局域网。'))
  say(c.dim('    局域网内是明文传输，所以只在你信任的网络（家里、自己的热点）上开。'))
  say(c.dim('    陌生网络下服务会自动只绑本机，等你再次确认。'))
  if (await confirm('\n  信任当前网络？')) {
    trust(config, net)
    saveConfig(config)
    say(`  ${c.g('✓')} 已信任「${net.label}」`)
  } else {
    say(`  ${c.y('!')} 未信任 —— 服务只绑本机，手机暂时连不上`)
    say(c.dim('    以后可执行： npx clamicro trust'))
  }
}

// 4. 开机自启
if (await confirm('\n  开机自动启动服务？', true)) {
  writeFileSync(
    PLIST_DEST,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.clamicro</string>
  <key>ProgramArguments</key>
  <array><string>${process.execPath}</string><string>${appPaths().server}</string></array>
  <key>WorkingDirectory</key><string>${APP_DIR}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${join(homedir(), 'Library', 'Logs', 'clamicro.log')}</string>
  <key>StandardErrorPath</key><string>${join(homedir(), 'Library', 'Logs', 'clamicro.err.log')}</string>
</dict>
</plist>
`,
  )
  spawnSync('launchctl', ['unload', PLIST_DEST], { stdio: 'ignore' })
  const r = spawnSync('launchctl', ['load', PLIST_DEST], { stdio: 'ignore' })
  say(
    r.status === 0
      ? `  ${c.g('✓')} 已注册开机自启`
      : `  ${c.y('!')} 注册失败，可稍后手动执行 launchctl load ${PLIST_DEST}`,
  )
} else {
  stopExisting(config.port)
  const out = join(homedir(), 'Library', 'Logs', 'clamicro.log')
  const fd = openSync(out, 'a')
  const child = spawn(process.execPath, [appPaths().server], {
    detached: true,
    stdio: ['ignore', fd, fd],
  })
  child.unref()
  say(`  ${c.g('✓')} 服务已在后台启动 ${c.dim(`（日志 ${out}）`)}`)
}

closePrompt() // 提问结束，释放 stdin，否则进程挂着不退

// 5. 等服务起来
// 用 config.baseUrl —— 必须和服务端发深链用的地址一致，
// 否则扫码进的是一个地址、通知点开的是另一个，cookie 还得再存一遍
const base = config.baseUrl
let up = false
for (let i = 0; i < 25; i++) {
  try {
    const r = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(500) })
    if (r.ok) { up = true; break }
  } catch { /* 还没起来 */ }
  await new Promise((r) => setTimeout(r, 200))
}
if (up) {
  say(`  ${c.g('✓')} 服务已就绪 ${c.dim(base)}`)
} else {
  // 区分「没起来」和「起来了但没绑局域网」，否则用户不知道该查什么
  let local = false
  try {
    local = (await fetch(`http://127.0.0.1:${config.port}/healthz`, { signal: AbortSignal.timeout(800) })).ok
  } catch { /* 确实没起来 */ }
  say(
    local
      ? `  ${c.y('!')} 服务在跑，但没有暴露到局域网 —— 当前网络未被信任，手机连不上`
      : `  ${c.r('✗')} 服务未能启动，看日志 ${join(homedir(), 'Library', 'Logs', 'clamicro.log')}`,
  )
}

// 6. 二维码
say(`\n${c.b('  最后一步：手机扫码')}\n`)
const loginUrl = `${base}/ui?t=${config.token}`
const qr = spawnSync('qrencode', ['-t', 'ANSIUTF8', '-m', '2', loginUrl], { encoding: 'utf8' })
if (qr.stdout) say(qr.stdout)
else say(c.dim('  （装 qrencode 可直接扫码：brew install qrencode）'))
say(`  ${c.dim(loginUrl)}`)
if (config.altUrl) {
  say(`  ${c.dim(`打不开的话用备用地址：${config.altUrl}/ui?t=${config.token}`)}`)
}
say('')

say(`  扫码后点「发一条测试审批」，在手机上批一次 ${c.dim('—— 这就是验收')}`)
say(``)
say(`  ${c.dim('现在已经能用了：需要审批时 Mac 会弹通知并响一声，终端状态栏也会显示待审批数。')}`)
say(`  ${c.dim('只有当你想「人不在电脑边也能被叫醒」时，才需要在设置页填 Bark key。')}`)
say(`\n  ${c.dim('其他命令：npx clamicro help')}\n`)
