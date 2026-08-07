import { timingSafeEqual } from 'node:crypto'

/**
 * 访问口令的校验。
 *
 * 两种呈递方式：Bearer 头给脚本用，cookie 给手机浏览器用。
 * 单条审批还有自己的 key（见 approvals.mjs），那是另一套、作用域小得多的凭证——
 * 它经过了推送服务商，所以只够开那一条审批的详情页，不足以授权整个看板。
 */

/** 常数时间比较，避免给出可测的时间差 */
export function safeEq(a, b) {
  const x = Buffer.from(String(a ?? ''))
  const y = Buffer.from(String(b ?? ''))
  return x.length === y.length && timingSafeEqual(x, y)
}

export function cookieToken(req) {
  const raw = req.headers.cookie ?? ''
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === 'ccm') return decodeURIComponent(v.join('='))
  }
  return null
}

export function makeAuth(token) {
  const sameToken = (given) => typeof given === 'string' && given.length > 0 && safeEq(given, token)

  return {
    sameToken,
    cookieToken,
    /** Bearer（脚本用）或 cookie（手机浏览器用） */
    authorized(req) {
      const header = req.headers.authorization ?? ''
      const bearer = header.startsWith('Bearer ') ? header.slice(7) : ''
      return sameToken(bearer) || sameToken(cookieToken(req))
    },
    /**
     * 登录 cookie 的属性。
     *
     * SameSite 必须是 Lax 不能是 Strict。从别的 App 点链接进来（备忘录里存的地址、
     * 别人发来的消息、Mac 上弹出的二维码）都算跨站导航，Strict 的 cookie 不会被
     * 带上，表现是每次都像没登录过、要重新扫码。Lax 放行顶层 GET 导航，
     * 跨站 POST 仍然拦住。
     */
    loginCookie(baseUrl) {
      return [
        `ccm=${encodeURIComponent(token)}`,
        'HttpOnly',
        'SameSite=Lax',
        'Path=/',
        // 30 天，不是一年。这个 cookie 能批准 rm -rf 和读 ~/.ssh——
        // 一年的有效期对这种权限太长了，而重新扫码只是几秒钟的事。
        // 令牌本身可以用 `clamicro rotate-token` 立刻作废。
        'Max-Age=2592000',
        ...(String(baseUrl).startsWith('https:') ? ['Secure'] : []),
      ].join('; ')
    },
  }
}
