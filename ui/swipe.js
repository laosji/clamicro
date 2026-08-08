/**
 * 卡片左右滑手势。审批页和首页待审批列表共用同一份实现——
 * 这里的判定条件（轴锁定、瞬时速度、最小位移、人手门槛、风险分档）
 * 每一条都是踩过坑加上去的，不能有第二份拷贝各自漂移。
 *
 *   attachSwipe(cardEl, {
 *     mode: 'normal' | 'high',   // high：右滑需划得更远，且不给甩出快捷方式
 *     onCommit(dir),             // dir = 'allow' | 'deny'
 *     ignore: 'pre, summary',    // 这些元素上的手势交还给它们自己
 *   })
 */
(function () {
  // 任何情况下的最小绝对位移。防止「一帧跳变」式的合成/异常事件
  // 在比例阈值之下就把操作放行。
  const MIN_PX = 56

  /**
   * 承诺点的位移阈值。
   *
   * 抽成纯函数是为了能被直接测——误滑等于误批准，这段逻辑不该只能靠
   * 在真机上反复试。见 test/swipe.test.mjs。
   *
   * 上限 420：横屏时 innerWidth 可达 800+，32% 就要划半个屏幕。
   * 下限 320：**页面在后台渲染或旋转时 innerWidth 可能读到 0**，
   * 那会让阈值变成 0，任何一点点拖动都能放行操作。实测踩到过。
   */
  function computeThreshold(width, right, mode) {
    const base = Math.min(Math.max(Number(width) || 375, 320), 420)
    return right && mode === 'high' ? base * 0.55 : base * 0.32
  }

  /**
   * 松手时到底放不放行。全部条件都在这一个地方，避免散落各处漂移。
   *
   * @param dx     水平位移（右正左负）
   * @param vx     瞬时速度
   * @param axis   轴锁定结果，只有 'x' 才算横向手势
   * @param th     computeThreshold 的结果
   * @param moves  收到过几次 move —— 真手指至少几十毫秒、好几个事件
   * @param dtMs   从第一次 move 到现在的毫秒数
   */
  function shouldCommit({ dx, vx, axis, th, moves, dtMs, mode, rightBlocked }) {
    const right = dx > 0
    const past = Math.abs(dx) >= th
    // 甩出快捷方式要求速度方向与位移方向一致；高危批准不给快捷方式，
    // 必须实打实划过去——一次快速轻扫不该能放行 rm -rf
    const flick =
      Math.abs(vx) > 0.55 &&
      Math.sign(vx) === Math.sign(dx) &&
      Math.abs(dx) > Math.max(MIN_PX, th * 0.45)
    const canFlick = !(right && mode === 'high')
    const dirOk = !(right && rightBlocked)
    // 一步跳到位的「瞬移拖拽」只可能来自合成事件或输入层异常，
    // 不该被当成人的决定。
    const human = moves >= 2 && dtMs >= 80
    const go = axis === 'x' && dirOk && human && Math.abs(dx) >= MIN_PX && (past || (flick && canFlick))
    return { go, past, flick, canFlick, human, dirOk }
  }

  /* ── 触感反馈 ──
     iOS Safari 不支持 navigator.vibrate。但 iOS 17.4+ 给 checkbox 加了
     switch 属性，切换它会触发系统触感——在用户手势里以编程方式点击这个
     隐藏元素，就能借到那一下震动。必须在手势回调里调用才有效。
     Android/Chrome 走标准的 vibrate。两条路都不通就静默降级，
     视觉反馈（图章咬合、卡片位移）本来就是主要通道。 */
  let hapticInput = null
  function haptic(ms = 10) {
    try {
      if (typeof navigator.vibrate === 'function' && navigator.vibrate(ms)) return
    } catch {
      /* 某些浏览器在非用户手势里会抛 */
    }
    try {
      if (!hapticInput) {
        const label = document.createElement('label')
        label.setAttribute('aria-hidden', 'true')
        label.style.cssText =
          'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none'
        const input = document.createElement('input')
        input.type = 'checkbox'
        input.setAttribute('switch', '')
        input.tabIndex = -1
        label.appendChild(input)
        document.body.appendChild(label)
        hapticInput = input
      }
      hapticInput.click()
    } catch {
      /* 没有就算了 */
    }
  }
  window.ccHaptic = haptic

  function attachSwipe(card, opts) {
    // mode: 'normal' 双向 | 'high' 右滑需划得更远 | 'denyOnly' 右滑完全禁用
    const { mode = 'normal', onCommit, ignore = 'pre, summary, a, button, input' } = opts
    const rightBlocked = mode === 'denyOnly'
    const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches

    const tint = document.createElement('div')
    tint.className = 'sw-tint'
    const stamp = document.createElement('div')
    stamp.className = 'sw-stamp'
    card.prepend(stamp)
    card.prepend(tint)
    card.classList.add('sw-armed')

    let startX = 0, startY = 0, dx = 0, axis = null, tracking = false, done = false
    let vx = 0, lastX = 0, lastT = 0, moves = 0, firstMoveT = 0

    // 横屏时 innerWidth 可达 800+，32% 就要划半个屏幕 → 上限 420。
    // 下限 320 同样重要：页面在后台渲染或旋转时 innerWidth 可能读到 0，
    // 那会让阈值变成 0，任何一点点拖动都能放行操作。实测踩到过。
    function threshold(right) {
      return computeThreshold(window.innerWidth || card.getBoundingClientRect().width, right, mode)
    }

    function paint() {
      const right = dx > 0
      const heavy = right && mode === 'high'
      const th = threshold(right)
      const raw = Math.abs(dx)
      // 高危批准方向递增阻尼：越往前推越沉，用手感传达「这个操作很重」。
      // denyOnly 则是强橡皮筋——能动一点，但明显推不动。
      const eff = right && rightBlocked
        ? dx * 0.18
        : heavy
          ? Math.sign(dx) * raw * (1 - 0.4 * Math.min(1, raw / (th * 1.6)))
          : dx
      const p = right && rightBlocked ? 0 : Math.min(1, Math.abs(eff) / th)

      card.style.transform = `translateX(${eff}px) rotate(${Math.max(-12, Math.min(12, eff / 18))}deg)`
      tint.dataset.dir = right ? 'r' : 'l'
      tint.style.opacity = p * 0.9
      stamp.dataset.dir = right ? 'r' : 'l'
      stamp.textContent = right ? 'GRANT' : 'DENY'
      stamp.style.opacity = Math.min(1, p * 1.3)
      // 越过承诺点时给一个明确的状态跳变——手势最关键的一个反馈：
      // 你必须能在松手之前知道自己过没过线。
      // 跨过那一刻震一下，让你不看屏幕也知道（这正是 Tinder 手感的来源）。
      const wasLocked = stamp.classList.contains('locked')
      const nowLocked = Math.abs(eff) >= th
      stamp.classList.toggle('locked', nowLocked)
      if (nowLocked !== wasLocked) haptic(nowLocked ? 12 : 6)
    }

    function reset(animate = true) {
      dx = 0; axis = null
      card.style.transition = animate ? 'transform .28s cubic-bezier(.2,.9,.3,1)' : 'none'
      card.style.transform = ''
      tint.style.opacity = 0
      stamp.style.opacity = 0
      stamp.classList.remove('locked')
    }

    function fly(dir) {
      done = true
      haptic(dir === 'allow' ? 20 : 12)
      const out = (dir === 'allow' ? 1 : -1) * window.innerWidth * 1.3
      card.style.transition = REDUCED ? 'opacity .2s' : 'transform .32s ease-out, opacity .32s ease-out'
      if (!REDUCED) card.style.transform = `translateX(${out}px) rotate(${dir === 'allow' ? 16 : -16}deg)`
      card.style.opacity = '0'
      onCommit(dir)
    }

    card.addEventListener('pointerdown', (e) => {
      if (done) return
      if (ignore && e.target.closest(ignore)) return
      startX = lastX = e.clientX; startY = e.clientY
      dx = 0; vx = 0; axis = null; tracking = true; moves = 0; firstMoveT = 0
      lastT = performance.now()
      card.style.transition = 'none'
    })

    card.addEventListener('pointermove', (e) => {
      if (done || !tracking) return
      const mx = e.clientX - startX, my = e.clientY - startY
      if (axis === null) {
        if (Math.abs(mx) < 8 && Math.abs(my) < 8) return
        // 水平位移要明显压过垂直，否则判为滚动，交还给浏览器
        axis = Math.abs(mx) > Math.abs(my) * 1.5 ? 'x' : 'y'
        if (axis === 'x') card.setPointerCapture?.(e.pointerId)
      }
      if (axis !== 'x') return
      if (!moves) firstMoveT = performance.now()
      moves++
      // 瞬时速度（指数平滑），而不是「总位移 ÷ 总时长」——后者会让
      // 「慢拖再快甩」算不出速度，也会把「先右拖再左甩」误判成右向甩出
      const now = performance.now()
      vx = vx * 0.7 + ((e.clientX - lastX) / Math.max(1, now - lastT)) * 0.3
      lastX = e.clientX; lastT = now
      dx = mx
      paint()
    })

    function release() {
      if (done || !tracking) return
      tracking = false
      const right = dx > 0
      const th = threshold(right)
      const d = shouldCommit({
        dx, vx, axis, th, moves,
        dtMs: performance.now() - firstMoveT,
        mode, rightBlocked,
      })

      window.__swipeDebug = { dx, vx, axis, th, moves, mode, ...d }
      if (d.go) fly(right ? 'allow' : 'deny')
      else reset()
    }

    card.addEventListener('pointerup', release)
    card.addEventListener('pointercancel', release)

    return {
      // 提交失败时把卡片放回来，否则用户面对一张飞走的空卡片
      restore() {
        done = false
        card.style.opacity = '1'
        reset()
      },
    }
  }

  window.attachSwipe = attachSwipe
  // 纯判定逻辑单独导出，好让 test/swipe.test.mjs 直接打在真实实现上，
  // 而不是维护一份会漂移的拷贝
  window.__swipeLogic = { MIN_PX, computeThreshold, shouldCommit }
})()
