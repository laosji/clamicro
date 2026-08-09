#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, openSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { APP_DIR, appPaths, installedInfo } from './src/paths.mjs'
import { isNewer, checkUpdate } from './src/update.mjs'

// npm 包自己的版本（不是已安装运行时的版本，两者可能不一样——这正是要提示的）
const PKG_VERSION = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).version

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
  ${c.b('tunnel')}       公网隧道：${c.dim('tunnel on | off | status')}${c.dim('  ← 网络禁止设备互通时用')}
  ${c.b('trust')}        信任当前网络（陌生网络下服务只绑本机）
  ${c.b('untrust')}      撤销信任：${c.dim('untrust [id前缀 | all]')}${c.dim('  ← 不带参数则撤当前网络')}
  ${c.b('networks')}     当前网络 + 已信任列表
  ${c.b('devices')}      已配对的手机列表
  ${c.b('forget')}       吊销某台设备：${c.dim('forget <id> | forget all')}
  ${c.b('rotate-token')} 换发主令牌${c.dim('  ← 只影响 CLI 和二维码，已配对设备不受影响')}
  ${c.b('pending')}      列出待审批
  ${c.b('approve')}      在终端批准：${c.dim('approve [id前缀]')}${c.dim('  ← 高危必须写 id')}
  ${c.b('deny')}         在终端拒绝：${c.dim('deny [id前缀]')}
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

/**
 * 从**已安装的那份**加载模块。
 *
 * 未安装时让 import 自己抛 ERR_MODULE_NOT_FOUND 是最差的第一印象：
 * 新用户 `npm i -g clamicro` 之后随手敲一句 `clamicro status`，
 * 迎面十行 node 内部堆栈。runApp 早就给了人话提示，这条路径漏了。
 */
async function appImport(rel) {
  const f = join(APP_DIR, 'src', rel)
  if (!existsSync(f)) {
    console.error(c.r('\n  还没安装。先执行： npx clamicro install\n'))
    process.exit(1)
  }
  return import(`file://${f}`)
}

async function port() {
  const { loadConfig } = await appImport('config.mjs')
  return loadConfig().port
}

function listeners(p) {
  const r = spawnSync('lsof', ['-ti', `tcp:${p}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
  return (r.stdout ?? '').trim().split('\n').filter(Boolean)
}

/**
 * 打到**正在跑的那个服务**上。
 *
 * 待审批记录只存在于服务进程的内存里（hook 的 HTTP 连接还挂在它手上），
 * 所以 approve/deny 不能像 `--devices` 那样另起一个一次性进程——
 * 那个进程的 ApprovalStore 是空的，什么也结不掉。
 */
async function api(path, init = {}) {
  const p = await port()
  if (!listeners(p).length) {
    console.error(c.r('\n  服务没在跑。开一个 Claude Code 会话会自动拉起它。\n'))
    process.exit(1)
  }
  const { loadConfig } = await appImport('config.mjs')
  const r = await fetch(`http://127.0.0.1:${p}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${loadConfig().token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(3000),
  })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}

const riskTag = (a) =>
  a.risk?.level === 'high' ? c.r('高危') : a.risk?.level === 'medium' ? c.y('中') : c.dim('普通')

/**
 * 在终端上决策。
 *
 * 为什么要有这个：这个工具的前提是「你人在电脑边」，可之前**人在电脑边时
 * 反而没有快捷路径**——刘海胶囊是 setIgnoresMouseEvents(true) 点不了的，
 * 终端状态栏只显示个数字，于是坐在 Mac 前最快的批准方式是去另一个房间
 * 拿手机。这是反的。
 */
async function decideFromCli(decision, idPrefix) {
  const { body } = await api('/api/approvals')
  const list = body.approvals ?? []
  if (!list.length) {
    console.log(c.dim('\n  没有待审批的操作\n'))
    process.exit(0)
  }

  const show = (a) =>
    `  ${c.b(a.id.slice(0, 8))}  ${riskTag(a)}  ${a.headline ?? a.summary ?? a.tool_name}`

  if (decision === 'list') {
    console.log()
    for (const a of list) {
      console.log(show(a))
      const left = Math.max(0, Math.round((a.expires_at - Date.now()) / 1000))
      // 到点会怎么处理，必须写清楚——「等着」和「等着然后自动放行」是两回事
      const fate = a.auto_decision === 'allow' ? c.y(`${left}s 后自动通过`) : c.dim(`${left}s 后自动拒绝`)
      console.log(`            ${fate}`)
    }
    console.log(c.dim('\n  npx clamicro approve <id前缀>   /   deny <id前缀>\n'))
    process.exit(0)
  }

  let target
  if (idPrefix) {
    const hits = list.filter((a) => a.id.startsWith(idPrefix))
    if (!hits.length) {
      console.error(c.r(`\n  没有以 ${idPrefix} 开头的待审批\n`))
      list.forEach((a) => console.log(show(a)))
      process.exit(1)
    }
    if (hits.length > 1) {
      console.error(c.r(`\n  ${idPrefix} 匹配到 ${hits.length} 条，写长一点\n`))
      hits.forEach((a) => console.log(show(a)))
      process.exit(1)
    }
    target = hits[0]
  } else if (list.length === 1) {
    target = list[0]
  } else {
    console.log(c.y(`\n  有 ${list.length} 条待审批，指明是哪一条：\n`))
    list.forEach((a) => console.log(show(a)))
    console.log(c.dim(`\n  npx clamicro ${decision === 'allow' ? 'approve' : 'deny'} <id前缀>\n`))
    process.exit(1)
  }

  // 高危批准必须点名，不能靠「反正只有一条」蒙过去。
  // 手机上高危右滑要划 55% 且不给快捷方式，终端这边也得有等价的摩擦——
  // 两个入口的安全强度不一致的话，人会自然挑松的那个。
  if (decision === 'allow' && target.risk?.level === 'high' && !idPrefix) {
    console.error(c.r('\n  这是高风险操作，批准要写明 id：\n'))
    console.log(show(target))
    if (target.detail) console.log(c.dim(`\n${target.detail.split('\n').slice(0, 6).map((l) => `    ${l}`).join('\n')}`))
    console.log(c.dim(`\n  npx clamicro approve ${target.id.slice(0, 8)}\n`))
    process.exit(1)
  }

  // 决策前把命令原文打出来，终端回滚记录里留一份——事后要能查「我批了什么」
  console.log(`\n${show(target)}`)
  if (target.detail) {
    console.log(c.dim(target.detail.split('\n').slice(0, 8).map((l) => `    ${l}`).join('\n')))
  }

  const { body: out } = await api(`/api/approvals/${target.id}/decide`, {
    method: 'POST',
    body: JSON.stringify({ decision }),
  })
  if (out.ok) {
    console.log(decision === 'allow' ? c.g('\n  ✓ 已批准\n') : c.y('\n  ✓ 已拒绝\n'))
  } else if (out.reason === 'already_settled') {
    // 幂等：手机上刚批过、或者终端弹框先放行了
    console.log(c.dim(`\n  这条已经被处理过了（${out.approval?.status ?? '未知状态'}）\n`))
  } else {
    console.error(c.r(`\n  失败：${out.error ?? '未知'}\n`))
    process.exit(1)
  }
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
  case 'untrust':
    // untrust            → 当前网络
    // untrust <id 前缀>  → 按 networks 列出的 id
    // untrust all        → 全部
    runApp([rest[0] ? `--untrust=${rest[0]}` : '--untrust'])
    break
  case 'rotate-token':
    runApp(['--rotate-token'])
    break
  case 'devices':
    runApp(['--devices'])
    break
  case 'forget':
    if (!rest[0]) {
      console.error(c.r('\n  要吊销哪台？ npx clamicro forget <id>   （先看 npx clamicro devices）\n'))
      process.exit(1)
    }
    runApp([`--forget=${rest[0]}`])
    break
  case 'networks':
    runApp(['--networks'])
    break
  case 'test-push':
    runApp(['--test-push'])
    break

  // 在终端上决策。人就在 Mac 前时，不该还要去拿手机。
  case 'approve':
  case 'allow':
    await decideFromCli('allow', rest[0])
    break
  case 'deny':
  case 'reject':
    await decideFromCli('deny', rest[0])
    break
  case 'pending':
    await decideFromCli('list', null)
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

    // 运行时落后于当前这个包。**离线判断，不花任何代价。**
    //
    // `npx clamicro@latest status` 跑的是 npm 包里的 cli.mjs，但服务跑的是
    // APP_DIR 里那份拷贝——只有 install 才会同步。不提示的话，status 会
    // 老老实实报旧版本号，用户以为自己已经升级了。
    if (info?.version && isNewer(PKG_VERSION, info.version)) {
      console.log(c.y(`            ⚠️ 这个包是 ${PKG_VERSION}，运行时还停在 ${info.version}`))
      console.log(c.dim('            跑一次 npx clamicro install 同步（配置和已配对设备都不受影响）'))
    }

    // registry 上有没有更新的版本。
    //
    // 放在这里而不是末尾：下面 `runApp(['--networks'])` 会 process.exit()，
    // 之后的代码根本执行不到。
    //
    // 这是整个工具唯一一次主动对外的网络请求，理由见 src/update.mjs：
    // 2.0.1 及更早的版本会把主令牌泄漏进事件流，一个管审批的工具不能
    // 让人一直蒙在鼓里。config.json 里 checkUpdates: false 可以彻底关掉。
    try {
      const { loadConfig } = await appImport('config.mjs')
      const cfg = loadConfig()
      if (cfg.checkUpdates !== false) {
        // checkUpdate 从**包自己**那份加载，不能走 appImport。
        //
        // 运行时落后正是这段代码要提示的情况，而旧运行时里压根没有
        // update.mjs——appImport 找不到文件会 process.exit(1)，于是
        // status 在刚说完「你该升级了」的下一行就死掉。实测踩到。
        const up = await checkUpdate(info?.version ?? PKG_VERSION, {
          cacheFile: join(APP_DIR, '..', 'update-check.json'),
        })
        if (up) {
          console.log(c.y(`  新版本    ${up.latest}  ${c.dim(`（当前 ${info?.version ?? PKG_VERSION}）`)}`))
          console.log(c.dim('            npx clamicro@latest install'))
        }
      }
    } catch {
      /* 查不到版本不是错误——没网的时候这个工具照样该能用 */
    }
    const alive = listeners(p).length > 0
    console.log(`  服务      ${alive ? c.g('运行中') : c.y('未运行')} ${c.dim(`:${p}`)}`)

    // 实际监听了哪几个地址。
    //
    // 这一条查了两天才想到要看。「服务运行中」只说明回环起来了，而手机走的是
    // 局域网地址——那个 socket 绑失败时，服务照常运行、status 一切正常、
    // 只有日志里一行 EADDRNOTAVAIL 没人看，表现就是「手机连不上，查不出原因」。
    // 所以这里不问「服务活着吗」，问「手机要连的那个地址在监听吗」。
    if (alive) {
      const r = spawnSync('lsof', ['-nP', `-iTCP:${p}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
      const bound = [...new Set((r.stdout ?? '').split('\n').slice(1)
        .map((l) => l.trim().split(/\s+/)[8]).filter(Boolean)
        .map((a) => a.replace(`:${p}`, '')))]
      const lan = bound.filter((a) => a !== '127.0.0.1' && a !== '::1')
      console.log(`  监听      ${bound.join('  ')}`)
      if (!lan.length) {
        console.log(c.r('            ⚠️ 只绑了回环，手机连不上'))
        console.log(c.dim('            多半是换过网络。看一眼原因： npx clamicro logs'))
        console.log(c.dim('            日志里若有 EADDRNOTAVAIL，说明配置里钉着一个已失效的地址'))
      }
    }

    // ignoreCwds 是**完全旁路**：列在里面的目录一条审批都不会拦。
    // 它本来只给「开发 clamicro 自身」用（否则每跑一条命令都在等自己审批），
    // 但填了之后没有任何地方显示——整个产品在那些目录下静默失效，
    // 而 status 还显示「运行中 ✓」。旁路必须是看得见的。
    try {
      const { loadConfig } = await appImport('config.mjs')
      const skipped = loadConfig().ignoreCwds ?? []
      if (skipped.length) {
        console.log(c.y(`  ⚠️ 免审批  ${skipped.length} 个目录下的操作不做任何拦截`))
        for (const d of skipped) console.log(c.dim(`            ${d}`))
        console.log(c.dim('            这些目录里 rm -rf 也会直接执行。清空： 编辑 config.json 的 ignoreCwds'))
      }
    } catch {
      /* 读不到配置的话，上面的服务检查已经报过了 */
    }

    if (alive) {
      // 用量为空时区分两种情况，并且只在终端里催——「新开会话」这个动作
      // 只能在终端做，在手机上看到这句话是干着急
      try {
        const { loadConfig } = await appImport('config.mjs')
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

  case 'tunnel': {
    const { hasCloudflared, startTunnel, stopTunnel, tunnelPid, TUNNEL_LOG } =
      await appImport('tunnel.mjs')
    const { loadConfig, saveConfig } = await appImport('config.mjs')
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
