import { readFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR } from './config.mjs'
import { writeAtomic } from './atomic.mjs'

export const HISTORY_FILE = join(CONFIG_DIR, 'history.json')

// 上限。审批条目比事件重（含命令原文），所以留得少一些。
const MAX_APPROVALS = 300
const MAX_EVENTS = 3000
const DEBOUNCE_MS = 800

/**
 * 审批与事件的落盘。之前全在内存里，服务一重启历史全清——
 * 你手机上任何一条旧通知点开都是「已失效」，而重启在开发期几乎每分钟一次。
 *
 * 写入走防抖 + 临时文件原子替换，避免高频事件把磁盘打满，
 * 也避免进程在写一半时被杀留下半个 JSON。
 */
export class History {
  #timer = null
  #snapshot = () => ({})

  bind(snapshotFn) {
    this.#snapshot = snapshotFn
  }

  load() {
    if (!existsSync(HISTORY_FILE)) return { approvals: [], events: [], nextEventId: 1, limits: null }
    try {
      const d = JSON.parse(readFileSync(HISTORY_FILE, 'utf8'))
      return {
        approvals: Array.isArray(d.approvals) ? d.approvals : [],
        events: Array.isArray(d.events) ? d.events : [],
        nextEventId: Number(d.nextEventId) || 1,
        limits: d.limits ?? null,
      }
    } catch (err) {
      // 坏文件不该让服务起不来。挪走留个证据，从空开始。
      console.error(`[history] ${HISTORY_FILE} 读取失败（${err.message}），已重命名为 .broken`)
      try {
        renameSync(HISTORY_FILE, `${HISTORY_FILE}.broken`)
      } catch {
        /* 挪不动就算了 */
      }
      return { approvals: [], events: [], nextEventId: 1, limits: null }
    }
  }

  /** 标记有变更，防抖后落盘 */
  touch() {
    if (this.#timer) return
    this.#timer = setTimeout(() => {
      this.#timer = null
      this.flush()
    }, DEBOUNCE_MS)
    this.#timer.unref?.()
  }

  flush() {
    try {
      const d = this.#snapshot()
      const payload = {
        version: 1,
        savedAt: Date.now(),
        nextEventId: d.nextEventId ?? 1,
        approvals: (d.approvals ?? []).slice(-MAX_APPROVALS),
        events: (d.events ?? []).slice(-MAX_EVENTS),
        // 额度也要存：它是纯内存的话，每次重启界面就空一次，
        // 而 statusLine 只在 Claude Code 渲染状态栏时才推一次，可能等很久
        limits: d.limits ?? null,
      }
      /**
       * 走 writeAtomic，不再自己手写这三步。原来是
       * `writeFileSync(tmp) → rename → chmod(0600)`，两个毛病：
       *
       *   · **chmod 在 rename 之后**。中间有一瞬间 history.json 是默认的 0644，
       *     而这个文件里装的是命令原文。atomic.mjs 存在的理由之一就是这条，
       *     它的注释写得很清楚——config.json 和 settings.json 都迁过去了，
       *     只有这里还留着旧写法。
       *   · **临时文件名不带 pid**。两个进程同时落盘会互相踩（一次性 CLI 命令
       *     也会经 history.touch 排上一次 flush）。
       */
      writeAtomic(HISTORY_FILE, JSON.stringify(payload), 0o600)
    } catch (err) {
      console.error(`[history] 落盘失败: ${err.message}`)
    }
  }

  /** 进程退出前同步落一次，别丢掉防抖窗口里的变更 */
  flushNow() {
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    this.flush()
  }
}
