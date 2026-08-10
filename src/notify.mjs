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
import { showHud } from './hud.mjs' // 声音也归它管，见 notifyNotch

async function notifyBanner(msg) {
  // osascript 的字符串要转义引号和反斜杠，否则命令会被截断
  const esc = (s) => String(s ?? '').replace(/["\\]/g, '\\$&').slice(0, 200)
  const parts = [`display notification "${esc(msg.body)}"`, `with title "${esc(msg.title ?? 'Clamicro')}"`]
  if (msg.subtitle) parts.push(`subtitle "${esc(msg.subtitle)}"`)
  // 配对码这类「你正等着它出现」的通知不该出声——你人就在屏幕前
  if (msg.silent !== true) parts.push('sound name "Ping"')
  await new Promise((resolve) => {
    const p = spawn('osascript', ['-e', parts.join(' ')], { stdio: 'ignore' })
    p.on('close', resolve)
    p.on('error', resolve)
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
function notifyNotch(msg) {
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
    title: msg.compact ? (msg.short || msg.subtitle || 'Clamicro') : (msg.subtitle || msg.title || 'Clamicro'),
    subtitle: msg.compact ? '' : (msg.subtitle ? msg.body : ''),
    ms: msg.ms ?? 2600,
    sound: msg.silent !== true,
    tint: msg.tint ?? 'plain',
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

    // 每个通道各自 try：'both' 下刘海挂了，横幅还得发出去——
    // 后者才是你不在屏幕前时唯一会留痕的那条。
    // 提醒失败绝不能影响 hook 链路，工具调用还等着这个请求返回。
    if (style === 'notch' || style === 'both') {
      try {
        notch(msg) // 不阻塞，HUD 自己 detach
      } catch (err) {
        console.error(`[notify] 刘海失败: ${err.message}`)
      }
    }
    if (style === 'banner' || style === 'both') {
      try {
        await banner(msg)
      } catch (err) {
        console.error(`[notify] 横幅失败: ${err.message}`)
      }
    }
    console.log(`[notify] ${msg.subtitle ?? msg.title}`)
  }
}
