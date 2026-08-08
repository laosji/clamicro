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

/** 反向曲线的顶角半径 / 普通圆角的底角半径，取自 DynamicNotchKit 的展开态 */
const TOP_R = 15
const BOT_R = 20

function run(argv) {
  const [icon = '✓', title = '', subtitle = '', msArg = '2600'] = argv
  const ms = Number(msArg) || 2600

  $.NSApplication.sharedApplication.setActivationPolicy($.NSApplicationActivationPolicyAccessory)

  const screen = pickScreen()
  const frame = screen.frame
  const notch = notchSize(screen)
  // 没刘海的机器（外接屏、老 Mac）退回菜单栏高度，视觉上等价
  const topInset = notch.h || menubarHeight(screen) || 24

  const hasSub = subtitle.length > 0
  const contentH = hasSub ? 46 : 32
  const H = topInset + contentH
  // 主体必须明显宽过刘海，刘海才会「嵌在里面」而不是和胶囊并排。
  // 两侧再各留 TOP_R 给反向曲线张开的部分。
  const bodyW = Math.max((notch.w || 185) + 120, hasSub ? 330 : 290)
  const W = bodyW + TOP_R * 2

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
  win.setCollectionBehavior(
    $.NSWindowCollectionBehaviorCanJoinAllSpaces | $.NSWindowCollectionBehaviorStationary,
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

  const label = (text, rect, size, weight, alpha) => {
    const f = $.NSTextField.alloc.initWithFrame(rect)
    f.setStringValue(text)
    f.setBezeled(false)
    f.setDrawsBackground(false)
    f.setEditable(false)
    f.setSelectable(false)
    f.setFont($.NSFont.systemFontOfSizeWeight(size, weight))
    // 强制白色：这个面板固定深色，用 labelColor 会跟随系统而在浅色下变黑
    f.setTextColor($.NSColor.whiteColor.colorWithAlphaComponent(alpha))
    f.setLineBreakMode($.NSLineBreakByTruncatingTail)
    box.addSubview(f)
    return f
  }

  // 内容整体压在刘海**下方**：那一条被摄像头占着，放字会被切掉。
  // 左右各让开 TOP_R，那是反向曲线张开的地方，压上去会被切。
  const padX = TOP_R + 16
  const midY = contentH / 2
  const iconField = label(icon, $.NSMakeRect(padX, midY - 15, 30, 30), 20, $.NSFontWeightRegular, 1)
  iconField.setAlignment($.NSTextAlignmentCenter)

  const textX = padX + 36
  const textW = W - textX - padX
  if (hasSub) {
    label(title, $.NSMakeRect(textX, midY + 1, textW, 17), 12.5, $.NSFontWeightSemibold, 1)
    label(subtitle, $.NSMakeRect(textX, midY - 17, textW, 15), 11, $.NSFontWeightRegular, 0.62)
  } else {
    label(title, $.NSMakeRect(textX, midY - 8, textW, 17), 12.5, $.NSFontWeightSemibold, 1)
  }

  /**
   * 胶囊轮廓。顶部两角向外张开（反向曲线），底部两角是普通圆角。
   *
   * 坐标系是 CALayer 的（y 向上，(0,0) 在左下）。DynamicNotchKit 的原版写在
   * SwiftUI 坐标系里（y 向下），所以这里上下是镜像过的。
   */
  const shape = (w, h) => {
    const p = $.CGPathCreateMutable()
    $.CGPathMoveToPoint(p, null, 0, h)
    $.CGPathAddQuadCurveToPoint(p, null, TOP_R, h, TOP_R, h - TOP_R) // 左上：外张
    $.CGPathAddLineToPoint(p, null, TOP_R, BOT_R)
    $.CGPathAddQuadCurveToPoint(p, null, TOP_R, 0, TOP_R + BOT_R, 0) // 左下：普通圆角
    $.CGPathAddLineToPoint(p, null, w - TOP_R - BOT_R, 0)
    $.CGPathAddQuadCurveToPoint(p, null, w - TOP_R, 0, w - TOP_R, BOT_R) // 右下
    $.CGPathAddLineToPoint(p, null, w - TOP_R, h - TOP_R)
    $.CGPathAddQuadCurveToPoint(p, null, w - TOP_R, h, w, h) // 右上：外张
    $.CGPathCloseSubpath(p)
    return p
  }

  /** 把窗口摆到内置屏顶端正中，并按当前尺寸重画轮廓 */
  const layout = (w, h) => {
    win.setFrameDisplay(
      $.NSMakeRect(
        frame.origin.x + (frame.size.width - w) / 2,
        frame.origin.y + frame.size.height - h, // 贴住屏幕最顶端——刘海就在那里
        w,
        h,
      ),
      true,
    )
    body.setFrame($.NSMakeRect(0, 0, w, h))
    mask.setPath(shape(w, h))
    // 容器钉在顶部：窗口从刘海高度长到全高时，文字不能跟着往下滑
    box.setFrame($.NSMakeRect((w - W) / 2, h - H, W, H))
  }

  // 起始形态就是刘海本身：从它「长出来」，而不是凭空淡入。
  // 这是这类 HUD 最容易辨认的一点，也是纯 alpha 淡入做不出来的。
  const W0 = (notch.w || 185) + TOP_R * 2
  const H0 = topInset
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
   * windowNumber），但 `occlusionState` 始终不含 visible 位，屏幕上什么都
   * 没有，截图也截不到。换成 `NSApp.run` 之后 occlusionState 立刻从
   * 8192 变成 8194（+2 = visible），画面就出来了。
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
      const e = easeOutBack(t / IN)
      layout(W0 + (W - W0) * e, H0 + (H - H0) * e)
      win.setAlphaValue(Math.min(1, (t / IN) * 3)) // 先出现再展开，别在半透明状态下变形
      return
    }

    const holdEnd = IN + ms / 1000
    if (t < holdEnd) {
      layout(W, H)
      win.setAlphaValue(1)
      return
    }

    // 收回去也回到刘海形态，而不是原地消失
    const e = easeOutCubic(Math.min(1, (t - holdEnd) / OUT))
    layout(W - (W - W0) * e, H - (H - H0) * e)
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
    if (l <= 0 || r <= 0) return { w: 0, h: top }
    return { w: Math.ceil(Number(screen.frame.size.width) - l - r), h: Math.ceil(top) }
  } catch {
    return { w: 0, h: 0 }
  }
}

function menubarHeight(screen) {
  try {
    return Number(screen.frame.size.height) - Number(screen.visibleFrame.size.height)
  } catch {
    return 0
  }
}
