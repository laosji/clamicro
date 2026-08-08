import { randomBytes, randomUUID } from 'node:crypto'

/**
 * 配对：一次性、限时的二维码，扫一下换发一个该设备专属的令牌。
 *
 * ## 换掉的是什么
 *
 * 旧流程里**二维码本身就是凭证**——它内嵌永久令牌。于是任何时刻见过那张码
 * 的人（拍照、截图转发、投屏残留、翻浏览器历史）都永久拥有你 Mac 的执行权，
 * 而且你不会知道。
 *
 * 现在二维码里只有一个**一次性配对 id**：
 *
 *   1. `clamicro qr` 向运行中的服务申请一个 id，印成二维码
 *   2. 手机扫码打开 → 服务端校验 → 换发**该设备专属**的令牌，写进 cookie
 *   3. 该 id 当场作废，60 秒不用也作废
 *
 * ## 各自挡住什么
 *
 * **一次性**：谁先扫谁得到令牌。有人抢在你前面扫，你的扫码会失败——
 * 这是**可见的**失败，而不是悄悄多一个人有权限。
 *
 * **60 秒过期**：事后翻到截图、录屏、聊天记录里的那张码，一律无效。
 * 这是最主要的收益，也是旧设计最大的洞。
 *
 * **每设备独立令牌**：一台手机丢了单独吊销即可，不必让所有设备重新配对；
 * 审批记录能标出是哪台设备批的（旧设计里全是「phone」，没有审计线索）。
 *
 * ## 为什么没有配对码
 *
 * 想过「再输 6 位数字」的方案，去掉了。那个码显示在**和二维码同一块屏幕上**——
 * 能拍到码的人同样能拍到数字，它挡不住任何在上面这三条之外的攻击者，
 * 只是让每次配对多一步。安全性来自一次性和过期，不来自多一道输入。
 */

const TTL_MS = 60_000

export class PairingStore {
  #pending = new Map() // id -> expiresAt

  /** 开一条待配对记录。返回的 id 不是秘密——过期或用掉之后一文不值。 */
  begin(now = Date.now()) {
    this.sweep(now)
    // 12 字符，够短能进二维码；一次性 + 60 秒的前提下不需要更高的熵
    const id = randomBytes(9).toString('base64url')
    this.#pending.set(id, now + TTL_MS)
    return { id, expiresAt: now + TTL_MS, ttlMs: TTL_MS }
  }

  /**
   * 兑换。成功即**当场作废**——一次性就体现在这里。
   * 返回 true / false，调用方据此决定发令牌还是显示「链接已失效」。
   */
  redeem(id, now = Date.now()) {
    const exp = this.#pending.get(id)
    if (exp === undefined) return false
    this.#pending.delete(id) // 无论过没过期都删掉：它已经被用过一次了
    return exp > now
  }

  sweep(now = Date.now()) {
    for (const [id, exp] of this.#pending) if (exp <= now) this.#pending.delete(id)
  }

  get size() {
    return this.#pending.size
  }
}

/**
 * 已配对设备的令牌簿。
 *
 * 和「一个全局令牌」的区别只在能不能**单独**吊销和识别。丢一台手机时，
 * 旧设计只能 rotate-token 让所有设备一起重新配对；现在删一条就行。
 */
export function addDevice(config, { name, now = Date.now() } = {}) {
  config.devices ??= []

  /**
   * 设备数上限，默认 1。
   *
   * 这**不是**为了挡住攻击者——局域网是明文的，嗅到 cookie 的人直接重放就行，
   * 根本不用配对。上限真正买到的是**可检测性**：多一台就必然顶掉你，
   * 你当场发现，而不是多一个人静悄悄地也有权限。
   *
   * 用「顶掉最旧的」而不是「拒绝新的」：拒绝的话，抢先配对的人反而把你
   * 锁在外面，你还得跑到终端去清。顶替则是合法用户永远能进，而且异常
   * 一定会以「我怎么被踢了」的形式浮出来。
   */
  const max = Math.max(1, Number(config.maxDevices ?? 1))
  const evicted = []
  while (config.devices.length >= max) evicted.push(config.devices.shift())

  const device = {
    id: randomUUID().slice(0, 8),
    name: name || '未命名设备',
    token: randomBytes(32).toString('base64url'),
    createdAt: now,
    lastSeenAt: now,
  }
  config.devices.push(device)
  return { ...device, evicted }
}

export function removeDevice(config, idPrefix) {
  const before = config.devices?.length ?? 0
  const removed = (config.devices ?? []).filter((d) => d.id.startsWith(idPrefix))
  config.devices = (config.devices ?? []).filter((d) => !d.id.startsWith(idPrefix))
  return { removed, changed: (config.devices?.length ?? 0) !== before }
}
