// 刘海位置的胶囊提示。
// 由 src/hud.mjs 通过 `osascript -l JavaScript` 调起，参数：图标 标题 副标题 毫秒
//
// 系统连接外设时那条 HUD 由 BluetoothUIService 绘制，第三方没有 API 能投递，
// 所以这里用 JXA 的 ObjC 桥手搓一个。目标是「看起来是同一家出的」，
// 不是像素级复刻。
ObjC.import('AppKit')

function run(argv) {
  const [icon = '✓', title = '', subtitle = '', msArg = '2600'] = argv
  const ms = Number(msArg) || 2600

  $.NSApplication.sharedApplication.setActivationPolicy($.NSApplicationActivationPolicyAccessory)

  const screen = $.NSScreen.mainScreen
  const frame = screen.frame

  /**
   * 刘海高度。有刘海的 Mac 上 safeAreaInsets.top 就是它（这台是 33pt）；
   * 没刘海的机器返回 0，那时按菜单栏高度走，视觉上等价。
   */
  let notch = 0
  try {
    notch = Number(screen.safeAreaInsets.top) || 0
  } catch {
    notch = 0
  }
  const topInset = notch || 24

  const hasSub = subtitle.length > 0
  // 高度要**盖过刘海**，否则胶囊下沿和刘海下沿错开，看起来是两个东西
  const H = Math.max(topInset + 4, hasSub ? 76 : 60)
  // 宽度要明显大于刘海（这台 184pt），让刘海嵌在胶囊里而不是并排
  const W = hasSub ? 340 : 300
  const R = 20

  const win = $.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer(
    // 贴住屏幕**最顶端**——刘海就在那里。窗口层级高于菜单栏，所以能盖上去。
    $.NSMakeRect(frame.origin.x + (frame.size.width - W) / 2, frame.origin.y + frame.size.height - H, W, H),
    $.NSWindowStyleMaskBorderless,
    $.NSBackingStoreBuffered,
    false,
  )
  win.setLevel($.NSStatusWindowLevel)
  win.setOpaque(false)
  win.setBackgroundColor($.NSColor.clearColor)
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

  const blur = $.NSVisualEffectView.alloc.initWithFrame($.NSMakeRect(0, 0, W, H))
  blur.setMaterial($.NSVisualEffectMaterialHUDWindow)
  blur.setBlendingMode($.NSVisualEffectBlendingModeBehindWindow)
  blur.setState($.NSVisualEffectStateActive)
  blur.setWantsLayer(true)
  // 只圆下面两个角：上沿贴着屏幕边缘，圆上去会露出屏幕背景的直角
  blur.layer.setCornerRadius(R)
  blur.layer.setMaskedCorners(1 << 0 | 1 << 1) // MinXMinY | MaxXMinY = 左下 + 右下
  blur.layer.setMasksToBounds(true)
  win.contentView.addSubview(blur)

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
    blur.addSubview(f)
    return f
  }

  // 内容整体压在刘海**下方**：那一条被摄像头占着，放字会被切掉
  const contentTop = H - topInset
  const iconField = label(icon, $.NSMakeRect(16, contentTop / 2 - 15, 30, 30), 20, $.NSFontWeightRegular, 1)
  iconField.setAlignment($.NSTextAlignmentCenter)

  const textX = 52
  const textW = W - textX - 16
  if (hasSub) {
    label(title, $.NSMakeRect(textX, contentTop / 2 + 1, textW, 17), 12.5, $.NSFontWeightSemibold, 1)
    label(subtitle, $.NSMakeRect(textX, contentTop / 2 - 17, textW, 15), 11, $.NSFontWeightRegular, 0.62)
  } else {
    label(title, $.NSMakeRect(textX, contentTop / 2 - 8, textW, 17), 12.5, $.NSFontWeightSemibold, 1)
  }

  win.orderFrontRegardless

  // 淡入 → 停留 → 淡出。系统那条也是这个节奏，硬切会显得廉价。
  // 手动步进而不是 NSAnimationContext：这个进程没有正常的 runloop 驱动，
  // 动画 API 排的队根本不会被执行。
  const step = 0.02
  const fadeIn = 0.18
  for (let t = 0; t <= fadeIn; t += step) {
    win.setAlphaValue(t / fadeIn)
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(step))
  }
  win.setAlphaValue(1)
  $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(ms / 1000))
  const fadeOut = 0.28
  for (let t = fadeOut; t >= 0; t -= step) {
    win.setAlphaValue(t / fadeOut)
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(step))
  }
  // JXA 的 ObjC 桥里，无参方法是**属性**，写成 close() 会当成调用一个 undefined
  win.close
}
