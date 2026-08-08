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

/**
 * @param token   主令牌。CLI 和 `--qr` 用，也是配对流程之前的唯一凭证
 * @param devices 每设备令牌簿（config.devices）。传函数而不是数组——
 *                配对成功会往里加设备，鉴权必须看到最新的那份
 */
export function makeAuth(token, devices = () => []) {
  const sameToken = (given) => typeof given === 'string' && given.length > 0 && safeEq(given, token)

  /**
   * 认哪台设备。返回设备对象或 null。
   *
   * 逐个比是 O(设备数)，但设备数是个位数，而且每个比较都是常数时间——
   * 提前 return 会泄露「前缀匹配到第几个设备」，这里不做短路优化。
   */
  const matchDevice = (given) => {
    if (typeof given !== 'string' || !given) return null
    let hit = null
    for (const d of devices()) if (safeEq(given, d.token)) hit = d
    return hit
  }

  const present = (req) => {
    const header = req.headers.authorization ?? ''
    return header.startsWith('Bearer ') ? header.slice(7) : cookieToken(req)
  }

  return {
    sameToken,
    cookieToken,
    matchDevice,
    /** 拿着凭证的是哪台设备（主令牌返回 null——它不属于任何设备） */
    deviceOf(req) {
      return matchDevice(present(req))
    },
    /** Bearer（脚本用）或 cookie（手机浏览器用），主令牌或任一设备令牌均可 */
    authorized(req) {
      const given = present(req)
      return sameToken(given) || matchDevice(given) !== null
    },
    /**
     * 登录 cookie 的属性。
     *
     * SameSite 必须是 Lax 不能是 Strict。从别的 App 点链接进来（备忘录里存的地址、
     * 别人发来的消息、Mac 上弹出的二维码）都算跨站导航，Strict 的 cookie 不会被
     * 带上，表现是每次都像没登录过、要重新扫码。Lax 放行顶层 GET 导航，
     * 跨站 POST 仍然拦住。
     */
    loginCookie(baseUrl, value = token) {
      return [
        `ccm=${encodeURIComponent(value)}`,
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
