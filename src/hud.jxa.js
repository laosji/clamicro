// 屏幕顶部居中的胶囊提示，仿系统连接外设时那一条。
// 由 src/hud.mjs 通过 `osascript -l JavaScript` 调起，参数：图标 标题 副标题 毫秒
//
// 用 JXA 的 ObjC 桥手搓一个无边框面板——系统那个 HUD 是 BluetoothUIService
// 画的，第三方没有 API 能投递。这里的目标是「看起来是同一家出的」，
// 不是像素级复刻。
ObjC.import('AppKit')

function run(argv) {
  const [icon = '✓', title = '', subtitle = '', msArg = '2600'] = argv
  const ms = Number(msArg) || 2600

  $.NSApplication.sharedApplication.setActivationPolicy($.NSApplicationActivationPolicyAccessory)

  const hasSub = subtitle.length > 0
  const W = 300
  const H = hasSub ? 74 : 58
  const R = H / 2 > 22 ? 22 : H / 2 // 胶囊感来自大圆角，但别圆过头变成药丸

  const screen = $.NSScreen.mainScreen.frame
  const win = $.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer(
    // 顶部往下 100pt：避开刘海和菜单栏，和系统 HUD 的位置接近
    $.NSMakeRect((screen.size.width - W) / 2, screen.size.height - H - 100, W, H),
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

  // 毛玻璃底，跟随系统深浅色——不自己定颜色，那样在另一种外观下必然出错
  const blur = $.NSVisualEffectView.alloc.initWithFrame($.NSMakeRect(0, 0, W, H))
  blur.setMaterial($.NSVisualEffectMaterialHUDWindow)
  blur.setBlendingMode($.NSVisualEffectBlendingModeBehindWindow)
  blur.setState($.NSVisualEffectStateActive)
  blur.setWantsLayer(true)
  blur.layer.setCornerRadius(R)
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
    f.setTextColor($.NSColor.labelColor.colorWithAlphaComponent(alpha))
    f.setLineBreakMode($.NSLineBreakByTruncatingTail)
    blur.addSubview(f)
    return f
  }

  // 图标
  const iconField = label(icon, $.NSMakeRect(18, (H - 30) / 2, 30, 30), 21, $.NSFontWeightRegular, 1)
  iconField.setAlignment($.NSTextAlignmentCenter)

  const textX = 56
  const textW = W - textX - 18
  if (hasSub) {
    label(title, $.NSMakeRect(textX, H / 2 + 1, textW, 18), 13, $.NSFontWeightSemibold, 1)
    label(subtitle, $.NSMakeRect(textX, H / 2 - 19, textW, 16), 11.5, $.NSFontWeightRegular, 0.6)
  } else {
    label(title, $.NSMakeRect(textX, (H - 18) / 2, textW, 18), 13, $.NSFontWeightSemibold, 1)
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
