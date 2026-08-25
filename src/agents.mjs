import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, delimiter } from 'node:path'

/**
 * 后端（agent）能力矩阵。
 *
 * ## 为什么需要这张表
 *
 * 接入第二个后端之后，「这个会话能不能暂停」不再是全局常量了。
 * Clamicro 的暂停、取消、发消息三件事全都建立在 Claude Code 的特有原语上：
 *
 *   · 暂停/取消 —— 靠 PreToolUse 这个拦截点把下一次工具调用挂住（src/control.mjs）
 *   · 发消息   —— 靠 Stop hook 返回 {decision:'block', reason} 往回注入
 *                （src/routes/hooks.mjs，那里的注释写着「唯一能往里发的口子」）
 *
 * 换个后端，这些原语不一定存在。而**按钮在那儿、点了没反应**比没有按钮更糟：
 * 用户会以为暂停成功了，然后走开。这跟「宁可没有审批功能，也不能做一个
 * 审批了但操作其实已经执行的假审批」是同一条原则，只是推广到了控制面上。
 *
 * 所以能力在这里声明，UI 按能力渲染，缺失的入口直接不给。
 *
 * **服务端也按这张表拦。** 只靠 UI 是不够的：capOf 在配置还没到手时回退成
 * 「全都支持」，而手机上缓存着升级前的页面正是这个状态。原来端点谁都收，
 * 于是对一个 DSH 会话点暂停会返回 ok、界面显示「已暂停」、DSH 照跑；
 * 发一条消息会被下一次 stop 上报排空、记成「已注入」，而它哪儿也没去。
 * 「按钮点了没反应」已经够糟，「按钮点了看起来生效了」更糟。
 * 拦的位置：src/routes/api.mjs 的 control / say，src/routes/hooks.mjs 的
 * permission-request。见 test/agent-caps.test.mjs。
 *
 * ## 加新后端时
 *
 * 默认值一律取**保守**的那一侧（能力为 false）。没验证过的原语按不存在处理——
 * 漏给一个入口，用户会来问；多给一个不工作的入口，用户不会来问，他只会
 * 以为这东西坏了。
 */

/** 额度形态。不同后端的「还能用多少」根本不是同一种东西。 */
export const QUOTA = {
  /** 滚动窗口配额（Claude Code：5 小时 / 7 天窗口，来自 statusLine） */
  WINDOW: 'window',
  /** 只有累计消耗，没有窗口概念（DSH：按 API key 计费，只能统计 token/花费） */
  TOKENS: 'tokens',
  /**
   * 什么都拿不到。
   *
   * **当前没有后端用这一档**——Codex 曾经是，理由写的是「hook payload 里
   * 既没有窗口也没有 token 数」。那句话对 hook 通道成立，但接上 rollout
   * 跟读之后（src/codex-tail.mjs），TokenCount 就看得见了，于是它改成了
   * TOKENS。留着这一档是因为 agentUsage 认它，将来接一个真的什么都不报的
   * 适配器时不必重新发明：**空着和「不上报」必须分得开**，都显示成空白的话，
   * 用户会一直等一个永远不会出现的数字。
   */
  NONE: 'none',
}

export const AGENTS = {
  'claude-code': {
    label: 'Claude Code',
    approve: true,
    pause: true,
    cancel: true,
    inbox: true,
    quota: QUOTA.WINDOW,
    /** 取消操作的说明文案：不同后端「取消」的实际效果不一样，别写死 */
    cancelNote: 'Claude Code 会在下一个工具调用前终止本轮任务。',
  },

  /**
   * DeepSeek Harness。见 docs/dsh-bridge.zh-CN.md。
   *
   * approve 为真：DSH 有公开的 approval/request waterfall 事件，答复器可以
   * 返回 Promise，能力等价于 Claude Code 的阻塞式审批。
   *
   * cancel / inbox 填 false 的理由不是「DSH 做不到」——实测 dsh-agent 里
   * `ctx.agents.get(id)` 能拿到 Agent，它有一等公民的 `cancel()` 和
   * `followup()`，比 Claude Code 那两个 hack 干净得多。填 false 是因为
   * **clamicro 这边的控制端点还没接**。
   *
   * 这张表描述的是「现在能不能做到」，不是「协议允不允许」。提前填 true
   * 会在手机上留一个点了没反应的按钮，那正是这张表存在的意义所在。
   * 接上之后再改，见 docs/dsh-bridge.zh-CN.md §6.1。
   *
   * pause 是真的没有：whenIdle() / runMaintenance() 都不是暂停原语。
   */
  dsh: {
    label: 'DeepSeek Harness',
    approve: true,
    pause: false,
    cancel: false,
    inbox: false,
    quota: QUOTA.TOKENS,
    cancelNote: null,
  },

  /**
   * OpenAI Codex —— ChatGPT 那个 CLI。见 docs/codex-bridge.zh-CN.md。
   *
   * 接它比接 DSH 便宜得多：hook 系统跟 Claude Code 大体同构——payload 字段
   * 一样（session_id / cwd / tool_name / tool_input / …），输出也是同一套
   * hookSpecificOutput。所以桥接只是一层 curl 中继，没有第二个进程、
   * 没有插件宿主。
   *
   * 但**不是「一字不差」**，这句话曾经写在这里，是错的：0.149 的事件枚举里
   * 没有 `Stop`。Codex 根本没有回合级的结束事件，会话走不出 Running——
   * 那一段靠跟读 rollout JSONL 补，见 src/codex-tail.mjs 和 src/codex.mjs
   * 里 CODEX_HOOKS 上面那段。
   *
   * ## approve 为什么是 false
   *
   * 不是缺口子：PermissionRequest 在，PreToolUse 也在，中继脚本和服务端的
   * 应答形状都已经写好了。填 false 是因为**「拒绝」这一路没在真机上跑通过**。
   * 两件事撞在一起挡住了验收：本机 Codex 的额度用尽，而 Codex 的 hook 要先
   * 被「信任」才会执行（见文档 §3，未信任是**静默跳过**）。deny 的线格式
   * 目前只对着二进制里的类型名核过，没让 Codex 真的因此挡下过一条命令。
   *
   * 而这一条恰恰最不能猜。猜错的表现不是「按钮点了没反应」，是手机上写着
   * 「已拒绝」、命令照样跑完——一个假审批。宁可先只做镜像。
   * 跑通 docs/codex-bridge.zh-CN.md §4 的验收之后把这里改成 true，别处不用动。
   *
   * 这个 false 是**真的生效的**：permission-request 端点据它直接回
   * 「无意见」，不建审批记录、不推手机，落回 Codex 自己的权限流程。
   * （它一度只是纸面声明——那时 hooks 里接着 PermissionRequest，审批照样
   * 跑完整套，等于把这条还没验证过的拒绝路径直接上了生产。）
   *
   * pause / cancel / inbox 同理，但理由比原来更硬：原来写的是「拦截点都在
   * （PreToolUse 认 continue、Stop 认 decision:block），没验证就按不存在算」
   * ——而 **Stop 这个事件在 Codex 里压根不存在**，所以那半条拦截点不是
   * 「没验证」，是**没有**。PreToolUse 那半条还在，但单靠它拦不住一个
   * 不调工具的回合。
   */
  codex: {
    label: 'Codex',
    approve: false,
    pause: false,
    cancel: false,
    inbox: false,
    /**
     * 用量走 rollout，不走 hook。
     *
     * 这里一度是 NONE，理由是「hook payload 里既没有窗口也没有 token 数」
     * ——对 hook 通道成立，但 TokenCount 事件就落在 rollout 里，跟读那条路
     * 看得见（src/codex-tail.mjs 的 parseLine）。取的是 `info.
     * total_token_usage.total_tokens`，语义和 DSH 的累计 token 一致，
     * 所以走的是同一条渲染路径，UI 不必知道数字是从哪来的。
     *
     * 额度耗尽时 Codex 报的 token_count 里 info 整个是 null，那时不写数字、
     * 也不把 usage_reported 置 false——界面显示「还没跑完一轮」，而不是
     * 谎称「该后端不上报用量」。
     *
     * 同一条事件里还有 rate_limits.primary 的窗口百分比（used_percent /
     * window_minutes: 43200 / resets_at）。没用上：现有的 limits 模型是写死的
     * five_hour + seven_day，而 Codex 是单个 30 天窗口，塞不进去。
     */
    quota: QUOTA.TOKENS,
    cancelNote: null,
  },
}

export const DEFAULT_AGENT = 'claude-code'

/**
 * 取某个后端的能力。
 *
 * 认不出来的后端**落回 Claude Code**，不是落回空能力：
 * 老版本的 hook 不带 agent 字段，落回空能力会让所有现存会话的暂停按钮
 * 一夜之间消失。未知即旧版，这是升级期唯一安全的假设。
 */
export function capOf(agent) {
  return AGENTS[agent] ?? AGENTS[DEFAULT_AGENT]
}

/** 上报进来的 agent 值是否认得。认不得就当没写，交给 DEFAULT_AGENT。 */
export function normalizeAgent(agent) {
  return typeof agent === 'string' && AGENTS[agent] ? agent : DEFAULT_AGENT
}

/**
 * 本机装了哪些后端。
 *
 * ## 为什么要探测，而不是让用户选
 *
 * 「你用的是哪个 harness」这个问题，机器自己看一眼就知道，没有理由摆到
 * 用户面前。让人选还会引入一类只可能出错的状态：选了 DSH 但根本没装，
 * 于是手机上挂着一个永远不会有会话的后端，而用户以为是 clamicro 坏了。
 *
 * ## 探测结果只用来「说人话」，不用来决定能力
 *
 * 能力查询走 capOf()，它对任何会话都给得出答案——**哪怕探测说这个后端
 * 没装**。因为探测可能是错的（装在非标准路径、PATH 没继承过来），而这时
 * 真实存在的会话正在上报。让探测结果去否决一个活生生的会话的能力，
 * 会把「探测不准」升级成「审批按钮消失」。
 *
 * 所以它只影响文案：空状态里该提示新开哪种会话。
 */
function onPath(bin) {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  // 也看一眼常见的用户级安装位置：GUI 启动的进程（LaunchAgent、从 Finder 打开）
  // 拿到的 PATH 往往只有 /usr/bin:/bin，装在 ~/.local/bin 的东西全看不见
  const extra = [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
  return [...dirs, ...extra].some((d) => existsSync(join(d, bin)))
}

let cached = null

/** @returns {string[]} 认得且看起来装了的后端 key */
export function detectAgents() {
  // 探测走文件系统，每次请求都做没必要；进程内缓存一次就够——
  // 装新后端属于要重启服务的操作
  if (cached) return cached
  const found = []
  if (existsSync(join(homedir(), '.claude', 'settings.json'))) found.push('claude-code')
  if (onPath('dsh')) found.push('dsh')
  /**
   * Codex 不能按 PATH 探。
   *
   * 它多半是 ChatGPT.app 里带的那份可执行文件
   * （/Applications/ChatGPT.app/Contents/Resources/codex），PATH 上通常没有
   * `codex` 这个名字——按 onPath 探等于永远探不到，而这台机器上明明装着。
   * 所以看它的配置目录：config.toml 存在就说明这东西被真正跑起来过。
   */
  if (existsSync(join(homedir(), '.codex', 'config.toml'))) found.push('codex')
  // 一个都没探到时不要返回空数组：那会让空状态变成「新开一个  会话即可」。
  // 探不到多半是探测本身的问题，不是真的什么都没装
  cached = found.length ? found : [DEFAULT_AGENT]
  return cached
}
