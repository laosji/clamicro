#!/usr/bin/env node
/**
 * 重新生成 README / 官网上的界面截图。
 *
 * ## 为什么要有这个脚本
 *
 * 上一批图是 8 月 20 日拍的，而之后界面改了不止一处：顶部换成品牌名 + 连接
 * 状态、单后端也分区、会话页底栏整个变成输入框、加了历史 tab、后端 logo
 * 回来了。到 8 月 29 日再看，README 里那三张图**没有一张还是现在的样子**。
 *
 * 根因不是没人管，是**重拍一次太麻烦**：要起服务、要造出「正在跑」和「有待
 * 审批」这两种转瞬即逝的状态、要摆到手机尺寸、还要三张图风格一致。手工做一
 * 遍要十几分钟，于是每次改完 UI 都想着「下次一起弄」。
 *
 * 所以把它变成一条命令：
 *
 *     node scripts/shots.mjs
 *
 * 它自己起一个**临时 HOME 上的服务**（不碰你的真实配置和真实会话），
 * 自己造状态，自己拍，自己关掉。改完 UI 顺手跑一次，图就不会再落后。
 *
 * ## 为什么不引 puppeteer
 *
 * 这个仓库是零依赖的。而 Chrome 本来就装在开发机上，Node 22 起 `WebSocket`
 * 是全局的——直接说 CDP（Chrome DevTools Protocol）就够了，一个依赖都不用加。
 * 代价是下面这几十行协议样板，换来的是 `npm i` 之后依然零依赖。
 *
 * ## 为什么 deviceScaleFactor 是 3
 *
 * 现有那批图是 1170×2532，即 390×844 的手机视口 @3x。官网按 640 宽显示，
 * 在 2 倍屏上要 1280 才够清楚——拍成 @2x（780 宽）会肉眼可见地糊一档。
 * 视口保持真实手机尺寸，只把像素密度拉到 3，这样**比例是真手机的**，
 * 清晰度也够。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'docs', 'images')
const PORT = Number(process.env.SHOT_PORT || 46011)
const BASE = `http://127.0.0.1:${PORT}`
const CHROME = process.env.CHROME
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/** 手机视口 @3x —— 出图 1170×2532，和历来那批图一致 */
const VIEW = { width: 390, height: 844, deviceScaleFactor: 3 }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** kill 之后等它真的退出，最多 3 秒。等不到就算了，别把清理变成失败点。 */
function reap(proc) {
  if (!proc || proc.exitCode !== null) return Promise.resolve()
  proc.kill()
  return new Promise((resolve) => {
    const t = setTimeout(() => { try { proc.kill('SIGKILL') } catch {} resolve() }, 3000)
    proc.once('exit', () => { clearTimeout(t); resolve() })
  })
}
const log = (...a) => console.log(' ', ...a)

/* ────────────────── 起一个临时服务 ────────────────── */

/**
 * **临时 HOME**：截图里绝不能出现你的真 token、真主机名、真项目路径。
 * 用一个空目录当 HOME，服务会在里面生成全新的配置和全新的 token，
 * 拍完连目录一起删掉。
 */
async function startServer() {
  const home = mkdtempSync(join(tmpdir(), 'clamicro-shots-'))
  const proc = spawn(process.execPath, [join(ROOT, 'server.mjs')], {
    env: { ...process.env, HOME: home, CLAMICRO_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  /*
   * 服务的输出留一份。第一版直接丢掉，于是端口被占时看到的是
   * 「config.json 不存在」——一个和真因（EADDRINUSE）毫不相干的错。
   */
  let out = ''
  proc.stdout.on('data', (b) => { out += b })
  proc.stderr.on('data', (b) => { out += b })

  let up = false
  for (let i = 0; i < 100 && !up; i++) {
    await sleep(100)
    try { up = (await fetch(`${BASE}/favicon.ico`)).ok } catch { /* 还没起来 */ }
  }
  if (!up) {
    /*
     * **起不来就把自己收拾干净再抛。** 第一版在这里直接 throw，而 spawn 出去
     * 的那个进程还活着——于是下一次跑就撞 EADDRINUSE，再下一次还撞，
     * 而报出来的错是「配置文件不存在」。一个泄漏的子进程能把后面每一次运行
     * 都毒死，还顺带把错因藏起来。
     */
    proc.kill()
    rmSync(home, { recursive: true, force: true })
    throw new Error(`服务没起来（端口 ${PORT}）：\n${out.trim() || '（没有输出）'}`)
  }
  const cfg = JSON.parse(readFileSync(join(home, '.claude/clamicro/config.json'), 'utf8'))
  return { proc, home, token: cfg.token }
}

/* ────────────────── 造状态 ────────────────── */

const post = (token, path, body) => fetch(`${BASE}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify(body),
})

const hook = (token, event, payload) => post(token, `/hooks/${event}`, payload)

/**
 * 三个后端各跑一个会话。
 *
 * 不是为了热闹：**分组按后端**是这一版首页的主结构，一个后端的截图看不出
 * 它长什么样。而「同时看着三个 agent 在跑」正是这个产品现在的样子。
 */
async function seedRunning(token) {
  const runs = [
    {
      id: 'A', agent: 'claude-code', cwd: '/Users/you/code/checkout-api',
      prompt: '把结账流程的重试逻辑抽出来，补上超时',
      tools: [['Read', 'src/checkout/retry.ts'], ['Grep', 'withRetry( src/'],
        ['Read', 'src/checkout/client.ts'], ['Edit', 'src/checkout/retry.ts'],
        ['Bash', 'npm run typecheck']],
    },
    {
      id: 'B', agent: 'codex', cwd: '/Users/you/code/docs-site',
      prompt: '梳理一遍导航结构',
      tools: [['Read', 'src/nav.tsx'], ['Grep', 'NavItem src/']],
    },
    {
      id: 'C', agent: 'dsh', cwd: '/Users/you/code/ingest-worker',
      prompt: '把批量导入改成流式',
      tools: [['Read', 'worker/ingest.py']],
    },
  ]
  for (const r of runs) {
    await hook(token, 'user-prompt-submit', {
      session_id: r.id, cwd: r.cwd, hook_event_name: 'UserPromptSubmit',
      prompt: r.prompt, agent: r.agent,
    })
    for (const [tool, arg] of r.tools) {
      await hook(token, 'pre-tool-use', {
        session_id: r.id, cwd: r.cwd, hook_event_name: 'PreToolUse',
        tool_name: tool, tool_input: { file_path: arg, command: arg, pattern: arg },
        agent: r.agent,
      })
      await sleep(120) // 错开时间戳，履历才有先后
    }
  }

  // 额度环要有数才画得出来。给一个不吓人也不空的读数
  const now = Math.floor(Date.now() / 1000)
  await post(token, '/statusline', {
    session_id: 'A', cwd: runs[0].cwd,
    model: { display_name: 'Opus 5' },
    workspace: { current_dir: runs[0].cwd },
    context_window: { used_percentage: 38, context_window_size: 200000 },
    cost: { total_cost_usd: 0.8412 },
    rate_limits: {
      five_hour: { used_percentage: 47, resets_at: now + 7300 },
      seven_day: { used_percentage: 23, resets_at: now + 286000 },
    },
  })
}

/**
 * 两条待审批。
 *
 * PermissionRequest 是**阻塞的**——它会一直挂着等人决定（那正是这个产品的
 * 核心）。所以这里发出去就不管了，让它挂着，截完图随服务一起结束。
 */
async function seedPending(token) {
  /*
   * 会话 id 要**避开 seedRunning 里那三个后端**。
   *
   * 第一版第二条审批复用了 `B`（那是 Codex 的会话）却写 agent: claude-code
   * ——一条 hook 就把那个会话改判给了另一个后端，于是首页上 Codex 那一组
   * 变成「空闲 · 0 个会话」。截图里一个空组比少一个组更难看，而且它说的
   * 是假话。
   *
   * 第一条挑 `git push --force`：它**真的**会被判成高风险（src/risk/rules.mjs
   * 里「强推覆盖远端」那条），于是卡片走红色、给足三分钟。原来那条
   * `psql -f migrations/…` 判的是普通风险、10 秒自动通过——截图拍下来是
   * 一条正在倒数 7 秒的进度条，看着像「你还没看它就要过了」，
   * 而这恰恰是这个产品最不想给人的印象。
   *
   * （`psql -f` 判普通并不是漏报：风险引擎读不到那个 .sql 文件里写了什么，
   * 卡片如实写着「影响面未知」。）
   */
  const asks = [
    {
      id: 'A', cwd: '/Users/you/code/checkout-api', agent: 'claude-code',
      /*
       * `description` 是**模型自己写的**那句话，真实请求里一定带。不给的话
       * 详情页「模型的描述」那一栏就复述一遍命令本身，看着像功能没做完。
       *
       * 顺带：这一栏存在的意义是「描述和命令对不对得上」——src/approvals.mjs
       * 说它是整条链路里唯一不可信的部分。所以这里写一句**如实**的描述，
       * 别顺手编一句听着无害的，那会把 mismatch 警告拍进宣传图里。
       */
      tool: 'Bash',
      input: {
        command: 'git push --force origin main',
        description: '把本地 main 强制推到远端，覆盖远端已有的提交历史',
      },
    },
    {
      id: 'D', cwd: '/Users/you/code/admin-web', agent: 'claude-code',
      tool: 'Write',
      input: {
        file_path: 'src/routes/billing.tsx',
        content: 'export const Billing = () => …',
        description: '把账单页拆成 /billing 和 /billing/invoices 两个路由',
      },
    },
  ]
  /*
   * 先让 D 像个真会话：一句提问 + 两次工具调用，然后才请求授权。
   *
   * 只发 permission-request 的话，那个会话是被审批**顺带建出来**的——没有
   * cwd，于是卡片标题回退成 session_id，首页上直接显示一个大写的「D」。
   * 卡片里也空空如也。真实的会话不会凭空冒出来请求授权，它总是先干了点什么。
   */
  await hook(token, 'user-prompt-submit', {
    session_id: 'D', cwd: '/Users/you/code/admin-web', hook_event_name: 'UserPromptSubmit',
    prompt: '把账单页拆成两个路由', agent: 'claude-code',
  })
  for (const [tool, arg] of [['Read', 'src/routes/billing.tsx'], ['Grep', 'useBilling src/']]) {
    await hook(token, 'pre-tool-use', {
      session_id: 'D', cwd: '/Users/you/code/admin-web', hook_event_name: 'PreToolUse',
      tool_name: tool, tool_input: { file_path: arg, pattern: arg }, agent: 'claude-code',
    })
    await sleep(120)
  }

  for (const a of asks) {
    hook(token, 'permission-request', {
      session_id: a.id, cwd: a.cwd, hook_event_name: 'PermissionRequest',
      tool_name: a.tool, tool_input: a.input, agent: a.agent,
    }).catch(() => {})
    await sleep(400)
  }
  await sleep(600)
  const r = await fetch(`${BASE}/api/approvals`, { headers: { Authorization: `Bearer ${token}` } })
  const { approvals } = await r.json()
  return approvals ?? []
}

/* ────────────────── CDP：零依赖驱动 Chrome ────────────────── */

async function chrome() {
  const dir = mkdtempSync(join(tmpdir(), 'clamicro-chrome-'))
  const proc = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--force-color-profile=srgb', '--disable-lcd-text',
  ], { stdio: ['ignore', 'pipe', 'pipe'] })

  /*
   * 端口从 `DevToolsActivePort` 读，不去嗅 stderr。
   *
   * 那一行 "DevTools listening on ws://…" 确实会打到 stderr，但它可能在监听
   * 器挂上之前就已经出来了——第一版就是这么超时的，而 Chrome 其实早就起好了。
   * 这个文件是 Chrome 绑定端口之后自己写的，轮询它没有竞态。
   *
   * 文件两行：端口，以及浏览器那个 target 的路径。
   */
  const portFile = join(dir, 'DevToolsActivePort')
  let wsUrl = null
  for (let i = 0; i < 200 && !wsUrl; i++) {
    await sleep(100)
    try {
      const [port, path] = readFileSync(portFile, 'utf8').split('\n')
      if (port && path) wsUrl = `ws://127.0.0.1:${port.trim()}${path.trim()}`
    } catch { /* 还没写出来 */ }
  }
  if (!wsUrl) throw new Error('等不到 Chrome 的 DevTools 端口（DevToolsActivePort 没出现）')
  return { proc, dir, wsUrl }
}

/** 一个够用的 CDP 客户端：发命令、等回包。够拍照就行，不做通用库。 */
function cdp(ws) {
  let id = 0
  const waiting = new Map()
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data)
    const w = waiting.get(msg.id)
    if (!w) return
    waiting.delete(msg.id)
    msg.error ? w.reject(new Error(JSON.stringify(msg.error))) : w.resolve(msg.result)
  })
  return (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const n = ++id
    waiting.set(n, { resolve, reject })
    ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
}

/* ────────────────── 主流程 ────────────────── */

const SHOTS = [
  { name: 'home-running', path: '/ui', seed: 'running', settle: 2200 },
  { name: 'home-pending', path: '/ui', seed: 'pending', settle: 1600 },
  { name: 'approval-detail', path: null, seed: 'pending', settle: 1400 }, // path 由审批 id 决定
]

async function main() {
  mkdirSync(OUT, { recursive: true })
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'))
  const todo = only.length ? SHOTS.filter((s) => only.includes(s.name)) : SHOTS

  for (const shot of todo) {
    log(`— ${shot.name}`)
    // 创建也要在 try 里：任何一步失败都得保证两个子进程都被收掉
    let srv = null; let br = null
    try {
      srv = await startServer()
      br = await chrome()
      await seedRunning(srv.token)
      let target = shot.path
      if (shot.seed === 'pending') {
        const aps = await seedPending(srv.token)
        if (!aps.length) throw new Error('没造出待审批记录')
        if (!target) target = `/ui/a/${aps[0].id}?k=${encodeURIComponent(aps[0].key)}`
      }

      const ws = new WebSocket(br.wsUrl)
      await new Promise((r) => ws.addEventListener('open', r, { once: true }))
      const send = cdp(ws)

      const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
      const s = (m, p) => send(m, p, sessionId)

      await s('Page.enable')
      await s('Emulation.setDeviceMetricsOverride', { ...VIEW, mobile: true })
      // 深色：这批图历来是深色的，和官网 hero 一致
      await s('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
      // 令牌走 cookie —— 和手机上配对之后拿到的是同一条路
      await s('Network.enable')
      await s('Network.setCookie', { name: 'ccm', value: srv.token, url: BASE, path: '/' })
      // 跳过首次引导，否则拍到的是引导页
      await s('Page.addScriptToEvaluateOnNewDocument', {
        source: "try{localStorage.setItem('ccm-onboarded','1')}catch(e){}",
      })

      await s('Page.navigate', { url: BASE + target })
      await sleep(shot.settle)

      const { data } = await s('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      const file = join(OUT, `${shot.name}.png`)
      writeFileSync(file, Buffer.from(data, 'base64'))
      log(`  ${file}`)
      ws.close()
    } finally {
      /*
       * 先等进程真的退出，再删它的目录。
       *
       * `kill()` 只是发信号——Chrome 收到之后还会往 user-data-dir 里写一阵子
       * （Local State、日志、锁文件）。删早了就是 ENOTEMPTY，而那时图其实
       * **已经拍好写盘了**：一次成功的运行被一句清理错误报成失败。
       *
       * 删不掉也不算失败：临时目录留在 /tmp 里，系统自己会收。清理的失败
       * 不该盖掉产物的成功。
       */
      await Promise.all([reap(br?.proc), reap(srv?.proc)])
      for (const d of [br?.dir, srv?.home]) {
        if (!d) continue
        try { rmSync(d, { recursive: true, force: true }) } catch { /* 留给系统收 */ }
      }
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
