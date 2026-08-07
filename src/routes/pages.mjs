import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { json, html, inlineJson } from '../http/respond.mjs'
import { safeEq, cookieToken } from '../auth/token.mjs'
import { requireDeps } from './deps.mjs'

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
  requireDeps('pageRoutes', ctx, ['config', 'approvals', 'notify', 'auth', 'publicApproval', 'HERE'])
  const { config, approvals, notify, auth, publicApproval, HERE } = ctx
  const { sameToken, authorized, loginCookie } = auth

  // 配对请求限流，避免局域网上有人刷屏
  let lastPairAt = 0

  const page = (name) => readFileSync(join(HERE, 'ui', name), 'utf8')

  return async function handlePages(req, res, url, path) {
    // ---- 配对：未认证也可访问 ----
    // 让二维码显示在 Mac 屏幕上（口令不经过这个未认证的请求返回），
    // 局域网上的其他人最多让你的 Mac 弹一次二维码，看不到内容。
    if (path === '/api/pair/hint') {
      json(res, 200, { command: `node ${join(HERE, 'server.mjs')} --qr` })
      return true
    }

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
      const loginUrl = `${config.baseUrl}/ui?t=${config.token}`
      const { spawnSync, spawn } = await import('node:child_process')
      const png = join(tmpdir(), 'clamicro-pair.png')
      const q = spawnSync('qrencode', ['-o', png, '-s', '10', '-m', '3', loginUrl])
      if (q.status === 0) spawn('open', [png], { detached: true, stdio: 'ignore' }).unref()
      await notify({
        title: '📱 Clamicro 配对',
        body: q.status === 0 ? '扫描屏幕上的二维码即可登录' : loginUrl,
      })
      console.log('[pair] 已在 Mac 上显示二维码')
      json(res, 200, { ok: true, qr: q.status === 0 })
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
      if (t && sameToken(t)) {
        res.writeHead(302, { Location: '/ui', 'Set-Cookie': loginCookie(config.baseUrl) })
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
      const boot = inlineJson({
        ...publicApproval(ap, true),
        hasSession: sameToken(cookieToken(req)),
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
