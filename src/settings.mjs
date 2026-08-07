import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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

function backup() {
  if (!existsSync(SETTINGS_FILE)) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const path = `${SETTINGS_FILE}.bak-${stamp}`
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
      mine.hooks = entry.hooks
      changes.push({ kind: 'update', event, kept: list.length - 1 })
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
  const backupPath = backup()
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n')
  return { changes, backupPath }
}

/** 只摘掉我们加过的，用户自己的条目原样保留。 */
export function uninstall({ statusLinePath }) {
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
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n')
  return { removed, backupPath }
}
