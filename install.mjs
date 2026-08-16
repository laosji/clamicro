#!/usr/bin/env node
import { createInterface } from 'node:readline/promises'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, CONFIG_FILE } from './src/config.mjs'
import { install, uninstall, SETTINGS_FILE } from './src/settings.mjs'
import { isOurService } from './src/service-id.mjs'
import { fingerprint, isTrusted, trust } from './src/network.mjs'
import { saveConfig } from './src/config.mjs'
import { syncApp, appPaths, APP_DIR } from './src/paths.mjs'
import { hasDsh, installPlugins, patchProfile, removePlugins, PATCH_FILE } from './src/dsh.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLIST_DEST = join(homedir(), 'Library', 'LaunchAgents', 'com.clamicro.plist')

/**
 * 清掉 2.2 及更早版本注册的 LaunchAgent。
 *
 * 开机自启这个功能删掉了——服务跟着 Claude Code 的生命周期走就够了，
 * SessionStart hook 会在它没跑时拉起来。但**已经开过 `autostart on` 的机器上
 * 那个 plist 还在**，光删代码等于留下一个孤儿：每次开机它照样按老路径拉起
 * 一个服务，而新版本对此一无所知。
 *
 * 所以是删文件，不是只 unload——unload 撑不过下次重启。
 * install 和 uninstall 都要调，因为多数人是升级上来的，不会去跑卸载。
 */
function clearLegacyAutostart() {
  if (!existsSync(PLIST_DEST)) return false
  spawnSync('launchctl', ['unload', PLIST_DEST], { stdio: 'ignore' })
  try {
    rmSync(PLIST_DEST)
  } catch {
    /* 删不掉也别拦住安装，顶多是它还在 */
  }
  return true
}
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
async function stopExisting(port) {
  const pids = listening(port)
  if (!pids.length) return 0
  /**
   * 不是我们的就一个都不碰，交给调用方去告诉用户。
   *
   * 这一步在安装流程里尤其要紧：它是**自动**跑的，用户没有机会喊停。
   * 不校验就 kill，等于「装一次 clamicro 顺手杀掉占用 8765 的任何东西」。
   * 判据见 src/service-id.mjs（和 cli.mjs stop 共用同一份）。
   */
  if (!(await isOurService(port, pids))) return { foreign: true, pids }
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

  /**
   * 在一台从没装过的机器上跑卸载，**不该凭空造出配置**。
   *
   * 下面那句 `loadConfig()` 会建 ~/.claude/clamicro 目录、生成一个新 token
   * 并写盘——于是「卸载」的净效果是**多了**一份配置和一把新钥匙。
   * 而这条命令最常见的误用场景恰恰就是「我好像装过？先卸一下试试」。
   *
   * 端口读盘上那份；没有就用默认值，不走 loadConfig 的生成逻辑。
   */
  const uninstallPort = (() => {
    try {
      return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')).port ?? 8765
    } catch {
      return 8765
    }
  })()

  const { removed, backupPath, absent } = uninstall({ statusLinePath: STATUSLINE })
  if (absent) {
    // 说实话：这台机器上就没有 settings.json，所以没什么可摘的，也没动任何东西
    say(`  ${c.dim(`${SETTINGS_FILE} 不存在 —— 没有需要摘除的东西`)}`)
  } else {
    say(`  ${c.g('✓')} 已从 settings.json 摘除：${removed.length ? removed.join('、') : '（无）'}`)
    if (backupPath) say(`  ${c.dim(`备份 ${backupPath}`)}`)
  }

  /**
   * DSH 那边也要摘干净。
   *
   * 这个项目对卸载的承诺是「只摘掉自己加的东西」，那就包括我们写进
   * 别人家配置的部分。留着的后果比留个空目录严重：补丁层里还指着
   * clamicro-dsh-bridge，而插件已经不在了——DSH 下次启动会报一个
   * 找不到模块的错，而用户刚刚才「卸载」完，绝对想不到是这里。
   */
  const dsh = removePlugins()
  if (dsh.removed.length) say(`  ${c.g('✓')} 已从 DSH 摘除：${dsh.removed.join('、')}`)
  if (dsh.patch) say(`  ${c.dim(`已清理 ${dsh.patch}`)}`)

  // 老版本注册过 LaunchAgent，现在这个功能没了，但别人机器上那个 plist 还在，
  // 不清掉它会继续按老路径拉起服务。**删掉**而不是只 unload：留着下次开机又回来。
  clearLegacyAutostart()
  const n = await stopExisting(uninstallPort)
  if (n?.foreign) {
    say(`  ${c.y('⚠')} ${uninstallPort} 端口上有进程（PID ${n.pids.join('、')}），但不是 clamicro —— 没有动它`)
  } else {
    say(`  ${c.g('✓')} 已停止服务${n ? '' : c.dim('（本来就没在跑）')}`)
  }
  // 没有配置文件就别提它 —— 那句话会让人以为卸载留下了东西
  say(existsSync(CONFIG_FILE)
    ? `\n  ${c.dim(`配置与数据仍在 ${CONFIG_FILE}，可手动删除`)}\n`
    : '\n')
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
/**
 * 三种结果要分开说，`backupPath` 为空**不等于**「原文件不存在」。
 *
 * install 现在在内容没变时直接返回（不写盘也不备份，见 settings.mjs 的注释：
 * 自愈每 5 分钟一轮，无条件写盘会让备份文件无限堆积）。原来这里把
 * `backupPath == null` 一律渲染成「原文件不存在」，于是重复安装时会显示
 * 「已写入，备份（原文件不存在）」——两句都是错的：既没写入，文件也在。
 */
say(
  applied.unchanged
    ? `  ${c.g('✓')} hooks 已是最新 ${c.dim('（配置无改动，未写盘）')}`
    : `  ${c.g('✓')} 已写入，备份 ${c.dim(applied.backupPath ?? '（原文件此前不存在）')}`,
)

// 3. 网络信任 —— 不做这步，服务只绑回环，手机连不上，装完等于白装
const net = fingerprint(config.lanIp)
if (config.lanIp && net.id && !isTrusted(config, net)) {
  // label 在拿不到 SSID 时本身就是「网关 X」，再拼一次网关就成了「网关 X  网关 X」。
  // NOTES 里记过同一个 bug 在 `networks` 命令上，这条路径当时漏了。
  const gw = net.gateway && net.label !== `网关 ${net.gateway}` ? c.dim(`  网关 ${net.gateway}`) : ''
  say(`\n  ${c.b('当前网络')} ${net.label}${gw}`)
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

// 升级上来的机器可能还留着老版本的 LaunchAgent，先清掉再启动，
// 否则两个服务会抢同一个端口
if (clearLegacyAutostart()) say(`  ${c.g('✓')} 已移除旧版的开机自启（现在跟随 Claude Code 启动）`)

// 4. 启动服务
//
// 不再注册 LaunchAgent。服务的生命周期跟着 Claude Code 走：SessionStart hook
// 会在服务没跑时把它拉起来，Claude 不开的时候它也不需要在。少一个持久的
// 系统级改动，卸载也少一件要收拾的东西。
{
  /**
   * 端口被别人占着时**不抢**，而且要说出来。
   *
   * 抢了的话表现是「装完好像成功了」，实际杀掉了用户另一个服务，
   * 而我们自己也未必起得来。说清楚让人自己决定换端口还是关掉那个程序。
   */
  const stopped = await stopExisting(config.port)
  if (stopped?.foreign) {
    say(`\n  ${c.y('⚠ 端口被占用')}`)
    say(`  ${config.port} 上有进程在监听（PID ${stopped.pids.join('、')}），但${c.b('不是 clamicro')}，没有动它。`)
    say(c.dim(`  看是谁： lsof -nP -iTCP:${config.port} -sTCP:LISTEN`))
    say(c.dim(`  换个端口： CLAMICRO_PORT=8899 npx clamicro install\n`))
    closePrompt()
    process.exit(1)
  }
  const out = join(homedir(), 'Library', 'Logs', 'clamicro.log')
  // ~/Library/Logs 在正常 macOS 账户上一定存在，但不能拿它当前提：
  // 目录一旦缺失，openSync 抛 ENOENT，安装在最后一步崩掉，
  // 而此时 hooks 已经写进 settings.json 了——半装状态最难收拾
  mkdirSync(dirname(out), { recursive: true })
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

// 6. 入口
/**
 * 终端里给的是**一个网址**，不是二维码。
 *
 * 上一版印的是一次性配对券的二维码。安全上没问题（券 60 秒过期、用一次作废），
 * 但**时序上是坏的**：券在安装那一刻就开始倒数，而人还要读完输出、掏手机、
 * 解锁、打开相机——等镜头对上去，码多半已经死了。然后你会以为是网络问题，
 * 反复重装。
 *
 * 更早那一版印的是 `/ui?t=<主令牌>`，没有有效期所以「能用」，代价是把一张
 * 永久、全权、吊销不掉的凭证放进终端回滚缓冲、屏幕录制和旁人的镜头里。
 *
 * 网址两头都躲开了：**它不含任何凭证，所以不怕被留存；它不会过期，所以什么
 * 时候掏手机都行。** 凭证在手机点了按钮之后才生成，而且只出现在 Mac 屏幕上。
 *
 * 完整链路：手机开网址 → 点「在 Mac 上显示二维码」 → Mac 弹码 → 手机扫 →
 * Mac 弹确认框 → 点允许 → 手机拿到可吊销的设备令牌。
 * 手机那一端全程不持有任何秘密。
 */
say(`\n${c.b('  最后一步：手机打开这个网址')}\n`)

if (config.lanIp) {
  say(`     ${c.b(base)}`)
  // .local 换 Wi-Fi、换 IP 之后依然有效，所以放在前面；但有些 Android 和
  // Windows 解析不了 mDNS，必须同时给出 IP，否则那部分人会直接卡死在这里
  if (config.altUrl) say(`     ${c.dim(`解析不了的话用：${config.altUrl}`)}`)
  say('')
  say(`  ${c.dim('打开后点「在 Mac 上显示二维码」，用手机相机扫 Mac 屏幕上那个码。')}`)
  say(`  ${c.dim('然后 Mac 上会弹确认框 —— 点「允许」才会真的配对。')}`)
} else {
  // 没探测到局域网 IP 时这条路根本不通，别给一个打不开的网址让人白试
  say(`  ${c.y('!')} 没探测到局域网 IP，手机暂时连不上`)
  say(`  ${c.dim('确认 Mac 连着 Wi-Fi 后重跑安装；或在 Mac 上跑：npx clamicro qr')}`)
}
say('')
say(`  ${c.dim('想直接看二维码：npx clamicro qr')}`)
say('')

/**
 * 探测到 DeepSeek Harness 就问一句要不要接上。
 *
 * **必须问**：这会往用户的 `~/.dsh/profiles` 里拷目录、改 cordis.patch.yml。
 * 那是另一个产品的配置，不是我们的地盘，装 clamicro 顺手改掉它不合适。
 *
 * 用 optIn=true，所以 `--yes` 批量确认也不会把它捎带过去——理由同上。
 */
if (hasDsh()) {
  say('')
  say(`  ${c.b('检测到 DeepSeek Harness')} ${c.dim('~/.dsh')}`)
  say(`  ${c.dim('接上之后，DSH 的操作也会走手机审批，首页按模型分开显示。')}`)
  if (await confirm(`  要现在接上吗？${c.dim('（会写 ~/.dsh/profiles）')}`, true)) {
    try {
      const done = installPlugins(APP_DIR)
      const r = patchProfile(config.port ?? 8765)
      if (done.length) say(`  ${c.g('✓')} 插件已装：${done.join('、')}`)
      if (r.action === 'manual') {
        // 认不出那个 YAML 的形状。不猜着改——写坏了 DSH 整个 profile 起不来，
        // 而用户根本不会想到是装 clamicro 弄的。
        say(`  ${c.y('⚠')} ${PATCH_FILE} 的格式不认识，没敢动。请手动把下面几行加进 ${c.b('- insert:')} 下面：`)
        say('')
        for (const line of r.rows) say(`  ${c.dim(line)}`)
        say('')
      } else if (r.action === 'already') {
        say(`  ${c.dim('补丁层里已经有了，没重复写')}`)
      } else {
        say(`  ${c.g('✓')} 补丁层已更新 ${c.dim(PATCH_FILE)}`)
        say(`  ${c.dim('重启 DSH（dsh web）后生效')}`)
      }
    } catch (e) {
      // 接 DSH 失败不该让整个安装失败：Claude Code 那条链路已经装好了
      say(`  ${c.y('⚠ 接 DSH 没成功：')}${e.message}`)
      say(`  ${c.dim('Claude Code 那边不受影响。手动接法见 plugins/README.md')}`)
    }
  } else {
    say(`  ${c.dim('跳过。以后想接：重跑 npx clamicro install')}`)
  }
}

say('')
say(`  配对完点「发一条测试审批」，在手机上批一次 ${c.dim('—— 这就是验收')}`)
say(``)
say(`  ${c.dim('现在已经能用了：需要审批时 Mac 会弹通知并响一声，终端状态栏也会显示待审批数。')}`)
say('')
// 这段必须在装完就说清楚——用户对「审批」的预期在这一刻定型。
// 以为每条都拦、结果普通操作 10 秒自己过了，那是被产品骗了一次。
say(`  ${c.b('默认行为，别搞错：')}`)
say(`  ${c.dim('  · 普通操作等你 10 秒，没人管就')}${c.y('自动通过')}${c.dim('（不然 npm run build 也要等你）')}`)
say(`  ${c.dim('  · 高风险操作（rm -rf、force push、动 ~/.ssh）会一直等，超时')}${c.y('自动拒绝')}`)
say(`  ${c.dim('  也就是说日常操作它是「告诉你」，高危操作它才是「拦住你」。')}`)
say(`  ${c.dim('  想每条都等你：设置页把自动通过关掉，或改成 0 秒。')}`)
say('')
say(`  ${c.dim('人就在电脑前时不必掏手机：')} ${c.b('npx clamicro pending / approve / deny')}`)
say(`  ${c.dim('提醒只有 Mac 本地通知这一条，不联网。离开电脑后不会有东西叫你。')}`)
say('')
say(`  ${c.y('用量数据要新开一个 Claude Code 会话才会出现')}`)
say(`  ${c.dim('statusLine 是会话启动时读取的，现在已开着的会话不会上报——这不是故障。')}`)
say(`\n  ${c.dim('其他命令：npx clamicro help')}\n`)
