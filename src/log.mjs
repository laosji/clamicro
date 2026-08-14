/**
 * 给日志加时间戳。
 *
 * ## 为什么需要
 *
 * 服务日志一度是 2836 行、**一个时间戳都没有**。排查一条
 * `[http] POST /api/pair: notify is not a function` 时，能确定的只有「它出现在
 * 某次 `[clamicro] 退出` 之前」——是哪天、离现在多久、和前一条隔了多长时间，
 * 一概答不出来。而事故分析里这几个问题往往就是全部。
 *
 * ## 只给常驻服务加，不给 CLI 加
 *
 * `clamicro qr` 这类命令是**借 server.mjs 跑一次性查询**（见 ONE_SHOT），它们
 * 的输出是给人看的终端内容——二维码、状态表格。给那些行挨个加前缀会把二维码
 * 直接毁掉。所以装钩子的地方要判 ONE_SHOT。
 *
 * ## 为什么是本地时间、精确到秒
 *
 * 这是一台 Mac 上的个人工具，你对照的是「我当时在不在电脑前」，不是 UTC。
 * 精确到秒够用：需要毫秒级的地方（审批从创建到决策隔了多久）在
 * history.json 里有原始 epoch，不靠日志文本还原。
 *
 * 短格式（`08-13 19:45:12`）而不是完整 ISO：日志主要是人 `tail` 着看的，
 * 前缀越短，真正的消息越靠左、越好扫。
 */

import { statSync, openSync, readSync, closeSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 服务日志。原来这个路径在 cli / install / server 各写了一遍。 */
export const LOG_FILE = join(homedir(), 'Library', 'Logs', 'clamicro.log')

const pad = (n) => String(n).padStart(2, '0')

export function stamp(d = new Date()) {
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

let installed = false

/**
 * 把 console.log / warn / error 包一层，每行前面加时间戳。
 *
 * 幂等：装两次不会加两个前缀。
 * 返回一个还原函数，测试用完要能恢复，否则会污染同进程里后面的用例。
 */
export function stampConsole(console_ = console, now = () => new Date()) {
  if (installed) return () => {}
  installed = true
  const orig = {}
  for (const level of ['log', 'warn', 'error']) {
    orig[level] = console_[level].bind(console_)
    console_[level] = (...args) => orig[level](stamp(now()), ...args)
  }
  return () => {
    for (const level of ['log', 'warn', 'error']) console_[level] = orig[level]
    installed = false
  }
}

/**
 * 日志轮转：超过上限就**原地截断**，只留末尾一段。
 *
 * ## 为什么不能改名
 *
 * 服务是被 `nohup node server.mjs >> "$LOG"` 起来的，文件句柄以 O_APPEND 打开
 * 在**shell 那一层**，进程自己并不管理它。经典 logrotate 的「改名 + 新建」在
 * 这里是错的：进程会继续往旧 inode 写，新文件永远是空的，而你以为轮转成功了。
 *
 * 原地截断则是安全的——O_APPEND 的每次写入都会先定位到文件末尾，截短之后
 * 下一行自然落在新的末尾。
 *
 * ## 会丢一点点
 *
 * 读末尾和写回之间如果正好有一行写进来，那一行会丢。窗口是毫秒级、一年也就
 * 发生几次（只在超过上限那一刻检查），对一份诊断日志可以接受。要完全不丢就得
 * 让服务自己持有句柄，那是更大的改动，不值得。
 *
 * ## 截断之后必须留一行说明
 *
 * 否则日志看起来就像从中间被啃掉一块，像损坏。写一行「已截断」把这件事说出来。
 *
 * @param maxBytes  超过它才动手
 * @param keepBytes 保留末尾多少字节
 */
export function rotateLog(file = LOG_FILE, { maxBytes = 2 * 1024 * 1024, keepBytes = 512 * 1024 } = {}) {
  let size
  try {
    size = statSync(file).size
  } catch {
    return null // 还没有日志文件，正常
  }
  if (size <= maxBytes) return null

  let fd
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(Math.min(keepBytes, size))
    readSync(fd, buf, 0, buf.length, size - buf.length)
    closeSync(fd)
    fd = null

    // 从第一个换行之后开始，否则第一行是半截的，看着像日志坏了
    let text = buf.toString('utf8')
    const nl = text.indexOf('\n')
    if (nl >= 0) text = text.slice(nl + 1)

    writeFileSync(file,
      `${stamp()} [log] 日志超过 ${Math.round(maxBytes / 1024)}KB，已截断，` +
      `只保留最近 ${Math.round(keepBytes / 1024)}KB\n${text}`)
    // 用字节数不是 text.length：后者数的是**字符**，而中文一个字 3 字节。
    // 日志里那句「只保留最近 N KB」要是和文件实际大小对不上，
    // 下次有人照着这个数排查就会被带偏
    return { was: size, now: Buffer.byteLength(text, 'utf8') }
  } catch {
    // 轮转失败不该影响服务。日志涨大是小事，服务挂了是大事
    if (fd) { try { closeSync(fd) } catch { /* 已经关了 */ } }
    return null
  }
}
