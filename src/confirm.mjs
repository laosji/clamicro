import { spawn } from 'node:child_process'

/**
 * 配对时在 Mac 上弹一个授权确认。
 *
 * ## 为什么需要
 *
 * 在这之前，**谁扫到一张有效配对码，谁就拿到设备令牌**。一次性 + 60 秒 +
 * 顶替通知能限制窗口，但挡不住「这 60 秒里码被别人看到」——屏幕共享、投屏、
 * 旁边的镜头，以及开着公网隧道时任何拿到隧道 URL 的人。
 *
 * 加一道 Mac 本机确认，把「看到码」和「拿到令牌」拆开：前者只要能看见屏幕，
 * 后者需要有人**坐在这台 Mac 前面按一下**。
 *
 * ## 弹得出来吗
 *
 * 弹得出来，实测过。这一点必须实测，因为本项目的服务通常是**孤儿进程**
 * （PPID=1，nohup 起、被 launchd 收养），而刘海 HUD 那套 AppKit 窗口在这种
 * 进程里**画不出来**——窗口建得出来、退出码还是 0，屏幕上什么都没有。
 *
 * `display dialog` 不一样：它由 System Events 托管，实测在 PPID=1 下正常
 * 渲染、正常返回按钮。所以这条路可用，而 HUD 那条不可用。
 *
 * ## 失败一律算拒绝
 *
 * 超时、osascript 崩了、拿不到图形会话、返回看不懂的东西——全部当拒绝。
 * 这是唯一安全的方向：确认机制失效时应该**没人能配对**，而不是所有人都能。
 */

/** 等多久。到点自动拒绝。 */
export const CONFIRM_TIMEOUT_MS = 60_000

/**
 * AppleScript 字符串转义。
 *
 * 设备名来自 **User-Agent**，是完全受对方控制的一段文本，而它要被拼进一段
 * 会被执行的 AppleScript。不转义的话，一个精心构造的 UA 就能在你的 Mac 上
 * 执行任意 AppleScript——比拿到设备令牌严重得多。
 *
 * 反斜杠必须**先**处理，否则会把后面转义引号时新加的反斜杠再转一遍。
 * 控制字符换成空格：AppleScript 字面量里放不了裸换行，而且一个多行的
 * 「设备名」本身就是在试图伪造对话框的其余部分。
 */
export function escapeAppleScript(s) {
  return String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .slice(0, 120)
}

/**
 * 来源怎么描述给人看。
 *
 * 这一行是整个对话框里**唯一能帮人做判断**的信息：设备名是对方自己写的，
 * 时间点也可能是巧合，只有「它从哪来」是我们观测到的事实。隧道那一档要说得
 * 最重——那意味着请求来自公网，而不是你家的 Wi-Fi。
 */
export function describeSource({ loopback, tunnel, ip } = {}) {
  if (tunnel) return { text: '来自公网隧道（不在你的局域网内）', risky: true }
  if (loopback) return { text: '来自本机', risky: false }
  return { text: `来自局域网 ${ip || '未知地址'}`, risky: false }
}

/**
 * 把「怎么问」注入进来，好让测试打在真实决策逻辑上，而不是一份会漂移的拷贝。
 *
 * @param ask (script, timeoutMs) => Promise<string>  返回 osascript 的 stdout
 */
export function createConfirmer(ask) {
  return async function confirm({ name, loopback, tunnel, ip } = {}, timeoutMs = CONFIRM_TIMEOUT_MS) {
    const src = describeSource({ loopback, tunnel, ip })
    const title = tunnel ? '公网设备请求配对' : '新设备请求配对'
    const body = [
      escapeAppleScript(name || '未命名设备'),
      src.text,
      '',
      '允许之后，这台设备可以查看审批详情、批准或拒绝操作、向会话发消息。',
      tunnel ? '不认识这个请求就拒绝。' : '',
    ].filter(Boolean).join('\\n')

    /**
     * 「允许」是高亮的那个（default button），「拒绝」绑 Esc（cancel button）。
     *
     * 这是一个**明知的取舍**。更安全的排法是把 default 给「拒绝」，那样回车、
     * Esc、超时三条路全部走向拒绝。代价是主路径——你自己在手机上点了按钮、
     * 正等着配对——反而要多瞄一眼才知道该点哪个，而高亮的那个还是「不要」。
     *
     * 现在的分布：
     *   回车 → 允许（这是你**主动发起**的流程，回车确认符合预期）
     *   Esc  → 拒绝
     *   超时 → 拒绝（见下面对 gave up 的显式检查）
     *
     * 也就是说，**放弃的只有「误按回车」这一种情况**，而「不理它」和「按 Esc」
     * 仍然是安全的。真正要防的是「你不在场时有人悄悄配对」，那种情况下没有人
     * 会去按回车，超时自动拒绝仍然成立。
     */
    const script =
      `tell application "System Events" to display dialog "${body}" ` +
      `with title "${escapeAppleScript(title)}" ` +
      `buttons {"拒绝", "允许"} default button "允许" cancel button "拒绝" ` +
      `with icon ${tunnel ? 'caution' : 'note'} ` +
      `giving up after ${Math.round(timeoutMs / 1000)}`

    let out
    try {
      out = await ask(script, timeoutMs)
    } catch (err) {
      // 弹不出来 = 没人能确认 = 谁都不该被放进来
      console.warn(`[pair] 确认对话框失败，按拒绝处理：${err.message}`)
      return { allowed: false, reason: 'interrupted' }
    }
    // gave up:true = 没人按，超时了。必须**显式**检查：超时的返回里同时会带一个
    // 空的 button returned，只看「有没有『允许』」会把超时读成同意
    if (/gave up:\s*true/i.test(out)) {
      console.warn('[pair] 无人确认，已按拒绝处理')
      return { allowed: false, reason: 'timeout' }
    }
    const allowed = /button returned:\s*允许/.test(out)
    // 通过的那次也要留一行。只在拒绝时打日志的话，「对话框根本没弹、
    // 直接放行了」和「弹了、人点了允许」在日志里长得一模一样——
    // 而这两件事的安全含义完全相反
    console.log(`[pair] 确认对话框：${allowed ? '已允许' : '已拒绝'}（${src.text}）`)
    return { allowed, reason: allowed ? 'allowed' : 'denied' }
  }
}

/**
 * 没装 qrencode 时，把配对地址本身弹在 Mac 上。
 *
 * ## 为什么必须有这条路
 *
 * qrencode 是 Homebrew 的包，**README、install.sh、package.json 里一次都没
 * 声明过**，一台新 Mac 上大概率没有。而在这之前，缺了它的后果是：
 *
 *   · pages.mjs 只把 loginUrl 喂给 qrencode，失败就不 open —— 屏幕上什么都没有
 *   · 通知却说「扫描屏幕上的二维码」
 *   · pair.html 说「✓ 已在 Mac 上显示」
 *   · pair-expired.html 说「屏幕上会显示地址」
 *
 * 三处一起撒谎，而且没有任何线索指向「缺的是一个 Homebrew 包」。人在手机上
 * 点了配对、跑去看 Mac、什么都没有，这条路就到此为止了。
 *
 * CLI 的 `clamicro qr` 一直是对的（先打印 URL，再试 qrencode，失败提示
 * brew install）。这里只是把同样的兜底补给网页那条路。
 */
export function createUrlShower(ask) {
  return async function showUrl(url, timeoutMs = CONFIRM_TIMEOUT_MS) {
    const body = [
      '在手机浏览器里打开这个地址：',
      '',
      escapeAppleScript(url),
      '',
      '一次性，60 秒内有效。',
      '装上 qrencode 就能直接扫码：brew install qrencode',
    ].join('\\n')
    const script =
      `tell application "System Events" to display dialog "${body}" ` +
      `with title "Clamicro 配对" buttons {"知道了"} default button "知道了" ` +
      `with icon note giving up after ${Math.round(timeoutMs / 1000)}`
    try {
      await ask(script, timeoutMs)
      return true
    } catch (err) {
      // 弹不出来也不该让整个配对请求失败：配对 id 已经生效，人还可以去终端
      // 跑 clamicro qr。这里只负责把「屏幕上也没有」记下来
      console.warn(`[pair] 没能在 Mac 上显示配对地址：${err.message}`)
      return false
    }
  }
}

function askViaOsascript(script, timeoutMs) {
  return new Promise((resolve, reject) => {
    // 不能用 detached：那会 setsid 进新会话、拿不到图形会话（刘海 HUD 就是栽在
    // 这个选项上——退出码 0，屏幕上什么都没有）
    const p = spawn('osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    // AppleScript 的 giving up 到点自己会返回；这个是兜底，osascript 卡死时
    // 不能让 HTTP 请求跟着永远挂着
    const t = setTimeout(() => {
      p.kill('SIGKILL')
      reject(new Error('osascript 超时未返回'))
    }, timeoutMs + 5_000)
    p.on('error', (e) => { clearTimeout(t); reject(e) })
    p.on('exit', (code, signal) => {
      clearTimeout(t)
      // 按 Esc 时 osascript 退 1 并报 "User canceled" —— 那是拒绝，不是故障
      if (code === 0 || /User canceled/i.test(err)) return resolve(out)
      /**
       * code === null 意思是**被信号杀死**，而信号在第二个参数里。
       *
       * 之前这里只写 `(code)`，于是日志里留下的是「osascript 退出码 null」
       * ——一个零信息量的字符串，既看不出是谁杀的，也看不出是不是我们自己。
       * 排查时唯一能排除的只有本函数的超时（那条路 reject 的是另一句话）。
       *
       * 最可能的凶手是服务自己重启：spawn 没有 detached（那是刘海 HUD 踩坑后
       * 的正确选择），osascript 和服务同属一个进程组，进程组被终止时它一起走。
       */
      if (code === null) return reject(new Error(err.trim() || `osascript 被信号 ${signal} 终止`))
      reject(new Error(err.trim() || `osascript 退出码 ${code}`))
    })
  })
}

export const confirmPairing = createConfirmer(askViaOsascript)
export const showPairUrl = createUrlShower(askViaOsascript)
