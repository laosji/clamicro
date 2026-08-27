/**
 * 提醒通道。**只负责把你叫过来，不承载任何决策。**
 *
 * 现在只剩 macOS 本地通知，完全不联网。
 *
 * ## 为什么把远程推送删掉了
 *
 * 曾经有两条：ntfy 双 topic 中转（能在锁屏通知里直接批准），后来换成 Bark
 * （只发通知，点开跳局域网页面）。两条都删了，理由是同一个——
 *
 * 锁屏可达必须走 APNs，这一步没法只用 Wi-Fi。于是不管做得多克制，
 * 「有个操作在等你审批」这件事本身总要经过第三方服务器，而它换来的
 * 只是「人不在电脑边时能被叫一下」。这个产品的前提是**近场**：
 * 人在电脑边，Mac 出声就够了；人不在电脑边，收到提醒也走不完
 * 「掏手机、解锁、连上同一个 Wi-Fi、打开页面」这一串。
 *
 * 代价要说清楚：**离开电脑后没有任何东西会提醒你**。高风险操作会一直等到
 * 超时（默认 570 秒）然后被自动拒绝，那一轮任务因此失败。这是有意的默认——
 * 「人不在就不该放行 rm -rf」。想主动看的话，手机浏览器随时能打开看板。
 */

/**
 * 通知的三行结构，照抄系统自带通知的信息层级（比如「妙控键盘 / 已连接」）：
 *
 *   title     谁              固定「Clamicro」——通知中心按这个分组
 *   subtitle  发生了什么       一眼扫过去只看这行
 *   body      细节            要不要处理靠它决定
 *
 * 之前把「⚠️ my-project 需要审批」整个塞进 title、细节塞 body，结果是
 * 通知中心里一堆长短不一的标题，扫一眼分不清哪条是什么。系统通知之所以
 * 好认，是因为标题永远是「谁」，事件永远在第二行——位置固定，眼睛不用找。
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { plainText } from './text.mjs'
import { showHud } from './hud.mjs' // 声音也归它管，见 notifyNotch

export { plainText }


/**
 * 把一段文本安全地嵌进 osascript 的字符串字面量。
 *
 * **先截断，再转义——顺序不能反。** 原来是先转义再 `slice(0, 200)`：转义会让
 * 字符串变长，那一刀就可能正好落在 `\"` 这对中间，留下一个孤立的反斜杠，
 * 它会把收尾的引号吃掉，整条 AppleScript 于是语法错误：
 *
 *   osascript: 235:244: syntax error: “标识符”不能跟在““"””之后。 (-2740)
 *
 * 而通知正文就是 `ap.summary`——shell 命令原文，引号遍地。命中概率跟前 200
 * 字符里有多少引号成正比，不是理论问题。命中时这条提醒**整条消失**，
 * 正是这个文件顶上那句「通知的第一职责是送达」的反面。
 *
 * 控制字符换成空格：AppleScript 字面量里放不了裸换行。body/subtitle 走
 * plainText 时已经把 \s 压掉了，但 title 没有，而 \u0007 这类也不算 \s。
 *
 * 导出是为了让测试打在这段真实逻辑上，而不是一份会漂移的拷贝——
 * 同 confirm.mjs 的 escapeAppleScript。**那边是同一件事的第二份实现**，
 * 改这里时去看一眼：这个仓库反复栽在「同一个错误在两个地方只修了一个」上。
 */
export function escapeOsaString(s, max = 200) {
  return String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, max)
    .replace(/["\\]/g, '\\$&')
}

async function notifyBanner(msg) {
  const esc = (s) => escapeOsaString(s)
  const parts = [
    `display notification "${esc(plainText(msg.body))}"`,
    `with title "${esc(msg.title ?? 'Clamicro')}"`,
  ]
  if (msg.subtitle) parts.push(`subtitle "${esc(plainText(msg.subtitle))}"`)
  // 配对码这类「你正等着它出现」的通知不该出声——你人就在屏幕前
  if (msg.silent !== true) parts.push('sound name "Ping"')
  /**
   * 非 0 退出要**抛出来**，不能跟成功走同一条路。
   *
   * 原来两个事件都直接 resolve：osascript 语法错误、二进制不在、被安全策略
   * 拦下——全都被当成「发出去了」。于是上面 makeNotifier 里那套健康计数
   * （consecutiveFails / lastError，`/api/config` 的 notifyHealth 就靠它）
   * **对横幅这条通道从来没有生效过**：它只在 banner 自己 throw 时才记账，
   * 而这里永远不 throw。
   *
   * 这正是上面那个转义顺序 bug 能潜这么久的原因——实测扫 120 种对齐，
   * 修复前有 48 次 osascript 真的编译失败，而日志里一行都没有，
   * `[notify] xxx` 照常打印，健康记录里 failed 一直是 0。
   *
   * 说到底这就是这个文件顶上写的那条：**没抛异常不等于送达了**。刘海那条
   * 路承认了这一点（HUD 的 done(code) 认退出码），横幅这条一直没认。
   * 两个调用方都已经 catch 了（style=banner 那条 try/catch 记 fail，
   * notch 回落那条 .catch 记 fail），所以拒绝在这里是安全的。
   *
   * stderr 收下来当理由：`syntax error: … (-2740)` 比「退出码 1」有用得多。
   */
  await new Promise((resolve, reject) => {
    const p = spawn('osascript', ['-e', parts.join(' ')], { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr?.on('data', (d) => { err += d })
    p.on('close', (code) => {
      if (!code) return resolve()
      reject(new Error(err.trim().split('\n')[0] || `osascript 退出码 ${code}`))
    })
    // spawn 本身失败（osascript 不在、fork 不出来）同样是「没送达」
    p.on('error', reject)
  })
}

/**
 * 刘海胶囊。
 *
 * 层级要重排：系统通知里第一行是「谁」（固定 Clamicro），在胶囊上那是浪费——
 * 胶囊只有两行，且你一眼就知道是谁弹的。所以粗体行放 subtitle（发生了什么），
 * 灰行放 body（细节）。
 *
 * 声音得自己放：`display notification` 自带 sound name，HUD 没有。
 */
function notifyNotch(msg, onFail) {
  // 声音交给 hud.mjs 在胶囊真正出现的那一刻发。
  // 在这里单独发过——胶囊排队/失败时照响不误，于是「听见了但没看到」。
  /**
   * 横向还是纵向，按**语义**分，不按「body 是不是空的」分。
   *
   *   compact（状态）→ 横向一条。图标已经说明了是什么状态，文字只用来
   *     回答「哪个项目」，所以要短——横向那块只有 168pt，长了就截断。
   *   否则（需要你看内容）→ 纵向展开，标题 + 细节两行。
   *
   * 「已完成」曾经因为附带了一句助手消息就走纵向——它本来就是个状态，
   * 不该只因为 body 非空就撑成一整块。
   */
  showHud({
    icon: msg.icon ?? '✓',
    title: plainText(msg.compact ? (msg.short || msg.subtitle || 'Clamicro') : (msg.subtitle || msg.title || 'Clamicro')),
    subtitle: msg.compact ? '' : plainText(msg.subtitle ? msg.body : ''),
    ms: msg.ms ?? 2600,
    sound: msg.silent !== true,
    tint: msg.tint ?? 'plain',
    onFail,
  })

  /**
   * 跟着播的第二条（目前只有「完成之后报一下额度」）。
   *
   * 队列本来就是串行的，直接 push 就会排在主状态后面。**一定是静音的**：
   * 同一件事响两声只会让人以为出了两件事。
   */
  if (msg.after) {
    showHud({
      icon: msg.after.icon ?? '◔',
      title: msg.after.short ?? '',
      subtitle: '',
      ms: msg.after.ms ?? 1600,
      sound: false,
      tint: msg.after.tint ?? 'info',
    })
  }
}

/**
 * 两个通道做成可注入的参数，是为了能测「样式到底走没走到对应的通道」。
 * 这一层出过的 bug 恰好是这个形状：刘海胶囊做完了，但 notify 压根没调它——
 * 代码在，注释在，就是没接线，而且不报任何错。
 */
/**
 * 系统「专注模式 / 勿扰」开着吗。
 *
 * 读 macOS 自己的断言文件。开着任一专注模式时 storeAssertionRecords 非空，
 * 关掉就没了。没有公开 API，但这个文件是稳定的，而且**纯读文件、不联网、
 * 不起子进程**——放在 hook 链路上零成本。
 *
 * 读不到就当没开：宁可多响一声，也别因为一个探测失败而把提醒整个吞掉。
 */
function focusActive() {
  try {
    const p = join(homedir(), 'Library', 'DoNotDisturb', 'DB', 'Assertions.json')
    const d = JSON.parse(readFileSync(p, 'utf8'))
    return (d.data ?? []).some((b) => Array.isArray(b?.storeAssertionRecords) && b.storeAssertionRecords.length)
  } catch {
    return false
  }
}

/**
 * 提醒通道的健康状况。
 *
 * ## 为什么需要
 *
 * 所有调用点都是 `notify(...).catch(() => {})` ——**这是对的**，提醒失败绝不能
 * 影响 hook 链路，工具调用还等着那个请求返回。但代价是：通道整个死掉时，
 * 这件事没有任何地方记着。
 *
 * 后果分两种，都很难自己想到：
 *   · 高危审批：全部走到 180 秒超时被拒。表现是「Claude 老是被拒绝」，
 *     而真正的原因是你压根没收到过通知。
 *   · 普通审批：10 秒后照样放行。那 10 秒本来是留给你的机会，
 *     而机会根本没送到你手上。
 *
 * 换句话说：**审批那一端已经是 fail-closed 的（高危无人处理即拒绝），
 * 但通道这一端是静默的。**「无法确认保护机制在工作时，不要假装它在工作」
 * ——这条对通道同样成立。
 *
 * ## 只记事实，不下判断
 *
 * 特意不提供「通道是否正常」这种布尔值。刘海那条路的教训就摆在上面：
 * 孤儿进程里窗口建得出来、退出码 0、屏幕上什么都没有。**没抛异常不等于
 * 送达了**。所以这里只记录能确凿知道的事——哪次抛了、抛了什么、连续几次，
 * 让人自己判断。
 */
const health = {
  ok: 0,
  failed: 0,
  /** 连续失败次数。一次成功清零——偶发一次和通道死掉是两回事 */
  consecutiveFails: 0,
  lastError: null,
  lastErrorAt: null,
  lastOkAt: null,
}

/** 取一份快照。返回副本，免得调用方改坏内部状态 */
export function notifyHealth() {
  return { ...health }
}

/** 测试用：同进程里多个用例之间要能互不干扰 */
export function resetNotifyHealth() {
  Object.assign(health, {
    ok: 0, failed: 0, consecutiveFails: 0, lastError: null, lastErrorAt: null, lastOkAt: null,
  })
}

function recordOk(now = Date.now()) {
  health.ok += 1
  health.consecutiveFails = 0
  health.lastOkAt = now
}

function recordFail(err, now = Date.now()) {
  health.failed += 1
  health.consecutiveFails += 1
  health.lastError = String(err?.message ?? err ?? '未知错误').slice(0, 200)
  health.lastErrorAt = now
}

export function makeNotifier(config, { notch = notifyNotch, banner = notifyBanner, focus = focusActive } = {}) {
  return async function notify(msg) {
    if (!config.notify.macNotify) return

    /**
     * 专注模式下**只静音，不隐藏**。
     *
     * 开了专注是「别打扰我」，不是「别让我知道」——尤其待审批那条，
     * 藏起来的代价是任务卡到超时被拒。系统通知走的也是这个逻辑：
     * 专注模式压的是声音和横幅，不是事件本身。
     */
    if (config.notify.respectFocus !== false && focus()) {
      msg = { ...msg, silent: true }
    }
    // 认不出来就按默认走。配置里打个错字导致**一声不响什么都不弹**，
    // 是这个项目最不能接受的故障形态——你会以为它在守着。
    const raw = config.notify.style ?? 'notch'
    const style = ['notch', 'banner', 'both'].includes(raw) ? raw : 'notch'
    if (style !== raw) console.warn(`[notify] 未知样式「${raw}」，按 notch 处理`)

    /**
     * 进入时的失败计数快照，用来判断「这一次有没有出问题」。
     *
     * 不能拿 health.consecutiveFails 判——那是**跨调用累积**的：只要以前失败过
     * 一次，它就永远大于 0，之后每一次成功都会被判成失败，通道再也「恢复」不了。
     * 我第一版就是这么写的。
     *
     * 回落是异步的，可能在 notify 返回之后才失败。那种情况这里会先记一次 ok、
     * 稍后再记一次 fail —— 这是准确的：那一刻我们确实还不知道它会失败。
     */
    const failedBefore = health.failed

    // 每个通道各自 try：'both' 下刘海挂了，横幅还得发出去——
    // 后者才是你不在屏幕前时唯一会留痕的那条。
    // 提醒失败绝不能影响 hook 链路，工具调用还等着这个请求返回。
    if (style === 'notch' || style === 'both') {
      /**
       * 刘海画不出来时**自动回落到系统横幅**。
       *
       * 为什么必须有这条：服务是被 nohup 起来的孤儿进程（PPID=1），拿不到
       * 图形会话，窗口建得出来但永远不参与合成。同一份代码在终端里跑得好好的，
       * 从服务里发就什么都没有——而声音照响，于是表现成「只听见声音」。
       *
       * 与其让用户在「好看但收不到」和「难看但收得到」之间自己选，
       * 不如画得出来就用刘海、画不出来就退回横幅。**通知的第一职责是送达。**
       */
      // Promise.resolve 包一层：banner 不保证返回 Promise（测试里就是同步桩），
      // 直接 .catch 会在回落路径上再炸一次——而这条路径本来就是给失败兜底的
      const fallback = style === 'both' ? undefined : () => Promise.resolve(banner(msg)).catch((err) => {
        // 回落也失败 = 这一条**哪个通道都没出去**，是最该被记下的一种
        recordFail(err)
        console.error(`[notify] 回落横幅也失败: ${err.message}`)
      })
      try {
        notch(msg, fallback) // 不阻塞，HUD 自己 detach
      } catch (err) {
        recordFail(err)
        console.error(`[notify] 刘海失败: ${err.message}`)
        fallback?.()
      }
    }
    if (style === 'banner' || style === 'both') {
      try {
        await banner(msg)
      } catch (err) {
        recordFail(err)
        console.error(`[notify] 横幅失败: ${err.message}`)
      }
    }
    // 走到这里只说明「没有通道抛异常」。刘海那条路抛不抛都不代表画出来了
    // （孤儿进程里退出码 0、屏幕上什么都没有），所以这不是「已送达」，
    // 只是「没有已知失败」——健康记录里的字段名也是照这个含义取的
    if (health.failed === failedBefore) recordOk()
    console.log(`[notify] ${msg.subtitle ?? msg.title}`)
  }
}
