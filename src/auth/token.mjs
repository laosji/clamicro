import { timingSafeEqual } from 'node:crypto'

/**
 * 访问口令的校验。
 *
 * 两种呈递方式：Bearer 头给脚本用，cookie 给手机浏览器用。
 * 单条审批还有自己的 key（见 approvals.mjs），那是另一套、作用域小得多的凭证——
 * 它经过了推送服务商，所以只够开那一条审批的详情页，不足以授权整个看板。
 */

/**
 * 常数时间比较，避免给出可测的时间差。
 *
 * `x.length === y.length &&` 前面的长度短路会泄露「长度是否猜对」这一 bit，
 * 但这里**不是可利用洞**：所有调用方（主令牌 / 设备令牌 / per-approval key /
 * 配对券）都是 `randomBytes(...).toString('base64url')` 的**定长**输出，长度
 * 由算法决定、本就不保密。将来若引入**变长** secret，这里要改成先
 * `sha256` 两侧再 `timingSafeEqual`（把长度差异也压成定长），否则会真的泄露长度。
 */
export function safeEq(a, b) {
  const x = Buffer.from(String(a ?? ''))
  const y = Buffer.from(String(b ?? ''))
  return x.length === y.length && timingSafeEqual(x, y)
}

/** 按名字取 cookie。配对等待用的是 ccm_w，和登录用的 ccm 是两回事。 */
export function cookieNamed(req, name) {
  const raw = req.headers.cookie ?? ''
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return decodeURIComponent(v.join('='))
  }
  return null
}

export function cookieToken(req) {
  return cookieNamed(req, 'ccm')
}

/**
 * @param token   主令牌。CLI 和 `--qr` 用，也是配对流程之前的唯一凭证
 * @param devices 每设备令牌簿（config.devices）。传函数而不是数组——
 *                配对成功会往里加设备，鉴权必须看到最新的那份
 */
export function makeAuth(token, devices = () => []) {
  /**
   * 主令牌**每次现取**，不在这里捕获成常量。
   *
   * 原来是 `safeEq(given, token)`，token 是构造时那一刻的值。于是
   * `clamicro rotate-token` 从另一个进程改完磁盘，运行中的服务还拿着旧的：
   * 泄漏的旧令牌继续能批操作，新令牌反而 401——一个「紧急吊销」按钮
   * 按下去什么都没吊销，而且不报错。
   *
   * 传函数就能让服务在配置热加载后立刻生效（见 server.mjs 的 watchConfig）。
   * 兼容传字符串的老写法。
   */
  const current = typeof token === 'function' ? token : () => token
  const sameToken = (given) => {
    const t = current()
    return typeof given === 'string' && given.length > 0 && typeof t === 'string' && t.length > 0 && safeEq(given, t)
  }

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
    /**
     * @param value 要写进 cookie 的令牌。省略时用主令牌。
     *
     * 默认值必须是 `current()` 而不是 `token`：`token` 现在**可能是个函数**
     * （makeAuth 支持传 getter，见上面 sameToken 的注释）。写成 `= token`
     * 的话，任何不传 value 的调用都会把**函数本身**序列化进 Set-Cookie，
     * 得到 `ccm=(given)%20%3D%3E%20...` 这种东西——登录当场失效，
     * 而且报错发生在浏览器那头，服务端看不到任何异常。
     *
     * 现在两个调用方都显式传了值，所以这颗雷还没被踩到。正因为如此才要拆：
     * 它只会在将来某次「顺手加个调用」时炸，那时没人会想到是这里。
     */
    loginCookie(baseUrl, value = current()) {
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
