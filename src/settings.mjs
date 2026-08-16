import { readFileSync, existsSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeAtomic } from './atomic.mjs'

export const SETTINGS_FILE = join(homedir(), '.claude', 'settings.json')

// 每个事件对应的端点名与超时。PermissionRequest 是唯一会阻塞的。
export const HOOK_MAP = [
  ['UserPromptSubmit', 'user-prompt-submit', 3, null],
  ['PermissionRequest', 'permission-request', 600, '*'],
  ['PreToolUse', 'pre-tool-use', 3, '*'],
  ['PostToolUse', 'post-tool-use', 3, '*'],
  ['PostToolUseFailure', 'post-tool-failure', 3, '*'],
  ['Notification', 'notification', 3, '*'],
  ['Stop', 'stop', 5, null],
  ['StopFailure', 'stop-failure', 5, null],
  ['SessionEnd', 'session-end', 3, null],
]

function read() {
  if (!existsSync(SETTINGS_FILE)) return {}
  const raw = readFileSync(SETTINGS_FILE, 'utf8')
  try {
    return JSON.parse(raw)
  } catch (err) {
    throw new Error(`${SETTINGS_FILE} 不是合法 JSON，请先修复：${err.message}`)
  }
}

/**
 * 备份原文件。
 *
 * 时间戳精确到**秒**，而同一秒里完全可能写两次（安装流程里连着改，
 * 或者自愈刚好撞上手动 install）。原来第二次会**直接覆盖第一份备份**——
 * 而备份的全部意义就是「回到改动之前」，覆盖掉的恰恰是那个最原始的状态。
 * 实测见过：连跑三轮 install，备份文件数一直是 1。
 *
 * 所以撞名了就往后找一个没被占的。宁可多一个文件，不可少一份原状。
 */
function backup() {
  if (!existsSync(SETTINGS_FILE)) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  let path = `${SETTINGS_FILE}.bak-${stamp}`
  // 上限只是防御性的：同一秒写 50 次已经说明别处有问题，不该在这里死循环
  for (let n = 2; existsSync(path) && n <= 50; n++) path = `${SETTINGS_FILE}.bak-${stamp}-${n}`
  copyFileSync(SETTINGS_FILE, path)
  return path
}

// SessionStart 走 command 而非 http：它顺带负责「服务没在跑就拉起来」，
// 这样打开 Claude Code 就等于服务可用，不必额外装 LaunchAgent。
export const SESSION_START_HOOK = (script) => ({
  matcher: '*',
  hooks: [{ type: 'command', command: script, timeout: 10 }],
})

const isOurs = (h, origin) => h?.type === 'http' && typeof h.url === 'string' && h.url.startsWith(origin)
// 按脚本文件名认，不按路径片段——目录结构变过一次
// （clamicro/bin → clamicro/app/bin），当时卸载就漏掉了 SessionStart。
const OUR_SCRIPTS = ['session-start.sh', 'statusline.sh']
const isOursCmd = (h) =>
  h?.type === 'command' &&
  typeof h.command === 'string' &&
  (h.command.includes('clamicro') || h.command.includes('cc-monitor')) &&
  OUR_SCRIPTS.some((n) => h.command.endsWith(n))

/**
 * 把 hooks 合并进用户的 settings.json。
 *
 * 关键点：对 hooks 数组是**追加**而不是替换。
 * 之前用 `jq '.[0] * .[1]'` 深合并——它对对象递归、对数组整体替换，
 * 会把用户已有的同名事件配置静默吃掉。那是这套东西里唯一能毁坏
 * 既有配置的地方，所以这里逐事件手工处理。
 */
export function install({ port, dryRun = false, statusLinePath, sessionStartPath }) {
  const origin = `http://127.0.0.1:${port}/hooks/`
  const settings = read()
  // 改动前的样子，用来判断这一趟到底改没改（见函数末尾）
  const before = JSON.stringify(settings, null, 2) + '\n'
  const changes = []

  settings.hooks ??= {}
  for (const [event, endpoint, timeout, matcher] of HOOK_MAP) {
    const entry = {
      ...(matcher ? { matcher } : {}),
      hooks: [{ type: 'http', url: `${origin}${endpoint}`, timeout }],
    }
    const list = (settings.hooks[event] ??= [])
    if (!Array.isArray(list)) {
      changes.push({ kind: 'skip', event, why: '已有非数组配置，未改动' })
      continue
    }
    // 已装过就更新（端口可能变了），没装过才追加——用户自己的条目一律保留
    const mine = list.find((g) => g?.hooks?.some((h) => isOurs(h, `http://127.0.0.1:`)))
    if (mine) {
      /**
       * **只换我们自己那一条**，不是整组替换。
       *
       * 原来是 `mine.hooks = entry.hooks`——一整组直接盖掉。可「组」是
       * Claude Code 的分组单位，同一组里完全可以既有我们的 http hook，
       * 也有用户自己的 command hook（同一个 matcher 下挂多个动作是正常写法）。
       * 整组替换会把用户那条**静默删除**：不报错、不提示，`changes` 里
       * 还记成一条平平无奇的 update。
       *
       * 实测复现过：装之前组里有我们的 http + 用户的 my-own-audit-script.sh，
       * 装之后只剩我们的。
       *
       * 这个文件顶上写着「对 hooks 数组是**追加**而不是替换」，还专门记了
       * 一次用 jq 深合并吃掉用户配置的事故。同一条纪律在组内又破了一次——
       * 数组层面遵守了，组内没有。
       */
      const others = mine.hooks.filter((h) => !isOurs(h, 'http://127.0.0.1:'))
      mine.hooks = [...entry.hooks, ...others]
      changes.push({ kind: 'update', event, kept: list.length - 1, keptInGroup: others.length })
    } else {
      list.push(entry)
      changes.push({ kind: 'add', event, kept: list.length - 1 })
    }
  }

  // SessionStart：command 类型，负责「服务没在跑就拉起来」
  {
    let list = (settings.hooks.SessionStart ??= [])
    if (Array.isArray(list)) {
      // 早期版本把 SessionStart 装成了 http hook，现在改成 command，
      // 先把遗留的那条摘掉，否则一次会话会触发两次
      list = list
        .map((g) => (Array.isArray(g?.hooks) ? { ...g, hooks: g.hooks.filter((h) => !isOurs(h, 'http://127.0.0.1:')) } : g))
        .filter((g) => !Array.isArray(g?.hooks) || g.hooks.length)
      settings.hooks.SessionStart = list
      const mine = list.find((g) => g?.hooks?.some((h) => isOursCmd(h)))
      const entry = SESSION_START_HOOK(sessionStartPath)
      if (mine) {
        mine.hooks = entry.hooks
        changes.push({ kind: 'update', event: 'SessionStart', kept: list.length - 1 })
      } else {
        list.push(entry)
        changes.push({ kind: 'add', event: 'SessionStart', kept: list.length - 1 })
      }
    }
  }

  // statusLine 只有一个槽位，不能追加。用户已有别的就不动，只提示。
  const sl = settings.statusLine
  if (!sl) {
    settings.statusLine = { type: 'command', command: statusLinePath }
    changes.push({ kind: 'add', event: 'statusLine' })
  } else if (sl.command === statusLinePath) {
    changes.push({ kind: 'noop', event: 'statusLine' })
  } else if (typeof sl.command === 'string' && isOursCmd({ type: 'command', command: sl.command })) {
    settings.statusLine = { type: 'command', command: statusLinePath }
    changes.push({ kind: 'update', event: 'statusLine' })
  } else {
    changes.push({
      kind: 'conflict',
      event: 'statusLine',
      why: `你已配置了别的状态栏（${sl.command ?? sl.type}），未覆盖。额度数据将无法采集。`,
    })
  }

  if (dryRun) return { changes, backupPath: null }

  /**
   * 内容没变就**不写盘、不备份**。
   *
   * 自愈是每 5 分钟跑一次的。而有一类事件是 install 修不好的——用户把某个
   * hook 事件手写成了非数组（对象、字符串），上面的循环只能 `skip`。
   * 那之后 verifyHooks 会永远报它 missing，于是自愈每 5 分钟重跑一次
   * install，每次都 backup + write：
   *
   *   · 一天 288 个 `settings.json.bak-*`，无上限地堆
   *   · 每次都推一条「hooks 已修复」的通知
   *   · 而实际上**一个字节都没修好**
   *
   * 比较的是序列化后的内容而不是「有没有 change 记录」：skip / noop /
   * conflict 都不改任何东西，只有 add / update 才改。用内容比更直接，
   * 也不会因为将来加了新的 change 类型而漏判。
   */
  const after = JSON.stringify(settings, null, 2) + '\n'
  if (after === before) return { changes, backupPath: null, unchanged: true }

  const backupPath = backup()
  // 原子写：settings.json 写到一半被打断，Claude Code 会起不来
  // （read() 里那句「不是合法 JSON，请先修复」就是给这种情况准备的，
  // 但最好是压根别产生这种情况）。见 src/atomic.mjs
  writeAtomic(SETTINGS_FILE, after)
  return { changes, backupPath }
}

/** 只摘掉我们加过的，用户自己的条目原样保留。 */
/**
 * 我们的 hook 还在不在。
 *
 * ## 为什么需要这个
 *
 * hooks 装完就再也没人看过一眼。可 `~/.claude/settings.json` 是**共享的**：
 * 别的工具也往里写、用户自己也会手改、恢复备份会整个覆盖。一旦我们的条目
 * 没了，表现是**服务照常运行、status 一切正常、就是再也收不到任何东西**——
 * 这正是 NOTES 里记的第 2 号复发故障（「hooks 静默失败」）。
 *
 * 更糟的是 SessionStart 也在里面：它一旦没了，连「打开 Claude Code 自动
 * 拉起服务」都不再发生，而那本来是唯一会定期跑到的检查点。
 *
 * @returns { ok, missing: string[], statusLine: 'ours'|'other'|'missing' }
 */
export function verifyHooks({ port = 8765, statusLinePath } = {}) {
  const settings = read()
  const missing = []
  const ours = (h) => isOurs(h, `http://127.0.0.1:${port}`) || isOursCmd(h)

  for (const [event] of HOOK_MAP) {
    const list = settings.hooks?.[event]
    const found = Array.isArray(list) && list.some((g) => Array.isArray(g?.hooks) && g.hooks.some(ours))
    if (!found) missing.push(event)
  }
  // SessionStart 是 command 类型，单独判
  const ss = settings.hooks?.SessionStart
  if (!Array.isArray(ss) || !ss.some((g) => Array.isArray(g?.hooks) && g.hooks.some(isOursCmd))) {
    missing.push('SessionStart')
  }

  let statusLine = 'missing'
  const cur = settings.statusLine?.command
  if (cur) statusLine = isOursCmd({ type: 'command', command: cur }) ? 'ours' : 'other'

  return { ok: missing.length === 0, missing, statusLine }
}

export function uninstall({ statusLinePath }) {
  /**
   * 没有 settings.json 就**什么都不做**，尤其不要创建它。
   *
   * 卸载在一台从没装过的机器上跑是很常见的（「我好像装过？先卸一下试试」）。
   * 原来这条路会一路走到写盘：`~/.claude` 目录不存在时抛一个 ENOENT 裸栈，
   * 目录存在时则**凭空写出一个 settings.json**——卸载的净效果是多了个文件。
   *
   * 「卸载」的正确下界是「什么都没变」，不是「建一个空的」。
   */
  if (!existsSync(SETTINGS_FILE)) return { removed: [], backupPath: null, absent: true }

  const settings = read()
  const removed = []

  const ours = (h) => isOurs(h, 'http://127.0.0.1:') || isOursCmd(h)

  for (const event of [...HOOK_MAP.map((h) => h[0]), 'SessionStart']) {
    const list = settings.hooks?.[event]
    if (!Array.isArray(list)) continue
    const before = JSON.stringify(list)

    // 先从每个分组里摘掉我们的 hook，再丢掉因此变空的分组；
    // 用户自己的 hook 和分组一律原样保留
    const kept = []
    for (const group of list) {
      if (!Array.isArray(group?.hooks)) {
        kept.push(group)
        continue
      }
      const rest = group.hooks.filter((h) => !ours(h))
      if (rest.length) kept.push({ ...group, hooks: rest })
    }

    if (kept.length) settings.hooks[event] = kept
    else delete settings.hooks[event]
    if (before !== JSON.stringify(kept)) removed.push(event)
  }
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks

  if (isOursCmd({ type: 'command', command: settings.statusLine?.command })) {
    delete settings.statusLine
    removed.push('statusLine')
  }

  const backupPath = backup()
  // 卸载同样要原子写：这一步失败留下半截 settings.json 的话，
  // 用户会得到一个「卸载了 clamicro 结果 Claude Code 打不开」的结局
  writeAtomic(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n')
  return { removed, backupPath }
}
