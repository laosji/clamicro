import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 屏幕顶部居中的胶囊提示，仿系统连接外设时那一条。
 *
 * ## 先说清楚它不是什么
 *
 * Magic Keyboard / AirPods 连接时弹的那个居中圆角条是**系统 HUD**，由
 * BluetoothUIService 绘制，第三方 App 没有任何 API 能往里投递。所以这里是
 * **自己画一个**——用 JXA 的 ObjC 桥建一个无边框浮动面板，不需要编译任何东西，
 * 也不引入依赖（符合这个项目「运行时零 node_modules」的约束）。
 *
 * ## 代价，得写在前面
 *
 * 窗口活着的前提是那个 osascript 进程活着——它不是「发出去就不管」的通知，
 * 而是一个要维持 ~2.6 秒的子进程。更要紧的是：
 *
 *   **HUD 不进通知中心。划过去就没了，人不在屏幕前等于没发生。**
 *
 * 标准通知负责「你回来要看到的事」，HUD 只负责「此刻正在发生的事」。
 * 这个取舍交给 `config.notify.style` 决定（notch / banner / both）。
 *
 * ## 为什么要排队
 *
 * 一个位置只能放一个胶囊，两条叠上去会互相透出对方的文字。最初的做法是
 * **杀掉上一条**，结果是用户报的这个症状：
 *
 *   「有时候通知不显示，只听见声音了」
 *
 * 两条提醒隔几百毫秒时（审批批准 + 任务完成经常连着来），后一条在前一条
 * 还没画出来时就把它杀了；而声音那时是在 notify 层单独发的，照响不误。
 * 于是听见两声、只看见一个——**丢掉的恰好是先发生的那件事**。
 *
 * 现在改成排队，并且把**声音挪到这一层**：谁真的出现在屏幕上，就谁响。
 * 声音和画面永远对得上，不会再出现「响了但没看到」。
 */

/** 一次最多攒几条。爆发时排队播完要一分钟，那时早就过时了。 */
export const MAX_QUEUE = 3

/**
 * 队列本体，跟「怎么放一条」解耦。
 *
 * 抽出来是为了能测：真实的 runner 会 spawn osascript 往屏幕上弹胶囊，
 * 那样的测试跑 `npm test` 时会满屏乱闪，而且慢。注入一个假 runner
 * 就能把排队、丢弃、串行、hudDone 这些真正容易错的地方全部覆盖。
 *
 * @param run  (item, done) => void —— 开始放一条，放完调 done(code)
 */
export function createHudQueue(run) {
  const queue = []
  let running = false
  const idleWaiters = []

  function pump() {
    if (running) return
    const item = queue.shift()
    if (!item) {
      while (idleWaiters.length) idleWaiters.shift()()
      return
    }
    running = true
    let settled = false
    const done = (code) => {
      if (settled) return // exit 和 error 都可能来，只认第一次
      settled = true
      running = false
      // 非 0 退出说明胶囊根本没画出来（osascript 崩了、被杀、拿不到 WindowServer）。
      // 这类失败以前完全无声——正是这个项目反复踩的那一类，所以留一行。
      if (code) console.error(`[hud] 提示未能显示（退出码 ${code}）`)
      pump()
    }
    try {
      run(item, done)
    } catch (err) {
      console.error(`[hud] 启动失败: ${err.message}`)
      done(0)
    }
  }

  return {
    push(item) {
      queue.push(item)
      // 满了丢**最旧**的：新的状态更有参考价值，积压时旧的那条播出来时早已过期。
      // 丢了要出声——静默丢弃是这个项目明令禁止的。
      while (queue.length > MAX_QUEUE) {
        queue.shift()
        console.warn(`[hud] 提示积压，丢弃最旧的一条（队列上限 ${MAX_QUEUE}）`)
      }
      pump()
    },
    idle() {
      if (!running && !queue.length) return Promise.resolve()
      return new Promise((resolve) => idleWaiters.push(resolve))
    },
    get depth() {
      return queue.length + (running ? 1 : 0)
    },
  }
}

function playSound() {
  try {
    spawn('afplay', ['/System/Library/Sounds/Ping.aiff'], { stdio: 'ignore' }).unref()
  } catch {
    /* 没声音不影响看得见 */
  }
}

const hud = createHudQueue(({ icon, title, subtitle, ms, sound, tint }, done) => {
  const p = spawn(
    'osascript',
    ['-l', 'JavaScript', join(HERE, 'hud.jxa.js'),
      String(icon), String(title ?? ''), String(subtitle), String(ms), String(tint ?? 'plain')],
    // **绝对不能加 detached: true**。它会 setsid() 把子进程放进新会话，
    // 那个会话拿不到 WindowServer——osascript 照常退出码 0，窗口对象也
    // 建得出来，但屏幕上什么都不会有。实测直接在终端跑能弹，
    // 从 node 用 detached 起就不弹，查了很久才定位到这一个选项。
    //
    // 也**不要 unref()**：`clamicro test-push` 这类一次性 CLI 会在 spawn
    // 之后立刻退出，子进程跟着被带走，自检打印「通道是通的」而屏幕上
    // 什么都没有过。见 hudDone()。
    { stdio: 'ignore' },
  )
  if (sound) playSound() // 和画面同时发生，不再各走各的
  p.on('exit', done)
  p.on('error', (err) => {
    console.error(`[hud] 启动失败: ${err.message}`)
    done(0)
  })
})

/**
 * 排一条胶囊。立刻返回，不等它播完。
 *
 * HUD 是锦上添花，任何失败都不该影响调用方——尤其 hook 链路，工具调用
 * 还阻塞着等 HTTP 响应。
 */
export function showHud({ icon = '✓', title, subtitle = '', ms = 2600, sound = false, tint = 'plain' } = {}) {
  hud.push({ icon, title, subtitle, ms, sound, tint })
  return Promise.resolve(true)
}

/**
 * 等队列彻底放完。
 *
 * 给 `clamicro test-push` 这类一次性命令用：它们在 notify 之后立刻
 * `process.exit(0)`，而 HUD 是子进程，进程一走它就没了——自检打印
 * 「提醒通道是通的」，屏幕上却什么都没出现过。**自检不看见就不算通过。**
 * 常驻服务不需要调这个。
 */
export function hudDone() {
  return hud.idle()
}
