import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readBody, json, html, inlineJson } from '../http/respond.mjs'
import { safeEq, cookieToken, cookieNamed } from '../auth/token.mjs'
import { requireDeps } from './deps.mjs'
import { showHud } from '../hud.mjs'
import { confirmPairing } from '../confirm.mjs'
import { isLoopback } from '../http/security.mjs'

/**
 * 页面、静态资源、配对。
 *
 * 权限分两级，别混：
 *   · 登录 token（cookie 或 Bearer）—— 开整个看板
 *   · 单条审批的 ?k= —— 只开那一条审批的详情页
 * 后者是明文写在 URL 里的（会进浏览器历史、会被转发），所以作用域严格
 * 限制在一条审批上，不足以授权看板。审批页里的 hasSession 就是用来区分
 * 这两者的：只有真的持有登录 cookie，决策后才跳回首页。
 */
export function pageRoutes(ctx) {
  requireDeps('pageRoutes', ctx, [
    'config', 'approvals', 'notify', 'auth', 'publicApproval', 'HERE',
    'pairing', 'confirms', 'addDevice', 'saveConfig',
  ])
  const { config, approvals, notify, auth, publicApproval, HERE, pairing, confirms, addDevice, saveConfig } = ctx
  const { sameToken, matchDevice, authorized, loginCookie } = auth

  // 配对请求限流，避免局域网上有人刷屏
  let lastPairAt = 0

  const page = (name) => readFileSync(join(HERE, 'ui', name), 'utf8')

  /**
   * 从 User-Agent 猜个设备名，纯粹是为了让设备列表可读——
   * 「iPhone」比「未命名设备」好认。UA 是客户端可伪造的，所以它只用于显示，
   * 绝不参与任何判断。
   */
  const deviceNameOf = (req) => {
    const ua = String(req.headers['user-agent'] ?? '')
    if (/iPhone/.test(ua)) return 'iPhone'
    if (/iPad/.test(ua)) return 'iPad'
    if (/Macintosh/.test(ua)) return 'Mac'
    if (/Android/.test(ua)) return 'Android'
    return null
  }

  return async function handlePages(req, res, url, path) {
    /**
     * 开一张一次性配对券。**只认回环**（在 server.mjs 的前置闸门里挡掉外来请求）——
     * 它能凭空造出登录凭证，局域网上谁都能造的话，一次性和过期就都白设了。
     *
     * 调用方是 `clamicro qr`：那是个短命的 CLI 进程，自己生成的 id 没人认，
     * 必须向运行中的服务要。
     */
    if (req.method === 'POST' && path === '/api/pair/new') {
      const { id, ttlMs } = pairing.begin()
      json(res, 200, { id, ttlMs })
      return true
    }

    // ---- 配对提示：未认证也可访问 ----
    // 只给一条「去 Mac 上敲这个」的命令，不返回任何凭证。
    if (path === '/api/pair/hint') {
      json(res, 200, { command: `npx clamicro qr` })
      return true
    }

    /**
     * 让 Mac 弹出二维码。未认证可达，所以有 10 秒限流——
     * 局域网上有人刷它，最多让你的 Mac 反复弹窗，拿不到任何东西
     * （二维码里现在只有一次性 id，且这个响应不含它）。
     */
    if (req.method === 'POST' && path === '/api/pair') {
      // 要求一个自定义头。跨站「简单请求」带不了它，会触发预检而被拦下，
      // 否则你访问的任意网站都能让这台 Mac 弹二维码。
      if (req.headers['x-ccm'] !== '1') {
        json(res, 403, { error: 'forbidden' })
        return true
      }
      const now = Date.now()
      if (now - lastPairAt < 10_000) {
        json(res, 429, { ok: false, error: '刚显示过，去看看 Mac 屏幕' })
        return true
      }
      lastPairAt = now
      const { id } = pairing.begin()
      const loginUrl = `${config.baseUrl}/ui/pair/${id}`
      const { spawnSync, spawn } = await import('node:child_process')
      const png = join(tmpdir(), 'clamicro-pair.png')
      const q = spawnSync('qrencode', ['-o', png, '-s', '10', '-m', '3', loginUrl])
      if (q.status === 0) spawn('open', [png], { detached: true, stdio: 'ignore' }).unref()
      await notify({
        title: 'Clamicro',
        subtitle: '配对',
        body: '扫描屏幕上的二维码 · 60 秒内有效',
        silent: true, // 你人就在屏幕前等着它，不用出声
      })
      console.log('[pair] 已在 Mac 上显示二维码（一次性，60 秒）')
      json(res, 200, { ok: true, qr: q.status === 0 })
      return true
    }

    /**
     * 「最新一条待审批」的稳定入口。
     *
     * 存在的理由是 iOS 的**轻点背面 → 快捷指令 → 打开 URL**：双击手机背面
     * 就直接落到要批的那一屏，省掉「掏手机、解锁、找书签」。
     *
     * 注意它只做**导航**，不做决策。用轻点背面直接批准是很糟的主意：
     * 那个手势没有上下文（不知道你在批哪条）、误触率高（放桌上就可能触发），
     * 而且会绕过这个产品唯一的防线——你看清命令再决定。口袋里揣一个
     * 「对任何事都说好」的按钮，等于把 autoApproveHighRisk 永远打开。
     */
    if (req.method === 'GET' && path === '/ui/latest') {
      if (!authorized(req)) {
        html(res, 401, page('pair.html'))
        return true
      }
      const [next] = approvals.pending()
      res.writeHead(302, { Location: next ? `/ui/a/${next.id}` : '/ui' })
      res.end()
      return true
    }

    /**
     * 配对第一步：扫码落到这里。
     *
     * **立刻返回一个等待页，确认在后台跑。** 之前是同步等 Mac 的确认框，
     * 手机那边就是最长 60 秒的白屏加载页——Safari 只有一根细进度条。人会以为
     * 「扫了没反应」，于是返回、重扫，把券一张张烧掉，最后得出「这东西是坏的」。
     *
     * 未认证可达是必须的——还没配对呢。安全性来自三层：
     *   1. 配对 id：一次性、60 秒过期，事后翻到截图里的那张码一律无效
     *   2. Mac 上的授权确认（见 confirm.mjs）
     *   3. watch 凭据：结果只发给**真正扫了码的那个浏览器**，见下
     */
    const pairMatch = path.match(/^\/ui\/pair\/([\w-]+)$/)
    if (req.method === 'GET' && pairMatch) {
      if (!pairing.redeem(pairMatch[1])) {
        html(res, 410, page('pair-expired.html'))
        return true
      }

      const tunnelHost = (() => {
        try { return new URL(config.tunnelUrl).host.toLowerCase() } catch { return null }
      })()
      const viaTunnel = !!tunnelHost && String(req.headers.host ?? '').toLowerCase() === tunnelHost
      const name = deviceNameOf(req) || '未命名设备'

      /**
       * 轮询凭据按 **watch** 取结果，不按配对 id。
       *
       * 用 id 做键的话，那个 id 曾经出现在二维码里——见过 Mac 屏幕的人就能去
       * 轮询把令牌接走，而这道 Mac 确认恰恰就是为了防这种人。watch 只写进
       * 这一次响应的 httpOnly cookie，只有真正扫了码的那个浏览器有。
       */
      const watch = confirms.begin({ name, viaTunnel })

      // 不 await：这个请求要立刻返回。确认在后台跑，结果落进 confirms
      confirmPairing({
        name,
        loopback: isLoopback(req),
        tunnel: viaTunnel,
        ip: req.socket?.remoteAddress ?? null,
      })
        .then((ok) => {
          confirms.settle(watch, ok)
          if (!ok) {
            // 被拒必须留痕。有人在你不知情时试过配对，这件事本身值得看见——
            // 静默失败会让它看起来只是「码过期了」
            console.warn(`[pair] 已拒绝「${name}」的配对请求（${viaTunnel ? '经隧道' : '局域网/本机'}）`)
          }
        })
        .catch(() => confirms.settle(watch, false))

      html(res, 200, page('pair-wait.html'), {
        // watch 和登录 cookie 用不同的名字，否则会互相覆盖；
        // 5 分钟就够——它只服务于这一次等待，之后一文不值
        'Set-Cookie': [
          `ccm_w=${encodeURIComponent(watch)}`,
          'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=300',
          ...(String(config.baseUrl).startsWith('https:') ? ['Secure'] : []),
        ].join('; '),
      })
      return true
    }

    /**
     * 配对第二步：等待页轮询这里。
     *
     * 设备在**领取时**才创建，不是确认通过的那一刻——扫完就切走的标签页
     * 不该留下一台幽灵设备，而 maxDevices 默认是 1，一台幽灵就能把你顶下线。
     */
    if (req.method === 'GET' && path === '/api/pair/status') {
      // 和 /api/pair 同样的理由：跨站「简单请求」带不了自定义头，
      // 否则你访问的任意网站都能替你轮询这个接口
      if (req.headers['x-ccm'] !== '1') {
        json(res, 403, { error: 'forbidden' })
        return true
      }
      const watch = cookieNamed(req, 'ccm_w')
      if (!watch) {
        json(res, 200, { state: 'unknown' })
        return true
      }
      const st = confirms.peek(watch)
      if (st.state !== 'allowed') {
        json(res, 200, { state: st.state })
        return true
      }

      const meta = confirms.claim(watch) // 一次性：领完即删
      if (!meta) {
        json(res, 200, { state: 'unknown' })
        return true
      }
      const device = addDevice(config, { name: meta.name })
      saveConfig(config)

      // 顶替必须**高声**说出来。设备上限的全部价值就是可检测性——
      // 多出来的那台一定会顶掉你，而你只有在被明确告知时才会发现。
      const kicked = device.evicted.map((d) => d.name).join('、')
      console.log(
        `[pair] 已配对「${device.name}」 ${device.id}` + (kicked ? `，顶掉了 ${kicked}` : ''),
      )
      showHud({
        icon: kicked ? '⚠️' : '📱',
        title: kicked ? '新设备已顶替原设备' : '已配对',
        subtitle: kicked ? `${device.name} 接入 · ${kicked} 已下线` : `${device.name} · ${device.id}`,
      })
      if (kicked) {
        // HUD 划过去就没了，顶替这种**你必须知道**的事同时发标准通知，
        // 那条会留在通知中心，错过了还能回头看见
        notify({
          title: 'Clamicro',
          subtitle: '⚠️ 新设备已顶替原设备',
          body: `${device.name} 接入，${kicked} 已下线。不是你操作的话立刻 npx clamicro forget all`,
        }).catch(() => {})
      }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': [
          loginCookie(config.baseUrl, device.token),
          // watch 用完就地作废，别让它在浏览器里多留 5 分钟
          'ccm_w=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
        ],
      })
      res.end(JSON.stringify({ state: 'allowed' }))
      return true
    }

    // ---- 静态资源（手势模块，两个页面共用）----
    const asset = path.match(/^\/ui\/(swipe\.(?:js|css))$/)
    if (req.method === 'GET' && asset) {
      const body = readFileSync(join(HERE, 'ui', asset[1]), 'utf8')
      res.writeHead(200, {
        'Content-Type': asset[1].endsWith('.js')
          ? 'application/javascript; charset=utf-8'
          : 'text/css; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-cache',
      })
      res.end(body)
      return true
    }

    /**
     * 图标和 manifest —— 「添加到主屏幕」要用。
     *
     * **未认证也要能取**：iOS 是在你按下「添加到主屏幕」时去抓图标的，那一刻
     * 请求不一定带 cookie；抓不到就退化成一张页面截图，桌面上那个图标会很难看。
     * 这几个文件里没有任何秘密，公开无所谓。
     *
     * 图标缓存一天：它几乎不变，而每次进首页都重取一遍纯属浪费。
     */
    const staticFile = path.match(/^\/ui\/(manifest\.webmanifest|icons\/icon-\d{2,4}\.png)$/)
    if (req.method === 'GET' && staticFile) {
      const name = staticFile[1]
      const png = name.endsWith('.png')
      let body
      try {
        body = readFileSync(join(HERE, 'ui', name))
      } catch {
        json(res, 404, { error: 'not found' })
        return true
      }
      res.writeHead(200, {
        'Content-Type': png ? 'image/png' : 'application/manifest+json; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': png ? 'public, max-age=86400' : 'no-cache',
      })
      res.end(body)
      return true
    }

    // 裸输 host:port 的人比想象中多——手动敲地址、从备忘录里翻出来、
    // 或者别人念给你听。之前根路径落到最后的 404，返回一坨 {"error":"not found"}，
    // 看起来像服务坏了，实际上服务好好的。这种「正常状态被显示成故障」最费时间。
    if (req.method === 'GET' && path === '/') {
      res.writeHead(302, { Location: '/ui' })
      res.end()
      return true
    }

    // ---- 首页 ----
    if (req.method === 'GET' && (path === '/ui' || path === '/ui/')) {
      // 首次带 ?t=<token> 访问 → 换成 httpOnly cookie，之后 URL 里不再出现 token
      const t = url.searchParams.get('t')
      /**
       * 两个 bug 修在这一行里：
       *
       * 1. **原来只认主令牌**（`sameToken(t)`），带设备令牌来的一律被打回配对页。
       *    可设备令牌恰恰是手机手里那份——换手机、清了浏览器数据、cookie 过期
       *    之后想重新登录，走的就是这条路，结果是「明明有令牌却一直让我配对」。
       *
       * 2. **cookie 里写的是主令牌**（`loginCookie(baseUrl)` 不传值就用主令牌）。
       *    于是从 `clamicro qr` 扫码进来的手机，拿到的是**主令牌**——那把
       *    `forget <device>` 吊销不掉、还能签发新设备的万能钥匙。
       *    每设备令牌的整个设计因此形同虚设。
       *
       * 现在：谁递进来的令牌，cookie 里就写谁。递设备令牌得设备令牌，
       * 递主令牌（CLI/二维码那条路）才是主令牌。
       */
      if (t && (sameToken(t) || matchDevice(t))) {
        res.writeHead(302, { Location: '/ui', 'Set-Cookie': loginCookie(config.baseUrl, t) })
        res.end()
        return true
      }
      html(res, authorized(req) ? 200 : 401, page(authorized(req) ? 'home.html' : 'pair.html'))
      return true
    }

    if (req.method === 'GET' && /^\/ui\/s\/[\w-]+$/.test(path)) {
      html(res, authorized(req) ? 200 : 401, page(authorized(req) ? 'session.html' : 'pair.html'))
      return true
    }

    /**
     * 新手引导。三屏三个路由，不是同一屏的分步显示——中途切走再回来能从
     * 中断的那一步继续（进度记在 localStorage，首页渲染前据此重定向回来）。
     *
     * 必须已登录：这几屏讲的是「你现在能做什么」，对还没配对的人毫无意义，
     * 而且第三屏要真的创建一条审批。未登录一律回配对页。
     */
    if (req.method === 'GET' && /^\/ui\/onboarding\/[123]$/.test(path)) {
      html(res, authorized(req) ? 200 : 401, page(authorized(req) ? 'onboarding.html' : 'pair.html'))
      return true
    }

    if (req.method === 'GET' && path === '/ui/settings') {
      if (!authorized(req)) {
        html(res, 401, '<h1>需要访问口令</h1><p>请先从 /ui 进入</p>')
        return true
      }
      html(res, 200, page('settings.html'))
      return true
    }

    // ---- 审批页 ----
    const uiMatch = path.match(/^\/ui\/a\/([\w-]+)$/)
    if (req.method === 'GET' && uiMatch) {
      const ap = approvals.get(uiMatch[1])
      if (!ap) {
        html(res, 404, page('gone.html'))
        return true
      }
      if (!safeEq(url.searchParams.get('k'), ap.key) && !authorized(req)) {
        html(res, 403, '<h1>链接无效</h1>')
        return true
      }
      /**
       * 打开详情页 = 有人在看 = 停表。
       *
       * 必须在算 boot **之前**做，否则页面上的倒计时用的还是旧的 expires_at，
       * 屏幕上写着「10 秒后自动通过」而服务端其实已经给了 3 分钟——那比不延长
       * 更糟，人会因为看到一个吓人的数字而慌着乱滑。
       *
       * 时限用 config.approval.timeoutMs（默认 3 分钟）：够你读完命令再决定，
       * 又不至于让一次走神把会话冻住太久。
       */
      approvals.extend(ap.id, config.approval?.timeoutMs ?? 180_000)

      const boot = inlineJson({
        ...publicApproval(ap, true),
        /**
         * 这个字段问的是「**这个浏览器能不能回看板**」，所以判据是
         * authorized（主令牌**或**设备令牌），不是 sameToken。
         *
         * 原来用 sameToken 只认主令牌，于是**配过对的手机永远是 false**——
         * 而配过对的手机正是这个产品的主要用户。表现：处理完一条审批后
         * 结果页既不显示「返回首页」也不自动跳转，人卡在一个死页面上，
         * 只能手动改地址栏。从通知深链（?k=）进来、还没配对的浏览器才
         * 应该是 false：那个 key 的作用域只有这一条审批，它确实回不去看板。
         */
        hasSession: authorized(req),
      })
      // 必须用**函数式**替换。审批内容是 shell 命令，$ 遍地都是，而 replace 的
      // 替换串里 $' 表示「匹配之后的全部内容」、$& 表示匹配本身——直接传字符串
      // 会把页面自己的源码注入进 JSON。函数返回值不做任何 $ 解释。
      html(res, 200, page('approval.html').replace('__BOOTSTRAP__', () => boot))
      return true
    }

    return false
  }
}
