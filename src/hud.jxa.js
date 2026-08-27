// 刘海位置的胶囊提示。
// 由 src/hud.mjs 通过 `osascript -l JavaScript` 调起，参数：图标 标题 副标题 毫秒
//
// 系统连接外设时那条 HUD 由 BluetoothUIService 绘制，第三方没有 API 能投递，
// 所以这里用 JXA 的 ObjC 桥手搓一个。
//
// ## 几何和形状抄自两个开源实现
//
// MrKai77/DynamicNotchKit 和 Lakr233/NotchNotification 各自独立写的，
// 关键几处结论一致，值得照做：
//
//   · 刘海宽度 = frame.width - auxiliaryTopLeftArea.width - auxiliaryTopRightArea.width
//     这台机器实测 185pt。之前是硬编码 184——碰巧接近，但换台机器就错。
//   · 刘海高度 = safeAreaInsets.top（33pt）。两者都非空才算「这块屏有刘海」。
//   · 屏幕要选**内置屏**（CGDisplayIsBuiltin），不是 mainScreen。mainScreen 是
//     「有 key window 的那块」，这个进程压根没有窗口，接了外接显示器就会跑偏。
//   · 顶部两个角是**反向曲线**（向外张开），不是直角也不是普通圆角。这是
//     胶囊看起来「从刘海里长出来」而不是「贴在屏幕上」的唯一原因。
//     DynamicNotchKit 的展开态用 top 15 / bottom 20。
//   · 窗口层级用 screenSaver（1000），比 status 高，全屏应用之上也能看见。
ObjC.import('AppKit')
ObjC.import('QuartzCore')
ObjC.import('stdlib') // $.exit —— app.terminate 只能退 0，而失败必须是非零

/** 反向曲线的顶角半径 / 普通圆角的底角半径，取自 DynamicNotchKit 的展开态 */
const TOP_R = 15
const BOT_R = 20

/**
 * 状态色。用 Apple 深色模式下的系统色，不是随手调的——
 * 这些值是为「深色背景上要看得清、但不刺眼」定的，而胶囊固定纯黑。
 */
const TINTS = {
  ok: [0.196, 0.843, 0.294], // systemGreen  完成
  warn: [1.0, 0.839, 0.039], // systemYellow 额度、需要注意
  danger: [1.0, 0.271, 0.227], // systemRed  出错、高风险
  info: [0.392, 0.824, 1.0], // systemTeal   配对之类的中性事件
  plain: [1, 1, 1],
}

function run(argv) {
  const [icon = '✓', title = '', subtitle = '', msArg = '2600', tintName = 'plain'] = argv
  const ms = Number(msArg) || 2600
  const tint = TINTS[tintName] || TINTS.plain

  $.NSApplication.sharedApplication.setActivationPolicy($.NSApplicationActivationPolicyAccessory)

  const screen = pickScreen()
  const frame = screen.frame
  const notch = notchSize(screen)
  // 没刘海的机器（外接屏、老 Mac）退回菜单栏高度，视觉上等价
  const topInset = notch.h || menubarHeight(screen) || 24

  /**
   * ## 两种形态
   *
   * 有没有第二行，决定的不只是高度，而是**整条提示往哪个方向长**：
   *
   *   紧凑（只有一行状态）→ **横向**。高度就是刘海本身，内容摆在刘海
   *     **两侧**：图标在左、文字在右。刘海物理上遮住中间那块，所以中间
   *     不能放东西——这也正是 Dynamic Island 紧凑态的做法。
   *
   *   展开（带细节）→ **纵向**。宽度先快速到位，然后往下掉出一整块，
   *     内容压在刘海下方。
   *
   * 两种形态的动画曲线也不同，见下面的 animate：横向只动宽度，纵向以
   * 高度为主。让「这是个状态」和「这需要你看一眼」在余光里就能分开。
   */
  const hasSub = subtitle.length > 0
  const notchW = notch.w || 185

  // 紧凑态：高度贴着刘海，两侧各留出一块放内容
  const SIDE_ICON = 38
  /**
   * 文字区按**实际字宽**算，不用固定值。
   *
   * 固定 168pt 的话，「clamicro」这种短标签也要占满，整条横着拉得老长，
   * 而横向态的意义就是「一眼扫过、不占地方」。这里先量一遍再定宽。
   *
   * 上限 150：再长就该用纵向了；下限 54：太窄了胶囊两头不对称，难看。
   */
  const SIDE_TEXT = hasSub ? 0 : Math.min(150, Math.max(54, measureText(title, 12.5) + 18))
  // 展开态：内容在刘海下方
  const contentH = 46
  /** 徽章直径 + 它和文字之间的间距 */
  const BADGE = 26
  const BADGE_GAP = 12
  const PAD_X = TOP_R + 16

  /**
   * 展开态的宽度也按**实际字宽**算，和紧凑态一样。
   *
   * 原来是写死的 `max(notchW + 150, 340)`。短内容（「已完成」「已批准」）撑不满，
   * 右边空出一大块，胶囊看着像没画完；长内容又在 340 处被硬截断，明明还有
   * 屏幕却不给。两头都不对。
   *
   * 下限保证比刘海明显宽（否则那两个外张的角挤在一起，形状认不出来），
   * 上限 460 避免横贯半个屏幕——那时该考虑的是缩短文案，不是加宽窗口。
   */
  const textW = hasSub
    ? Math.min(300, Math.max(118, Math.max(measureText(title, 12.5), measureText(subtitle, 11)) + 6))
    : 0

  const H = hasSub ? topInset + contentH : Math.max(topInset, 30)
  const W = hasSub
    ? Math.min(460, Math.max(notchW + TOP_R * 2 + 76, PAD_X * 2 + BADGE + BADGE_GAP + textW))
    : SIDE_ICON + notchW + SIDE_TEXT + TOP_R * 2

  const win = $.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer(
    $.NSMakeRect(0, 0, W, H),
    $.NSWindowStyleMaskBorderless,
    $.NSBackingStoreBuffered,
    false,
  )
  // screenSaver 级：比菜单栏和 status 都高
  win.setLevel(typeof $.NSScreenSaverWindowLevel === 'number' ? $.NSScreenSaverWindowLevel : 1000)
  win.setOpaque(false)
  win.setBackgroundColor($.NSColor.clearColor)
  win.setHasShadow(false) // 有阴影就露馅了：刘海本身不投影
  win.setIgnoresMouseEvents(true) // 不能挡住底下的东西——它只是个提示
  /**
   * FullScreenAuxiliary 不能少。
   *
   * 只写 CanJoinAllSpaces | Stationary 的话，**全屏 App 之上不会显示**——
   * 全屏窗口自己占一个 Space，只有带 FullScreenAuxiliary 的窗口才允许浮在
   * 上面。用户报的「有时候只有提示声，没有通知」里的「有时候」，很可能就是
   * 「当时正在用全屏的浏览器/编辑器」。声音是另一个进程放的，照响不误。
   *
   * IgnoresCycle：别让它出现在 Cmd-Tab / 窗口循环里，它只是个提示。
   */
  win.setCollectionBehavior(
    $.NSWindowCollectionBehaviorCanJoinAllSpaces |
      $.NSWindowCollectionBehaviorStationary |
      $.NSWindowCollectionBehaviorFullScreenAuxiliary |
      $.NSWindowCollectionBehaviorIgnoresCycle,
  )
  win.setAlphaValue(0)

  /**
   * **强制深色**，不跟随系统外观。
   *
   * 刘海是物理黑块。浅色外观下如果胶囊也是浅的，两者拼在一起会露出一条
   * 明显的分界，看着像贴了张纸。深色才能和刘海连成一体——这也是系统那条
   * HUD 在浅色模式下依然是深色的原因。
   */
  win.setAppearance($.NSAppearance.appearanceNamed($.NSAppearanceNameVibrantDark))

  /**
   * **纯黑实心，不能用毛玻璃。**
   *
   * 一开始用的是 NSVisualEffectView + HUDWindow 材质，结果胶囊会透出壁纸，
   * 呈半透明蓝灰色，和物理刘海的纯黑拼在一起有明显色差——一眼就看出是
   * 两个东西贴着。DynamicNotchKit 也是这么处理的：刘海态填 .black，
   * 毛玻璃只留给没有刘海时的浮窗态。
   */
  const body = $.NSView.alloc.initWithFrame($.NSMakeRect(0, 0, W, H))
  body.setWantsLayer(true)
  // 必须用 CGColorCreateGenericRGB，不能用 $.NSColor.blackColor.CGColor：
  // 后者返回的是 autorelease 的 CGColor，JXA 不会替你持有，等图层真正绘制时
  // 它已经悬空了——进程被 SIGKILL，130ms 就没，stderr 一个字都没有。
  body.layer.setBackgroundColor($.CGColorCreateGenericRGB(0, 0, 0, 1))
  const mask = $.CAShapeLayer.layer
  body.layer.setMask(mask)
  win.contentView.addSubview(body)

  // 内容装在一个容器里，动画期间整体钉在窗口顶部——否则窗口长高时文字会漂
  const box = $.NSView.alloc.initWithFrame($.NSMakeRect(0, 0, W, H))
  body.addSubview(box)

  const label = (text, rect, size, weight, alpha, rgb = null) => {
    const f = $.NSTextField.alloc.initWithFrame(rect)
    f.setStringValue(text)
    f.setBezeled(false)
    f.setDrawsBackground(false)
    f.setEditable(false)
    f.setSelectable(false)
    f.setFont($.NSFont.systemFontOfSizeWeight(size, weight))
    // 强制指定颜色：这个面板固定深色，用 labelColor 会跟随系统而在浅色下变黑。
    // rgb 给了就用状态色，没给就是白色。
    const [r, g, b] = rgb ?? [1, 1, 1]
    f.setTextColor($.NSColor.colorWithSRGBRedGreenBlueAlpha(r, g, b, alpha))
    f.setLineBreakMode($.NSLineBreakByTruncatingTail)
    box.addSubview(f)
    return f
  }

  if (hasSub) {
    // ── 展开态：内容压在刘海**下方** ──
    // 刘海那一条被摄像头占着，放字会被切掉。左右各让开 TOP_R，
    // 那是反向曲线张开的地方，压上去也会被切。
    const midY = contentH / 2

    /**
     * 图标装进一个染色的圆形徽章里。
     *
     * 一个 20pt 的 ✓ 在纯黑上太轻，扫一眼抓不住；圆形色块是**形状**，
     * 余光里先认出形状再读字。淡底 + 同色字形，和手机端结果页那个对勾圈
     * 是同一套语汇——两端看到的应该是同一个东西。
     */
    const badge = $.NSView.alloc.initWithFrame(
      $.NSMakeRect(PAD_X, midY - BADGE / 2, BADGE, BADGE))
    badge.setWantsLayer(true)
    badge.layer.setCornerRadius(BADGE / 2)
    // 同样必须用 CGColorCreateGenericRGB —— NSColor.CGColor 是 autorelease 的，
    // 等图层真正绘制时已经悬空，进程被 SIGKILL 且 stderr 一个字都没有
    badge.layer.setBackgroundColor($.CGColorCreateGenericRGB(tint[0], tint[1], tint[2], 0.18))
    badge.layer.setBorderWidth(1)
    badge.layer.setBorderColor($.CGColorCreateGenericRGB(tint[0], tint[1], tint[2], 0.45))
    box.addSubview(badge)

    centeredGlyph(box, icon, PAD_X + BADGE / 2, midY, 14, tint)

    const textX = PAD_X + BADGE + BADGE_GAP
    const tw = W - textX - PAD_X
    /**
     * **标题不染色。**
     *
     * 它多半是项目名（clamicro、value-engine），把项目名染成绿色等于说
     * 「这个名字是绿的」——而状态是这一条消息的属性，不是那个名字的属性。
     * 颜色全部交给徽章：一个色块比一行彩色文字更容易在余光里认出来，
     * 而且 12.5pt 的彩色小字在纯黑上本来就比白字难读。
     */
    label(title, $.NSMakeRect(textX, midY + 1, tw, 17), 12.5, $.NSFontWeightSemibold, 1)
    // 细节行更淡：它多半是命令原文或一句结果，是给「想多知道一点」的人看的
    label(subtitle, $.NSMakeRect(textX, midY - 17, tw, 15), 11, $.NSFontWeightRegular, 0.58)
  } else {
    // ── 紧凑态：内容摆在刘海**两侧** ──
    // 中间那块是物理刘海，放什么都看不见。所以图标贴左、文字贴右，
    // 刘海正好夹在中间——这也是 Dynamic Island 紧凑态在做的事。
    const midY = H / 2
    /**
     * 紧凑态的文字**要**染色，展开态的标题不染——这不矛盾。
     *
     * 紧凑态那行字本身就是状态（「已完成」「运行中」），染色是给它上色；
     * 展开态的标题是项目名（clamicro、value-engine），染色等于说「这个名字
     * 是绿的」。规矩是：**给状态上色，不给名字上色。**
     *
     * 注意 emoji（⚠️ ⚡️ 📱）自带颜色不受 textColor 影响，只有 ✓ ✕ 这类
     * **字形**图标会跟着变——所以状态类的图标优先用字形。
     */
    // 居中放在左侧那一块里（0 到 TOP_R + SIDE_ICON），不写死偏移：
    // 写死的那个 36 在 53pt 宽的空当里偏右，看着像没对齐
    centeredGlyph(box, icon, (TOP_R + SIDE_ICON) / 2, midY, 17, tint)
    const textX = TOP_R + SIDE_ICON + notchW
    const t = label(title, $.NSMakeRect(textX, midY - 9, SIDE_TEXT - 12, 18), 12.5, $.NSFontWeightMedium, 1, tint)
    t.setAlignment($.NSTextAlignmentLeft)
  }

  /**
   * 胶囊轮廓。顶部两角向外张开（反向曲线），底部两角是普通圆角。
   *
   * 坐标系是 CALayer 的（y 向上，(0,0) 在左下）。DynamicNotchKit 的原版写在
   * SwiftUI 坐标系里（y 向下），所以这里上下是镜像过的。
   */
  const shape = (w, h) => {
    // 半径必须按当前高度夹住。紧凑态只有 33pt 高，而 TOP_R + BOT_R = 35——
    // 不夹的话路径自交，画出来是一团乱七八糟的东西。
    const tr = Math.min(TOP_R, h / 2)
    const br = Math.min(BOT_R, h - tr, w / 2 - tr)
    const p = $.CGPathCreateMutable()
    $.CGPathMoveToPoint(p, null, 0, h)
    $.CGPathAddQuadCurveToPoint(p, null, tr, h, tr, h - tr) // 左上：外张
    $.CGPathAddLineToPoint(p, null, tr, br)
    $.CGPathAddQuadCurveToPoint(p, null, tr, 0, tr + br, 0) // 左下：普通圆角
    $.CGPathAddLineToPoint(p, null, w - tr - br, 0)
    $.CGPathAddQuadCurveToPoint(p, null, w - tr, 0, w - tr, br) // 右下
    $.CGPathAddLineToPoint(p, null, w - tr, h - tr)
    $.CGPathAddQuadCurveToPoint(p, null, w - tr, h, w, h) // 右上：外张
    $.CGPathCloseSubpath(p)
    return p
  }

  /**
   * 紧凑态左侧那块的宽度（窗口左边缘到刘海左边缘）。
   *
   * 终态是 TOP_R + SIDE_ICON —— 内容的落点（图标、textX）全是按这个数算的。
   * 动画中途按进度插值，这样刘海区在整个展开过程里都**贴着物理刘海不动**，
   * 只有两侧往外推。
   */
  const leftGapAt = (w) => (W === W0 ? TOP_R + SIDE_ICON : TOP_R + SIDE_ICON * Math.min(1, Math.max(0, (w - W0) / (W - W0))))

  /**
   * 把窗口摆到内置屏顶端，并按当前尺寸重画轮廓。
   *
   * ## 紧凑态为什么不能居中
   *
   * 原来两种形态都是 `(frame.width - w) / 2`。而紧凑态的内容是按
   * 「刘海从窗口左边 TOP_R + SIDE_ICON 处开始」算的（textX 就是这么写的）。
   * 窗口一居中，刘海在窗口里的**实际**位置变成 (W - notchW) / 2 —— 两者只有
   * 在 SIDE_ICON === SIDE_TEXT 时才相等，而 SIDE_TEXT 是按字宽算的（54–150），
   * 几乎永远不等。
   *
   * 差值是 (SIDE_TEXT - SIDE_ICON) / 2，全部落在文字左边被物理刘海压住：
   * 短标签（SIDE_TEXT=54）压掉 8pt，长标签（150）压掉 56pt。真机上就是
   * 「刘海内容有点被遮挡」。
   *
   * 修法是**别居中**：按刘海左边缘对齐，胶囊保持窄。改成两侧等宽也能修，
   * 但那会让长文案时的胶囊平白宽出一截，而紧凑态的意义就是「一眼扫过、
   * 不占地方」。
   *
   * 展开态仍然居中：它的内容压在刘海**下方**，本来就是对称的。
   */
  const alignNotch = !hasSub && notch.w > 0 && notch.l > 0
  const layout = (w, h) => {
    win.setFrameDisplay(
      $.NSMakeRect(
        alignNotch
          ? frame.origin.x + notch.l - leftGapAt(w)
          : frame.origin.x + (frame.size.width - w) / 2,
        frame.origin.y + frame.size.height - h, // 贴住屏幕最顶端——刘海就在那里
        w,
        h,
      ),
      true,
    )
    body.setFrame($.NSMakeRect(0, 0, w, h))
    mask.setPath(shape(w, h))
    // 容器钉在顶部：窗口从刘海高度长到全高时，文字不能跟着往下滑。
    // 横向同理：对齐模式下容器跟着刘海走，别再按窗口居中——否则内容会在
    // 展开过程中相对刘海滑动，而它正是我们要钉住的那个参照物
    box.setFrame($.NSMakeRect(
      alignNotch ? leftGapAt(w) - (TOP_R + SIDE_ICON) : (w - W) / 2,
      h - H,
      W,
      H,
    ))
  }

  // 起始形态就是刘海本身：从它「长出来」，而不是凭空淡入。
  // 这是这类 HUD 最容易辨认的一点，也是纯 alpha 淡入做不出来的。
  const W0 = notchW + TOP_R * 2
  // 紧凑态的高度全程等于终高（就是刘海），起点终点一致才不会有竖直方向的跳动
  const H0 = hasSub ? topInset : H
  layout(W0, H0)
  win.orderFrontRegardless

  /**
   * ## 必须跑真正的 NSApp.run，不能手动步进 runloop
   *
   * 这里踩过一个两天都没看出来的坑。原来的写法是
   * `NSRunLoop.currentRunLoop.runUntilDate(...)` 一帧帧推，注释还写着
   * 「这个进程没有正常的 runloop 驱动，动画 API 排的队不会被执行」——
   * 因果正好搞反了。
   *
   * 实测：那样写窗口**建得出来**（`isVisible=true`，WindowServer 也发了
   * windowNumber），但屏幕上什么都没有，截图也截不到。换成 `NSApp.run`
   * 之后画面就出来了。
   *
   * （原来这段拿 occlusionState 的 visible 位当证据，说它从 8192 变成 8194。
   * 后来重测发现那个量不可信：前台和孤儿进程都稳定报 8192，区分不了两者。
   * 结论没变——要跑 NSApp.run——但证据换成了**屏幕截图**：截得到就是画出来了。）
   *
   * 也就是说：**AppKit 窗口要参与合成，得有 AppKit 自己的事件循环在跑**，
   * 光转 runloop 不够。动画因此改成 NSTimer 驱动的状态机。
   */
  const easeOutBack = (t) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2)
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3)

  const IN = 0.34
  const OUT = 0.26
  const start = Date.now()
  const app = $.NSApplication.sharedApplication

  $.NSTimer.scheduledTimerWithTimeIntervalRepeatsBlock(1 / 60, true, (timer) => {
    const t = (Date.now() - start) / 1000

    if (t < IN) {
      const k = t / IN
      win.setAlphaValue(Math.min(1, k * 3)) // 先出现再展开，别在半透明状态下变形
      if (hasSub) {
        /**
         * 纵向：宽度**先**用一条快曲线到位（前 45% 就走完），高度随后带回弹
         * 掉下来。主视觉是往下长的那一下。
         *
         * 两个维度同速的话，看起来只是「一个方块整体变大」，方向感就没了。
         */
        const wk = easeOutCubic(Math.min(1, k / 0.45))
        const hk = easeOutBack(k)
        layout(W0 + (W - W0) * wk, H0 + (H - H0) * hk)
      } else {
        // 横向：高度全程不动（就是刘海本身），只有宽度向两侧推开
        layout(W0 + (W - W0) * easeOutBack(k), H)
      }
      return
    }

    const holdEnd = IN + ms / 1000
    if (t < holdEnd) {
      layout(W, H)
      win.setAlphaValue(1)
      /**
       * 这里曾经有一个「确认真的画出来了」的自检，用 occlusionState 的
       * visible 位判断窗口有没有参与合成。**删掉了，因为它是错的，而且有害。**
       *
       * 实测（前台 shell 父进程 vs 双重 fork 造的孤儿，两边各跑几次）：
       *   前台：occlusionState = 8192，窗口确实在屏幕上
       *   孤儿：occlusionState = 8192，窗口什么都没画出来
       * 两者**报同一个值**，这个量根本区分不了。而代码检查的是 `& 2`
       * （文档里 NSWindowOcclusionStateVisible 确实是 2），8192 & 2 = 0，
       * 于是它**永远判定失败**——包括每一次真的显示成功。
       *
       * 代价不只是误报：原来的实现是在这个定时器回调里 `throw`，异常打断
       * 定时器但 `app.run` 还在转，之后没有任何东西再去 terminate。机器上
       * 因此堆了 9 个 hud.jxa.js，最久的跑了 13 小时 10 分钟，不写日志、
       * 不报错，只是安静地占着内存——日志分析时才发现。
       *
       * 而 hud.mjs 里早就写着结论：「为什么不用 occlusionState 自检：试过，
       * 在真实的孤儿环境里它照样带着 visible 位，判不出来。ppid 是能直接
       * 观察、能复现、能解释的那个量。」——**结论写在一个文件里，废弃的
       * 检查留在了另一个文件里。** 判据只保留 hud.mjs 的 canDrawWindows()。
       */
      return
    }

    // 收回去也回到刘海形态，而不是原地消失。方向和进来时一致：
    // 横向的收成一条，纵向的先收高度。
    const k = Math.min(1, (t - holdEnd) / OUT)
    const e = easeOutCubic(k)
    if (hasSub) {
      const hk = easeOutCubic(Math.min(1, k / 0.7)) // 高度先收，宽度殿后
      layout(W - (W - W0) * e, H - (H - H0) * hk)
    } else {
      layout(W - (W - W0) * e, H)
    }
    win.setAlphaValue(1 - e)
    if (e >= 1) {
      timer.invalidate
      // JXA 的 ObjC 桥里，无参方法是**属性**，写成 close() 会当成调用一个 undefined
      win.close
      // 不能用 stop()：AppKit 的 stop: 要等**下一个事件**才真的跳出 run 循环，
      // 而这个进程没有任何输入事件，于是永远卡住（实测挂了 60 秒没退）。
      // 一次性进程直接 terminate 最干净。
      app.terminate(null)
    }
  })

  /**
   * 看门狗：到点无论如何都退出。
   *
   * 上面那条动画定时器是唯一的正常退出路径，任何让它停下来的意外（抛异常、
   * 拿不到图形会话、AppKit 内部出岔子）都会让 `app.run` 永远转下去。实测
   * 后果是机器上堆着一批跑了十几个小时的 osascript。
   *
   * 一个**独立于动画**的绝对超时把这件事变成不可能：胶囊最多活 ms + 2 秒，
   * 之后强制 terminate。宁可提示少显示一会儿，也不留一个不会死的进程。
   */
  $.NSTimer.scheduledTimerWithTimeIntervalRepeatsBlock(
    (ms + 2000) / 1000, false, () => {
      // 走到这儿说明动画那条正常路径没能收尾。同样要非零：让调用方知道
      // 这次提示不可靠，而不是以为一切正常
      $.exit(4)
    })

  app.run
  // app.run 之后必须还有一条语句：它是 run() 的尾表达式时，JXA 会把它当成
  // 返回值去求值，实测那样根本不会进事件循环，进程立刻退出、屏幕上什么都没有。
  return ''
}

/**
 * 挑一块屏。
 *
 * 顺序是有理由的：刘海**只存在于内置屏**，所以先认内置屏。
 * mainScreen 是「有 key window 的那块」——这个进程没有任何窗口，
 * 接了外接显示器时它给的答案不可靠。
 */
function pickScreen() {
  const screens = $.NSScreen.screens
  for (let i = 0; i < screens.count; i++) {
    const s = screens.objectAtIndex(i)
    try {
      const id = s.deviceDescription.objectForKey('NSScreenNumber')
      if ($.CGDisplayIsBuiltin(id.unsignedIntValue) === 1) return s
    } catch {
      /* 拿不到就看下一块 */
    }
  }
  // 没有内置屏（外接屏合盖使用）时，用鼠标所在的那块——人在看哪儿就弹哪儿
  try {
    const m = $.NSEvent.mouseLocation
    for (let i = 0; i < screens.count; i++) {
      const s = screens.objectAtIndex(i)
      if ($.NSMouseInRect(m, s.frame, false)) return s
    }
  } catch {
    /* 退回 mainScreen */
  }
  return $.NSScreen.mainScreen
}

/** 刘海尺寸。两侧辅助区都拿得到才算真有刘海，否则返回 0。 */
function notchSize(screen) {
  try {
    const top = Number(screen.safeAreaInsets.top) || 0
    if (top <= 0) return { w: 0, h: 0 }
    const l = Number(screen.auxiliaryTopLeftArea.size.width) || 0
    const r = Number(screen.auxiliaryTopRightArea.size.width) || 0
    if (l <= 0 || r <= 0) return { w: 0, h: top, l: 0 }
    // l 是刘海**左边缘**在屏幕坐标里的位置。紧凑态要靠它把窗口对齐物理刘海，
    // 光有宽度不够——刘海未必正好在屏幕正中（实测 l=763 / r=762，差 1pt）
    return { w: Math.ceil(Number(screen.frame.size.width) - l - r), h: Math.ceil(top), l }
  } catch {
    return { w: 0, h: 0, l: 0 }
  }
}

/**
 * 把一个字形**居中**放到指定的圆心上。
 *
 * 不能直接给它一个和徽章一样大的框然后 setAlignment(center)——那样两个轴都会偏。
 * 实测（在徽章正中心画十字做基准）偏了 dx=+3.5pt、dy=-1.75pt，连完全对称的 ●
 * 也一样偏，所以不是字形的锅：
 *
 *   · 竖直：NSTextField 的单行文本是**顶对齐**的。26pt 的框里放 16.5pt 的行高，
 *     文字整体贴着框顶，于是比框中心高出约 (26-16.5)/2。
 *   · 水平：居中对齐居的是**排版框**，而框比字宽得多时残留的空隙并不对称。
 *
 * 所以反过来做：先把框裁到文字自己的尺寸（宽=实测字宽，高=行高），
 * 再把这个刚好包住文字的框摆到圆心上。框和字一样大时，「框居中」就是「字居中」。
 */
function centeredGlyph(box, text, cx, cy, size, rgb, alpha = 1) {
  const font = $.NSFont.systemFontOfSizeWeight(size, $.NSFontWeightSemibold)
  const lineH = Number(font.ascender) - Number(font.descender)
  const gw = measureText(text, size) + 2
  /**
   * 竖直再抬一点点。
   *
   * 把框裁到行高之后水平已经准了（实测 dx 0.00pt），但竖直还偏下 1.5~2.0pt：
   * 行框底部留着一段 descender 的空白，而 ● ✓ ⚠ 这些字形都没有下伸部，
   * 墨迹于是整体坐在框的上半部——框居中不等于墨迹居中。
   *
   * 0.125em 是**实测标定**出来的，不是推导的。复现方法记在这儿，换字号或换
   * 系统字体后可以照做：在徽章正中心画一条白竖线和一条品红横线当基准，
   * 截图后比较字形墨迹外接框的中心和基准线的偏移。
   * 标定后：● 偏 -0.25pt，✓ 偏 +0.25pt —— 都在半个物理像素以内（2x 屏）。
   */
  const f = $.NSTextField.alloc.initWithFrame(
    $.NSMakeRect(cx - gw / 2, cy - lineH / 2 + size * 0.125, gw, lineH))
  f.setStringValue(String(text ?? ''))
  f.setBezeled(false)
  f.setDrawsBackground(false)
  f.setEditable(false)
  f.setSelectable(false)
  f.setFont(font)
  f.setAlignment($.NSTextAlignmentCenter)
  const [r, g, b] = rgb ?? [1, 1, 1]
  f.setTextColor($.NSColor.colorWithSRGBRedGreenBlueAlpha(r, g, b, alpha))
  box.addSubview(f)
  return f
}

/**
 * 量一段文字在指定字号下的宽度（pt）。
 *
 * 用一个不上屏的 NSTextField + sizeToFit —— 比手算字符数靠谱得多：
 * 中文、英文、emoji 的宽度差好几倍，按字符数估会让胶囊忽宽忽窄。
 */
function measureText(text, size) {
  try {
    const f = $.NSTextField.alloc.initWithFrame($.NSMakeRect(0, 0, 400, 24))
    f.setStringValue(String(text ?? ''))
    f.setBezeled(false)
    f.setDrawsBackground(false)
    f.setEditable(false)
    f.setFont($.NSFont.systemFontOfSizeWeight(size, $.NSFontWeightMedium))
    f.sizeToFit
    return Number(f.frame.size.width) || 90
  } catch {
    return 90
  }
}

function menubarHeight(screen) {
  try {
    return Number(screen.frame.size.height) - Number(screen.visibleFrame.size.height)
  } catch {
    return 0
  }
}
