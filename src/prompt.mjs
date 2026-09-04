/**
 * 安装器的问答。
 *
 * ## 为什么自己缓冲行队列，而不是用 `rl.question()`
 *
 * 管道输入（`printf 'y\nn\n' | node install.mjs`）时 stdin 会立刻 EOF，
 * readline 把所有行一次性发完——第二行在第二次提问注册之前就丢了，随后 EOF，
 * `question()` 的 promise 永不 settle，进程挂死。队列 + 关闭时回落默认值可以
 * 同时覆盖 TTY 和管道。
 *
 * ## 为什么从 install.mjs 里抽出来
 *
 * 这里有一条**安全相关**的不变式：`optIn` 的问题谁都不许代答。它写的是别人
 * 家的配置（`~/.dsh/profiles`、`~/.codex/config.toml`），所以连 `--yes` 都不
 * 替用户答应。
 *
 * 而这条不变式此前是破的，而且破在一条没人会想到的路径上：`closePrompt()`
 * 之后再问，`closed` 已经为真，`confirm()` 会把问题打在屏幕上、把「没人能
 * 回答」折成空行、按默认值答「是」，然后接着往下走。安装流程恰恰在
 * closePrompt 之后才问 DSH / Codex——于是那两个文件被改了，而用户一个字都
 * 没输入。
 *
 * 留在 install.mjs 里就只能靠人肉跑一遍安装才看得见（而且要在一台正好装了
 * DSH 或 Codex 的机器上）。抽出来之后 test/prompt.test.mjs 逐条钉住。
 * 同样的理由见 src/dsh.mjs 的 wireUp。
 */
import { createInterface } from 'node:readline/promises'

/**
 * @param input   读哪个流。默认 process.stdin，测试传假的进来
 * @param output  往哪写提示。默认 process.stdout
 * @param yes     `--yes` / `-y`。为真时不问，直接按「非 optIn 才同意」返回
 * @param dim     给 `[Y/n]` 之类加装饰。默认原样返回
 */
export function makePrompt({
  input = process.stdin,
  output = process.stdout,
  yes = false,
  dim = (s) => s,
} = {}) {
  let rl = null
  const queued = []
  const waiting = []
  let closed = false

  function init() {
    if (rl) return
    rl = createInterface({ input })
    rl.on('line', (line) => (waiting.length ? waiting.shift()(line) : queued.push(line)))
    rl.on('close', () => {
      closed = true
      while (waiting.length) waiting.shift()(null) // 没人能回答了，见下
    })
  }

  /**
   * @param q      问题
   * @param optIn  true 表示这一项**谁都不许代答**：`--yes` 不算同意，
   *               stdin 关掉了也不算同意。改别人家配置的操作用它。
   */
  async function confirm(q, optIn = false) {
    if (yes) return !optIn
    init()
    output.write(`${q} ${dim('[Y/n]')} `)
    const line = queued.length
      ? queued.shift()
      : closed
        ? null // stdin 已经没了，没人能回答这一问
        : await new Promise((resolve) => waiting.push(resolve))

    /**
     * **「没人能回答」和「回答了个空行」是两件事。**
     *
     * 原来两者都折成 `''`，于是都走了「默认是」。管道输入 EOF 时那是对的
     * （`printf 'y\n' | install` 只答了第一问，后面的按默认走），但
     * `closePrompt()` 之后再问就成了自问自答，见文件头。
     *
     * 所以只有 optIn 的问题按「没答应」算，普通问题保留原来的管道语义。
     */
    if (line === null) {
      output.write(optIn ? `${dim('（没有输入，按未同意处理）')}\n` : '\n')
      return !optIn
    }

    // 管道和已关闭的情况下终端不会回显，自己补一行，否则日志里看不出答了什么
    if (closed || !input.isTTY) output.write(`${line}\n`)
    const a = line.trim().toLowerCase()
    return a === '' || a === 'y' || a === 'yes'
  }

  /** 问完了就放开 stdin，否则进程挂着不退。 */
  function close() {
    rl?.close()
    input.unref?.()
  }

  return { confirm, close, get closed() { return closed } }
}
