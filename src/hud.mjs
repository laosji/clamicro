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
 * 而是一个要维持 ~2.6 秒的子进程。所以：
 *
 *   · 只用在**你人就在屏幕前**的场景（配对成功、设备顶替）
 *   · 审批这类「可能你不在」的提醒仍然走标准通知——它会留在通知中心，
 *     而 HUD 划过去就没了，错过等于没发生
 *
 * 换句话说：HUD 负责「此刻正在发生的事」，通知负责「你回来要看到的事」。
 */

/** HUD 是锦上添花，任何失败都不该影响调用方 */
export function showHud({ icon = '✓', title, subtitle = '', ms = 2600 } = {}) {
  return new Promise((resolve) => {
    try {
      const p = spawn(
        'osascript',
        ['-l', 'JavaScript', join(HERE, 'hud.jxa.js'), String(icon), String(title ?? ''), String(subtitle), String(ms)],
        { stdio: 'ignore', detached: true },
      )
      // 不 await 它跑完：调用方（hook 链路）等不起 2.6 秒
      p.unref()
      p.on('error', () => resolve(false))
      resolve(true)
    } catch {
      resolve(false)
    }
  })
}
