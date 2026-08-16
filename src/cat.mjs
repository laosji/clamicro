/**
 * 把像素猫画进终端。
 *
 * 只在 `clamicro qr` 用。**不进 statusLine**：那里是一行，而半块最多两倍压缩，
 * 16×16 要 8 行；真塞进去只能退化成一个颜文字，那就不是这套美术了。何况
 * 状态栏最右边那段是「⏳ N 条待审批」——一个专门用来别漏审批的工具，
 * 拿待审批数去换一只猫是亏的。
 *
 * 放在 qr 是因为职责对得上：猫在 DSH 网页里的**唯一作用**就是点一下把配对
 * 二维码叫出来。`clamicro qr` 是同一件事换了个界面，不是随手贴的吉祥物。
 */
import { palette, canvas, grid } from './cat-art.mjs'

const hex = (h) => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
]

/**
 * xterm-256 里最接近的一格。
 *
 * 原本打算「探不到真彩就干脆不画」，怕降级成一坨糊的颜色。想清楚之后改了：
 * 那个担心针对的是照片和渐变，而这只猫只有 **6 个纯色块**，没有任何过渡。
 * 6 个平涂色映射到 256 色立方体，肉眼几乎看不出差别。而 Apple 的
 * Terminal.app 到今天也不报真彩——「干脆不画」等于让相当一部分 macOS 用户
 * 永远看不到，还以为是坏了。所以降级，但只降到 256，再往下（16 色）才放弃。
 */
function xterm256(r, g, b) {
  // 6×6×6 色立方 (16-231) + 灰阶 (232-255)，逐个比欧氏距离取最近
  let best = 16
  let bestD = Infinity
  const cube = [0, 95, 135, 175, 215, 255]
  for (let i = 0; i < 216; i++) {
    const cr = cube[Math.floor(i / 36) % 6]
    const cg = cube[Math.floor(i / 6) % 6]
    const cb = cube[i % 6]
    const d = (cr - r) ** 2 + (cg - g) ** 2 + (cb - b) ** 2
    if (d < bestD) { bestD = d; best = 16 + i }
  }
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10
    const d = (v - r) ** 2 + (v - g) ** 2 + (v - b) ** 2
    if (d < bestD) { bestD = d; best = 232 + i }
  }
  return best
}

/**
 * 这个终端能画到什么程度：'truecolor' | '256' | null。
 *
 * NO_COLOR 是跨工具的约定，优先级最高。非 TTY 一律不画——输出被重定向到
 * 文件或管道时，一屏 ANSI 转义字符是纯污染。
 */
export function colorDepth(env = process.env, stream = process.stdout) {
  if (env.NO_COLOR) return null
  if (!stream?.isTTY) return null

  const ct = String(env.COLORTERM ?? '').toLowerCase()
  if (ct === 'truecolor' || ct === '24bit') return 'truecolor'
  // iTerm2 支持真彩但不设 COLORTERM
  if (env.TERM_PROGRAM === 'iTerm.app') return 'truecolor'

  const term = String(env.TERM ?? '')
  if (/256(color)?/.test(term)) return '256'
  // Apple Terminal.app：TERM 通常是 xterm-256color，上面那条就接住了；
  // 万一没有，它至少是 256 色，别退到 16 色去糟蹋这几个橙。
  if (env.TERM_PROGRAM === 'Apple_Terminal') return '256'

  return null
}

const fg = (depth, h) => {
  const [r, g, b] = hex(h)
  return depth === 'truecolor' ? `\u001b[38;2;${r};${g};${b}m` : `\u001b[38;5;${xterm256(r, g, b)}m`
}
const bg = (depth, h) => {
  const [r, g, b] = hex(h)
  return depth === 'truecolor' ? `\u001b[48;2;${r};${g};${b}m` : `\u001b[48;5;${xterm256(r, g, b)}m`
}

/**
 * 渲染成若干行。
 *
 * 半块 `▀`：一个字符格装**上下两个**像素——上半走前景色，下半走背景色。
 * 于是 16×16 变成 16 列 × 8 行，而终端字符格大约是 1:2，画出来接近正方。
 *
 * 每格结尾都 reset：不 reset 的话背景色会一路流到行尾，在窄终端上拖出一条
 * 橙色长条。
 */
export function catLines({ depth = colorDepth(), pad = '  ' } = {}) {
  if (!depth) return []
  const { width: w, height: h } = canvas
  const lines = []
  for (let y = 0; y < h; y += 2) {
    let line = pad
    for (let x = 0; x < w; x++) {
      const top = palette[grid[y]?.[x]]
      const bot = palette[grid[y + 1]?.[x]]
      if (!top && !bot) { line += ' '; continue }
      let s = ''
      if (top) s += fg(depth, top)
      if (bot) s += bg(depth, bot)
      line += `${s}▀\u001b[0m`
    }
    lines.push(line.replace(/\s+$/, ''))
  }
  return lines
}

/** 画不出来就返回空串，调用方直接打印即可，不必自己判断。 */
export function catBlock(opts = {}) {
  const lines = catLines(opts)
  return lines.length ? `${lines.join('\n')}\n` : ''
}
