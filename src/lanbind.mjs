import { allowedHosts } from './http/security.mjs'

/**
 * 局域网暴露面的开关：**此刻把服务露在哪个地址上，以及 Host 白名单跟着它走**。
 *
 * ## 为什么值得单独一个文件
 *
 * 这段逻辑原来内联在 server.mjs 里，紧挨着 `createServer` 和 `watchNetwork`，
 * 于是**测不了**：判据是 `detectLanIp()`（读 os.networkInterfaces）和
 * `fingerprint()`（spawn route/arp/ipconfig），前者连换 PATH 都伪造不了。
 *
 * 代价是实打实的：这里出过两个 bug，两个都只有代码审查发现，一条测试都没红。
 *
 *   · **收缩收错了对象** —— 原来写 `stopListening(config.lanIp)`，而
 *     `config.lanIp` 是 loadConfig 在**启动那一刻**探测的值、之后再没变过。
 *     换过一次 IP 之后，还活着的套接字已经不是它了：关掉一个早就没用的旧
 *     socket，新地址上的监听原样留着，而日志和通知照样说「已摘掉局域网监听」。
 *     **界面说的和事实相反，方向还偏向不安全那侧。**
 *   · **白名单没跟上** —— ALLOWED_HOSTS 启动时算死，里面装的是旧 IP。
 *     于是「已恢复局域网监听」那条日志之后，手机连过来 Host 对不上，
 *     hostAllowed 一律 403。日志说恢复了，实际连不上。
 *
 * 两个 bug 同源：**「监听在哪」和「白名单认哪」是同一件事，分两处写就会有一处
 * 忘记跟。** 所以这里把它们收进 `rebind()` 一个函数，外面没有别的入口。
 *
 * ## 为什么不直接改 config.lanIp
 *
 * `/healthz` 的 `stale` 判据是 `detectLanIp() !== config.lanIp`，它靠这个值
 * 保持「旧」才成立。改它等于把「地址变了 → 下次开会话自动重启到新地址」
 * 这条自愈悄悄关掉，而深链基址（baseUrl / altUrl）本来就只在启动时算，
 * 不重启还是旧的。所以另存一个 `#bound`：谁真的挂着，收缩时就关谁。
 *
 * ## 只做收缩，不做扩张
 *
 * 新网络不可信就摘掉局域网监听；要重新暴露得显式 `clamicro trust` 再重启。
 * 「失败即收缩」比「自动恢复」安全。
 *
 * 但**恢复必须和收缩对称**：换回一个已信任的网络时要真的把监听装回去。
 * 以前那条分支只打日志，于是任何一次误判（哪怕下一秒就纠正）都会让局域网
 * 监听永久消失到进程重启为止——日志里「未被信任」「已信任」反复横跳，
 * 而实际状态一路单向退化成只剩回环。**只有一半的策略不是保守，是坏掉。**
 */

/**
 * @param deps.config          读 lanIp / port / bind / tailscaleIp / localHost / tunnelUrl
 * @param deps.listenOn        (host) => void   幂等
 * @param deps.stopListening   (host) => void   不在监听就什么都不做
 * @param deps.applyAllowedHosts (Set) => void  把新白名单交给 handler
 * @param deps.detectLanIp     () => string|null
 * @param deps.fingerprint     (ip) => {id, label, …}
 * @param deps.isTrusted       (config, fp) => boolean
 * @param deps.notify          async，收缩时提醒。失败不许影响主流程
 */
export function createLanGate({
  config,
  listenOn,
  stopListening,
  applyAllowedHosts,
  detectLanIp,
  fingerprint,
  isTrusted,
  notify = async () => {},
  log = console.log,
  warn = console.warn,
}) {
  /** 此刻**真正**对外暴露的那个局域网地址。null = 只剩回环（和 Tailscale） */
  let bound = null
  /** 上一次判定过的网络指纹 id。用来跳过「同一个网络又抖了一下」 */
  let netId = null

  /**
   * 把局域网监听挪到 ip 上（null = 全摘掉），并让 Host 白名单跟着走。
   *
   * **两件事必须在同一个地方做完。** 见文件头：分两处写就是这次修的两个 bug。
   */
  function rebind(ip) {
    const next = ip || null
    if (bound && bound !== next) stopListening(bound)
    bound = next
    // 白名单按「现在暴露在哪」重算。摘掉之后旧 IP 也一并移出——那个地址上
    // 已经没有监听了，留在白名单里只是一条和事实对不上的记录
    applyAllowedHosts(allowedHosts({ ...config, lanIp: bound }))
    if (bound) listenOn(bound)
  }

  return {
    /** 测试和排查用：此刻暴露在哪个局域网地址上 */
    bound: () => bound,

    /**
     * 启动时定调。传进来的是已经过完信任闸门的绑定列表。
     *
     * 不在这里重新判信任：启动那一次的判定还要决定日志、通知和 weakNote，
     * 那些留在 server.mjs。这里只接收结论。
     */
    start({ lanIp, netId: id, bindHosts }) {
      netId = id ?? null
      bound = lanIp && bindHosts.includes(lanIp) ? lanIp : null
      // 启动时的白名单已经由 server.mjs 算过一次，这里不重复 apply——
      // bound 和 config.lanIp 此刻要么相等、要么 bound 是 null 而那个 IP
      // 本来就没在监听（未信任网络），两种情况下重算都不会改变结论
    },

    /**
     * 网络变了。这就是 watchNetwork 的回调。
     *
     * @returns 'unknown' | 'same' | 'restored' | 'moved' | 'shrunk' | 'already-shrunk'
     *   返回值只给测试和日志用，调用方不必看。
     */
    onNetworkChange() {
      const ip = detectLanIp()
      const fp = fingerprint(ip)

      /**
       * **拿不到网关 ≠ 换到了陌生网络。**
       *
       * fingerprint 取不到默认路由时返回 `id: null`（未联网）。全隧道 VPN
       * 周期性重连、Wi-Fi 抖一下，都会制造这么一个瞬间。以前把 null 当成
       * 「一个不认识的新网络」，于是**摘掉局域网监听**——手机当场连不上，
       * 而 `networks` 还显示当前网络已信任，看不出任何异常。
       *
       * 收缩是有代价的动作，不能在证据不足时执行。信息缺失就什么都不做，
       * 等下一次事件——网络真变了，下一次一样判得出来。
       */
      if (!fp.id) return 'unknown'
      if (fp.id === netId) return 'same'
      netId = fp.id

      if (isTrusted(config, fp)) {
        log(`[clamicro] 网络变为「${fp.label}」（已信任）`)
        if (!ip || ip === bound) return 'same'
        const was = bound
        rebind(ip)
        log(`[clamicro] 已${was ? '切换' : '恢复'}局域网监听 ${ip}:${config.port}`)
        if (ip !== config.lanIp) {
          log(`[clamicro] 地址变了，新开一个 Claude Code 会话会自动重启到新地址`)
          log(`[clamicro] 之后重新生成二维码： npx clamicro qr`)
        }
        return was ? 'moved' : 'restored'
      }

      // 判据是「此刻真的挂着的那个」，不是启动时探到的那个。见文件头
      const wasExposed = bound !== null
      rebind(null)
      warn(`[security] 网络变为「${fp.label}」，未被信任${wasExposed ? '，已摘掉局域网监听' : ''}`)
      warn(`[security] 确认可信后执行： npx clamicro trust`)
      if (wasExposed) {
        notify({
          title: 'Clamicro',
          subtitle: '已收缩到本机',
          body: `换到了未信任的网络「${fp.label}」，局域网访问已关闭。确认可信后执行 npx clamicro trust`,
          level: 'timeSensitive',
          group: 'clamicro-net',
        })?.catch?.(() => {})
      }
      return wasExposed ? 'shrunk' : 'already-shrunk'
    },
  }
}
