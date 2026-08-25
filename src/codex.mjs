/**
 * 把 clamicro 接进本机的 Codex（ChatGPT 的 CLI）。
 *
 * Codex 0.147 起自带一套 hook，事件名和 payload 跟 Claude Code 几乎一样，
 * 所以这里不需要插件宿主、不需要常驻进程：往 ~/.codex/config.toml 里写几段
 * `[[hooks.X]]`，指向一个 curl 中继脚本，事件就流到现成的 /hooks/* 端点了。
 *
 * 这个文件里全部的难点其实只有一个：**在没有 TOML 解析器的前提下改别人的
 * 配置文件**（clamicro 零依赖）。做法见 patchConfig：只认自己的哨兵块，
 * 块外一个字节都不碰。
 */
import { existsSync, readFileSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeAtomic } from './atomic.mjs'

/** 允许用 CODEX_HOME 改写：Codex 自己认这个变量，测试也靠它避开真实配置。 */
export const codexHome = () => process.env.CODEX_HOME || join(homedir(), '.codex')
export const codexConfig = () => join(codexHome(), 'config.toml')

export const BEGIN = '# >>> clamicro >>> 这一段由 npx clamicro install 生成，卸载用 npx clamicro uninstall'
export const END = '# <<< clamicro <<<'

/**
 * Codex 事件 → clamicro 端点 → hook 超时（秒）。
 *
 * 几处跟 Claude Code 那张表（src/settings.mjs 的 HOOK_MAP）不一样的地方：
 *
 *   · **没有 Stop。** 这条最要命，而且一度写错过：这里原本接着 `[[hooks.Stop]]`，
 *     照着 0.147 的文档抄的。0.149 的事件枚举里根本没有它——二进制里
 *     snake_case 和 PascalCase 两份互相印证，一共十个：
 *
 *         pre_tool_use  permission_request  post_tool_use  pre_compact
 *         post_compact  session_start       session_end    user_prompt_submit
 *         subagent_start subagent_stop
 *
 *     错得最阴的地方是 **Codex 照样给它发信任凭证**（配置里会出现
 *     `[hooks.state."…:stop:0:0"]`），所以从任何一个角度看它都像装好了，
 *     而那条 hook 一辈子不会响。表现是会话永远停在「运行中」。
 *     补救不在这张表里——Codex 压根没有回合级的结束事件，只能跟读它的
 *     rollout JSONL，见 src/codex-tail.mjs。
 *   · **没有 Notification / PostToolUseFailure / StopFailure**。同理收不到，
 *     工具失败只能从 PostToolUse 的 payload 里看出来。
 *   · **SessionEnd 只能给 3 秒**。Codex 会把这个事件的超时**强行截到 3s**，
 *     写大了它每次启动都在终端里骂一句
 *     （实测：`warning: clamping SessionEnd hook timeout to 3s`）。
 *     那句警告会挂在用户自己的终端上，而起因是我们写进去的数字。
 *   · **PermissionRequest 给 600 秒**。它是唯一会挂住的一条，必须比 clamicro
 *     自己的审批时限（最长 570s）更长——短了会在用户还在读命令的时候把请求
 *     掐断，而手机上那条审批还挂着，两边状态从此对不上。
 */
export const CODEX_HOOKS = [
  ['SessionStart', 'session-start', 10],
  ['UserPromptSubmit', 'user-prompt-submit', 3],
  ['PermissionRequest', 'permission-request', 600],
  ['PreToolUse', 'pre-tool-use', 5],
  ['PostToolUse', 'post-tool-use', 3],
  ['SessionEnd', 'session-end', 3],
]

/**
 * 这台机器上有没有 Codex。
 *
 * 判据是 config.toml 而不是「PATH 上有 codex」：它多半是 ChatGPT.app 里带的
 * 那份可执行文件，PATH 上根本没有这个名字。同理见 agents.mjs 的 detectAgents。
 */
export function hasCodex({ exists = existsSync } = {}) {
  return exists(codexConfig())
}

/**
 * 这台机器上 codex 可执行文件在哪。
 *
 * PATH 上通常没有——它是 ChatGPT.app 里带的那一份（Codex 已经没有独立
 * 客户端了）。安装提示要把这条路径原样打出来给人复制，所以不能只答「有/没有」。
 * 候选顺序跟 scripts/codex-probe.mjs 保持一致。
 */
export function codexBin({ exists = existsSync } = {}) {
  const candidates = [
    process.env.CODEX_BIN,
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    join(homedir(), '.local', 'bin', 'codex'),
  ].filter(Boolean)
  return candidates.find((c) => exists(c)) ?? null
}

/** TOML 字符串字面量。路径里出现引号/反斜杠的概率极低，但写坏了是整个配置起不来。 */
const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/** 我们要往 config.toml 里写的那一段。两端带哨兵，摘除时靠它认边界。 */
export function hookBlock(port, relayPath) {
  const rows = [
    BEGIN,
    `# 端口 ${port}。改端口请重跑安装，别手改这里——改完 Codex 会要求你重新信任 hooks。`,
  ]
  for (const [event, endpoint, timeout] of CODEX_HOOKS) {
    rows.push(
      '',
      `[[hooks.${event}]]`,
      // matcher 只对带工具名的事件有意义，其余事件写了也是空转
      ...(endpoint.includes('tool') ? ['matcher = "*"'] : []),
      `hooks = [{ type = "command", command = ${q(`${relayPath} ${endpoint}`)}, timeout = ${timeout} }]`,
    )
  }
  rows.push('', END, '')
  return rows.join('\n')
}

/** 找出哨兵块的行区间。返回 [start, end]（含），没有就返回 null。 */
function blockRange(lines) {
  const start = lines.findIndex((l) => l.startsWith('# >>> clamicro >>>'))
  if (start === -1) return null
  const end = lines.findIndex((l, i) => i > start && l.trim() === END)
  // 只有开头没有结尾：说明有人手工改坏了。这时候**不猜边界**，交给调用方
  // 提示人自己收拾——猜错会把用户后面写的配置一起删掉。
  return end === -1 ? { start, end: -1 } : { start, end }
}

function backup(file, { exists = existsSync, copy = copyFileSync } = {}) {
  if (!exists(file)) return null
  // 备份策略跟 settings.mjs 一致：撞名了往后找，宁可多一个文件，不可少一份原状
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  let path = `${file}.bak-${stamp}`
  for (let n = 2; exists(path) && n <= 50; n++) path = `${file}.bak-${stamp}-${n}`
  copy(file, path)
  return path
}

/**
 * 把 hooks 写进 ~/.codex/config.toml。
 *
 * ## 为什么是「哨兵块」而不是解析 TOML
 *
 * clamicro 零依赖，手里没有 TOML 库。而 config.toml 是用户自己的文件——
 * 那台机器上的这份就有 MCP server、插件开关、模型配置几十行。用正则去理解
 * 别人的 TOML，等于用一个必然不完整的解析器改一份不能坏的文件。
 *
 * 所以这里从不「理解」配置，只做两件事：把上一版的哨兵块整段删掉，把新的
 * 整段追加到文件末尾。块外的任何一个字节都不读也不动。
 *
 * 追加到末尾是安全的：块里全是 `[[hooks.X]]` 表头，TOML 里表头一出现就开
 * 新表，不会被上一个表吞进去。反过来如果插在中间，就有可能把用户某个表的
 * 后半截切到我们的表名下面——那是这个函数唯一能造成的灾难，所以不插中间。
 *
 * @returns {{action:'created'|'patched'|'already'|'manual', backup:string|null}}
 */
export function patchConfig(port, relayPath, {
  read = readFileSync,
  write = writeAtomic,
  exists = existsSync,
  copy = copyFileSync,
} = {}) {
  const file = codexConfig()
  const block = hookBlock(port, relayPath)

  if (!exists(file)) {
    // 没有 config.toml 就不该有这一步：hasCodex() 用的就是它。走到这里说明
    // 文件在探测之后被删了，新建一份只有 hooks 的配置反而会让人困惑。
    return { action: 'manual', backup: null }
  }

  const text = read(file, 'utf8')
  const lines = text.split('\n')
  const range = blockRange(lines)

  if (range && range.end === -1) return { action: 'manual', backup: null }
  if (range) {
    const current = lines.slice(range.start, range.end + 1).join('\n')
    // 一字不差就别写：Codex 的 hook 信任是按内容哈希算的，重写一遍等于让
    // 用户重新点一次「信任」。见 §信任门。
    if (current.trim() === block.trim()) return { action: 'already', backup: null }
  }

  const kept = range ? [...lines.slice(0, range.start), ...lines.slice(range.end + 1)] : lines
  const head = kept.join('\n').replace(/\n+$/, '')
  const next = (head ? head + '\n\n' : '') + block

  const backupPath = backup(file, { exists, copy })
  write(file, next)
  return { action: range ? 'patched' : 'created', backup: backupPath }
}

/**
 * 摘除。卸载的正确下界是「什么都没变」，所以只删哨兵块本身。
 *
 * 半个块（只有开头）同样不猜边界：宁可留下几行注释，也不能删掉用户的配置。
 */
export function unpatchConfig({
  read = readFileSync,
  write = writeAtomic,
  exists = existsSync,
  copy = copyFileSync,
} = {}) {
  const file = codexConfig()
  if (!exists(file)) return { removed: false, backup: null }

  const lines = read(file, 'utf8').split('\n')
  const range = blockRange(lines)
  if (!range || range.end === -1) return { removed: false, backup: null, partial: !!range }

  const kept = [...lines.slice(0, range.start), ...lines.slice(range.end + 1)]
  const backupPath = backup(file, { exists, copy })
  write(file, kept.join('\n').replace(/\n{3,}$/, '\n'))
  return { removed: true, backup: backupPath }
}

/**
 * 我们的 hooks 还在不在。
 *
 * 跟 settings.mjs 的 verifyHooks 是同一个理由：config.toml 是共享文件，
 * 用户会手改、Codex 自己也会往里写（trusted_hash 就是它写的）。条目没了的
 * 表现是「服务照常、Codex 会话再也不出现」——静默失败，没有任何报错。
 *
 * `trustSeen` 这一项是 Codex 特有的：hooks 写好了但没被信任，行为**跟没装
 * 一模一样**（实测：不报错、不提示、hook 一次都不执行）。所以它必须能被
 * 单独看见，否则用户只会得到「装好了但没用」这个结论。
 */
export function verifyConfig(port, { read = readFileSync, exists = existsSync } = {}) {
  const file = codexConfig()
  if (!exists(file)) return { ok: false, present: false, missing: CODEX_HOOKS.map(([e]) => e), trustSeen: false }

  const text = read(file, 'utf8')
  const lines = text.split('\n')
  const range = blockRange(lines)
  if (!range || range.end === -1) {
    return { ok: false, present: false, missing: CODEX_HOOKS.map(([e]) => e), trustSeen: false }
  }

  const block = lines.slice(range.start, range.end + 1).join('\n')
  const missing = CODEX_HOOKS.filter(([e]) => !block.includes(`[[hooks.${e}]]`)).map(([e]) => e)
  const portOk = block.includes(`# 端口 ${port}`)
  /**
   * 信任状态：**这是一次观察，不是一个判决。**
   *
   * 已知的只有「hooks.state 是一张 map」（往里写 `enabled = true` 会被报成
   * expected struct HookStateToml）。Codex 真正写入信任之后长什么样，我们
   * **没有见过**——可能是 [hooks.state.<something>]，可能是内联表，也可能
   * 压根不写在 config.toml 里。
   *
   * 所以字段叫 trustSeen 而不是 trusted：判不到只能说「没在这份配置里看到
   * 信任记录」。当成「未信任」去报，一旦猜错就是一条**永远消不掉**的告警，
   * 而用户明明点过信任、事件也正常到达。一条永远亮着的警告会训练人忽略
   * 这一行，可这一行正是为真故障准备的。
   */
  const trustSeen = /^\s*\[hooks\.state[.\]]/m.test(text)

  return { ok: !missing.length && portOk && trustSeen, present: true, missing, portOk, trustSeen }
}

/**
 * 安装器里那段「问一句、写配置、说清楚下一步」的流程。
 *
 * 跟 dsh.mjs 的 wireUp 一样从 install.mjs 里抽出来，为的是能被断言——尤其是
 * 最后那段信任提示：它是这条链路上**唯一**必须由人完成的动作，漏说一句，
 * 用户拿到的就是一套装好了但一条事件都不来的东西。
 *
 * @param confirm (问题, optIn) => Promise<boolean>。optIn=true 表示 --yes 也不替用户答应
 */
export async function wireUp({
  port,
  relayPath,
  confirm,
  say,
  ui = {},
  detect = hasCodex,
  patch = patchConfig,
} = {}) {
  const t = { b: (s) => s, dim: (s) => s, g: (s) => s, y: (s) => s, ...ui }
  if (!detect()) return { action: 'no-codex' }

  say('')
  say(`  ${t.b('检测到 Codex')} ${t.dim(codexConfig())}`)
  say(`  ${t.dim('接上之后，Codex 的会话也会出现在手机上，首页按后端分开显示。')}`)
  say(`  ${t.dim('注意：现在只做状态镜像，Codex 的操作还不走手机审批（原因见 src/agents.mjs 的 codex 条）。')}`)

  // optIn=true：这会写另一个产品的配置，`--yes` 不该把它捎带过去
  if (!await confirm(`  要现在接上吗？${t.dim(`（会写 ${codexConfig()}，先备份）`)}`, true)) {
    say(`  ${t.dim('跳过。以后想接：重跑 npx clamicro install')}`)
    return { action: 'declined' }
  }

  /**
   * 包一层。理由跟 dsh.mjs 的 wireUp 一字不差：**接第二个后端失败，不该让
   * 整个安装失败。**
   *
   * 这个调用在安装流程的最末尾，而它写的是别人家的文件——只读的
   * config.toml、被企业管控的 ~/.codex、放在只读同步盘上，都会让
   * writeAtomic 抛 EACCES。异常一路冒到 install.mjs 的顶层 await，结果是：
   * hooks 早就写好了、服务早就起来了、配对地址早就打印了，用户看到的却是
   * 一段 Node 堆栈，而后面「配对完发一条测试审批」那些收尾提示一句都不会
   * 出现。他会以为整个安装失败了，然后去重跑或者卸载。
   */
  let r
  try {
    r = patch(port, relayPath)
  } catch (e) {
    say(`  ${t.y('⚠ 接 Codex 没成功：')}${e.message}`)
    say(`  ${t.dim('Claude Code 那条链路不受影响。手动接法见 docs/codex-bridge.zh-CN.md')}`)
    return { action: 'failed', error: e.message }
  }

  if (r.action === 'manual') {
    say(`  ${t.y('⚠')} ${codexConfig()} 里那段 clamicro 配置只剩半截（有开头没结尾），没敢动。`)
    say(`  ${t.dim('把 # >>> clamicro >>> 那一行连同后面属于它的内容删掉，再重跑一次。')}`)
    return { action: 'manual' }
  }
  if (r.action === 'already') {
    say(`  ${t.dim('配置已是最新，没重写')} ${t.dim('（重写会让 Codex 要求你重新信任一次 hooks）')}`)
  } else {
    say(`  ${t.g('✓')} 已写入 ${t.dim(codexConfig())}${r.backup ? t.dim(`（备份：${r.backup}）`) : ''}`)
  }

  /**
   * 信任提示。**这段不能省，也不能弱化成「顺便说一句」。**
   *
   * Codex 对 hooks 有一道信任闸门：配置里写了 hooks，但没有对应的
   * trusted_hash 时，它**一条都不执行**——不报错、不提示、终端里干干净净。
   * 实测过：配置写好、服务跑着、Codex 正常干活，clamicro 这边一个事件都
   * 没收到，而所有能看的地方都显示「已安装」。
   *
   * 这正是 NOTES 里 2 号复发故障（hooks 静默失败）的形状，区别只是这次的
   * 起因不是配置丢了，而是配置从来没生效过。所以把它摆在最后、单独一段。
   */
  say('')
  say(`  ${t.y('还差一步（必须做，否则等于没装）：')}`)
  /**
   * 这里原来写的是「打开一次 Codex 并同意」，而那句话对多数人是**空话**。
   *
   * 信任提示只在**交互式 TUI** 里出现。而现在 Codex 没有独立客户端了——
   * 它就在 ChatGPT.app 里，多数人是从桌面 App 或 VS Code 扩展用它的，
   * 那两条路都不是 TUI，**打开一百次也不会被问**。真机上就是这么卡住的：
   * 配置写对了、服务跑着、Codex 正常干活，事件一条不来，而每一项检查
   * 都显示「已安装」。
   *
   * 所以这里必须给出**那条命令本身**。codex 一般不在 PATH 上（它是
   * ChatGPT.app 里带的那一份），路径也得写全。
   */
  say(`  ${t.dim('在终端里跑一次下面这条，它会问你是否信任这份 hooks 配置——点同意：')}`)
  say(`  ${t.dim(`  ${codexBin() ?? '<codex 可执行文件>'}`)}`)
  say(`  ${t.dim('点完直接退出即可，不用发消息。从 ChatGPT App / VS Code 里打开是问不到这一步的。')}`)
  say(`  ${t.dim('没点之前，Codex 会把 hooks 静默跳过：不报错、不提示，clamicro 一条事件都收不到。')}`)
  say(`  ${t.dim('以后每次改动这段配置（比如换端口），都要再确认一次。')}`)

  return { action: r.action, backup: r.backup ?? null }
}
