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
   *
   * maxTravel：控件真正走得到的行程。**决策条必须传**。
   * 上面那个 320 下限是为「视口宽度」准备的，而决策条传进来的是一个
   * 固定尺寸控件的半宽——390 的手机上只有 144px，被下限抬到 320 之后，
   * 高危阈值算出 176px，比把手能走的距离还远：把手顶到轨道尽头，
   * 进度条停在 82% 永远不满，人只能凭猜把手指拖出控件外面才提交得了。
   * 实测过（travel 144 / 阈值 176），高危审批**在界面上是走不完的**。
   */
  function computeThreshold(width, right, mode, maxTravel) {
    const base = Math.min(Math.max(Number(width) || 375, 320), 420)
    const th = right && mode === 'high' ? base * 0.55 : base * 0.32
    if (!maxTravel) return th
    // 留 12% 余量：过线之后还得有一段能走，否则「已过线」这个状态
    // 和「顶到头」在手感上分不开，而那一跳正是松手前唯一的确认
    return Math.min(th, Math.max(MIN_PX, maxTravel * 0.88))
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
    /**
     * pointercancel **绝不提交**，一律弹回。
     *
     * 原来它和 pointerup 绑的是同一个 release()，于是照常走判定、照常 fly()。
     * 可这两个事件的语义是相反的：
     *   · pointerup   —— 人松手了，这次交互**结束**了
     *   · pointercancel —— 系统把指针抢走了，这次交互**没有发生**
     *
     * iOS 上抢占很常见：左缘返回手势、来电、下拉控制中心、通知横幅。
     * 只要那一刻横向位移已经过了阈值，一次被系统打断的滑动就会变成
     * 一次真实的批准——人根本没松手，操作却执行了。
     *
     * 在一个「批准 rm -rf」的界面上，宁可让人重滑一次，也不能替他决定。
     */
    card.addEventListener('pointercancel', () => {
      if (done || !tracking) return
      tracking = false
      reset()
    })

    return {
      // 提交失败时把卡片放回来，否则用户面对一张飞走的空卡片
      restore() {
        done = false
        card.style.opacity = '1'
        reset()
      },
    }
  }

  /**
   * 决策条：中心一个把手，往左拖是拒绝，往右拖是批准。
   *
   * ## 为什么换掉整卡片左右滑
   *
   * 整卡片滑动有两个毛病：滑动起点在哪都行，所以**在页面上滚动阅读命令原文
   * 时很容易蹭出一次决策**；而且行程没有可见的参照物，你不知道还差多远。
   * 中心把手把「决策」收进一个明确的控件里——起点固定、行程可见、
   * 阅读区域不再是操作区域。
   *
   * ## 判定逻辑一行没重写
   *
   * 复用 shouldCommit / computeThreshold。那 44 个测试钉的是
   * **「什么算一次有效批准」**，和交互长什么样无关：高危右滑要划更远、
   * 高危不给甩出快捷方式、MIN_PX 绝对下限、人手门槛挡住合成事件——
   * 换了外壳这些一条都不能松。
   *
   * 唯一的适配：这里的可用行程是「半条轨道」而不是「整屏宽」，
   * 所以把轨道半宽当作 computeThreshold 的 width 传进去。
   */
  function attachDecisionBar(bar, opts) {
    const { mode = 'normal', onCommit } = opts
    const knob = bar.querySelector('.db-knob')
    const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!knob) return { destroy() {} }

    let tracking = false, done = false, dx = 0, vx = 0
    let startX = 0, lastX = 0, lastT = 0, moves = 0, firstMoveT = 0

    // 可用行程 = 半条轨道减去把手自身的一半，也就是把手能走到头的距离
    const travel = () => Math.max(60, bar.clientWidth / 2 - knob.offsetWidth / 2 - 6)
    // 把行程一起传进去：阈值再高也不能高过把手走得到的地方
    const threshold = (right) => computeThreshold(travel() * 2, right, mode, travel())

    function paint() {
      const t = travel()
      const clamped = Math.max(-t, Math.min(t, dx))
      knob.style.transform = `translate(calc(-50% + ${clamped}px), -50%)`
      const p = Math.min(1, Math.abs(clamped) / Math.max(1, threshold(dx > 0)))
      bar.classList.toggle('to-allow', dx > 0 && p > 0.15)
      bar.classList.toggle('to-deny', dx < 0 && p > 0.15)
      bar.style.setProperty('--p', p.toFixed(3))
    }

    function reset() {
      dx = 0
      if (!REDUCED) knob.style.transition = 'transform .22s cubic-bezier(.2,.9,.3,1)'
      knob.style.transform = 'translate(-50%, -50%)'
      bar.classList.remove('to-allow', 'to-deny')
      bar.style.setProperty('--p', 0)
      setTimeout(() => { knob.style.transition = '' }, 240)
    }

    knob.addEventListener('pointerdown', (e) => {
      if (done) return
      tracking = true; moves = 0; dx = 0; vx = 0
      startX = lastX = e.clientX; lastT = performance.now(); firstMoveT = 0
      knob.setPointerCapture?.(e.pointerId)
      knob.style.transition = ''
    })

    knob.addEventListener('pointermove', (e) => {
      if (!tracking || done) return
      if (!moves) firstMoveT = performance.now()
      moves++
      const now = performance.now()
      vx = vx * 0.7 + ((e.clientX - lastX) / Math.max(1, now - lastT)) * 0.3
      lastX = e.clientX; lastT = now
      dx = e.clientX - startX
      paint()
    })

    function release() {
      if (done || !tracking) return
      tracking = false
      const right = dx > 0
      const d = shouldCommit({
        dx, vx,
        axis: 'x', // 把手只沿轨道走，没有轴锁定问题
        th: threshold(right),
        moves,
        dtMs: performance.now() - firstMoveT,
        mode,
        rightBlocked: mode === 'denyOnly',
      })
      window.__swipeDebug = { dx, vx, th: threshold(right), moves, mode, ...d }
      if (d.go) {
        done = true
        bar.classList.add('committed')
        onCommit?.(right ? 'allow' : 'deny')
      } else {
        reset()
      }
    }

    knob.addEventListener('pointerup', release)
    // 同上：系统抢占指针 ≠ 人做出了决定。详见卡片那一处的注释
    knob.addEventListener('pointercancel', () => {
      if (done || !tracking) return
      tracking = false
      reset()
    })

    return {
      /**
       * 把控件放回可用状态。
       *
       * 必须有：撤销执行、以及提交失败重试，走的都是这个口子。少了它，
       * 按下「撤销」之后 .committed 永远留在条上（opacity .5 + pointer-events
       * none）——人取消了执行，却再也**做不了任何决定**，只能干等到超时
       * 被自动拒绝。调用方一直在调 restore()，而这里只导出了 destroy，
       * 于是那句调用一声不响什么也没干。
       */
      restore() {
        done = false
        tracking = false
        bar.classList.remove('committed')
        reset()
      },
      destroy() { done = true },
    }
  }

  window.attachSwipe = attachSwipe
  window.attachDecisionBar = attachDecisionBar
  // 纯判定逻辑单独导出，好让 test/swipe.test.mjs 直接打在真实实现上，
  // 而不是维护一份会漂移的拷贝
  window.__swipeLogic = { MIN_PX, computeThreshold, shouldCommit }
})()
