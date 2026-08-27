/**
 * clamicro-dsh-bridge —— 把 DeepSeek Harness 的会话桥接到 Clamicro 手机端。
 *
 * 设计与取舍见 clamicro 仓库的 docs/dsh-bridge.zh-CN.md。这里只重复三条
 * 写代码时必须记住的：
 *
 *   1. **状态上报不能阻塞**。插件跑在 DSH 主进程内，await 一个卡住的本地
 *      服务就是拖住 DSH 的事件循环。见 lib/report.js 的 send()。
 *   2. **审批必须等**，而且失败必须交回人类。DSH 是 fail-closed：答复器
 *      抛异常 = `unavailable` = 不授予。clamicro 挂掉时如果让异常冒出去，
 *      DSH 的所有待审批工具调用会全被拒。
 *   3. **参数不知道 ≠ 没有参数**。ApprovalRequest 不带工具参数，靠 callId
 *      回查；查不到时必须显式说「不知道」，不能传个空对象——clamicro 的
 *      风险评估会把空参数打成低风险，而真实情况是未知。
 *
 * 当前进度：M1（事件订阅 + 参数表 + 状态上报）已实现；
 * M2（审批答复器）代码在下面但**默认关闭**，因为它依赖 §7 那个还没跑的
 * 探针——在不知道 DSH 的 guard 允许答复器挂多久之前，不该让它上生产。
 */

import { CallTable } from './lib/calls.js'
import { Reporter } from './lib/report.js'
import { Translator, sessionIdOf, cwdOf, canonicalTool } from './lib/map.js'
import { ShapeWatch, noteVersion, installedDshVersion } from './lib/compat.js'

export const name = 'clamicro-dsh-bridge'

/**
 * 配置。
 *
 * 没有用 schemastery（Cordis 生态常用的 Schema）——那会引入一个依赖，
 * 而 clamicro 全线零依赖。默认值在这里手工兜住，配置写错时按默认跑，
 * 不因为一个配置项把插件搞挂。
 */
function normalizeConfig(raw) {
  const c = raw ?? {}
  const num = (v, dflt, min, max) => {
    const n = Number(v)
    return Number.isFinite(n) && n >= min && n <= max ? n : dflt
  }
  return {
    origin: typeof c.origin === 'string' && c.origin ? c.origin : 'http://127.0.0.1:8765',
    /** 状态镜像到手机。这一半没有风险，默认开。 */
    mirror: c.mirror !== false,
    /**
     * 手机审批。默认关，接进真实 DSH 跑通一次之后再开。
     *
     * （原来关着的理由是「不知道 guard 允许挂多久」，那个问题已经解决：
     * 框架对审批等待没有截止时间，见 docs/dsh-bridge.zh-CN.md §7。）
     */
    approve: c.approve === true,
    /**
     * 哪些工具每次调用都要问（Claude Code 审批体验对齐）。
     *
     * 默认 ['bash']——bash 是「能做任何事」的工具，Claude Code 对它每次
     * 都走 PermissionRequest。read 之类只读的不问；write/edit 的越权写由
     * DSH 自己的沙箱升级（danger-full-access）触发审批，不在这里重复问。
     *
     * 置空 [] = 只审批沙箱升级，不逐条问 bash。
     */
    askTools: Array.isArray(c.askTools) ? c.askTools.filter((t) => typeof t === 'string') : ['bash'],
    /**
     * 答复器的兜底截止时间。**这不是审批策略。**
     *
     * DSH 侧没有任何框架级上限：timeout-policy 只包 `tools/execute`，
     * 而审批发生在它之前的 `tools/pre-execute` 阶段（§7 有完整推导）。
     *
     * 真正决定「等多久」的是 clamicro 自己的审批配置——普通操作到点自动通过，
     * 高危到点自动拒绝，那是用户能在手机上改的。这里的值只用来防 HTTP 请求
     * 本身卡死，所以必须**比 clamicro 的时限更长**：短了会在用户还盯着卡片
     * 读命令的时候把请求掐掉，而 clamicro 那条审批还挂着，两边状态从此对不上。
     */
    timeoutMs: num(c.timeoutMs, 600_000, 5_000, 3_600_000),
    maxCalls: num(c.maxCalls, 200, 10, 5_000),
  }
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  /**
   * 日志。有 DSH 的 logger 就用它，没有才落回 console。
   *
   * 不能写成 `logger?.info?.(msg) ?? console.log(msg)`：`info()` 返回
   * undefined，`??` 于是**两边都执行**，每一行日志出现两次。
   * 这类写法看着像「取第一个可用的」，实际是「先执行左边，再判空」。
   */
  const info = ctx?.logger?.('clamicro')?.info
  const log = typeof info === 'function'
    ? (msg) => info.call(ctx.logger('clamicro'), msg)
    : (msg) => console.log(`[clamicro] ${msg}`)

  const calls = new CallTable({ max: config.maxCalls })
  const reporter = new Reporter({ origin: config.origin, log })
  const watch = new ShapeWatch({ log })
  const translator = new Translator({ calls, watch })

  /**
   * 版本漂移只提示、不阻止启动。
   *
   * DSH 明说会有破坏性变更，但 46 个事件类型里我们只用 7 个——版本号对不上
   * 多半没事。真出事时 ShapeWatch 会在第一条对不上的事件上喊出来，那才是
   * 可执行的信号。见 lib/compat.js。
   */
  installedDshVersion().then((v) => noteVersion(v, log)).catch(() => {})

  /**
   * 见过哪些会话。
   *
   * DSH 的事件表里没有「会话开始」——turn/start 是每轮都有的，拿它当会话
   * 开始会让 clamicro 每轮新建一次会话。所以第一次见到某个 session_id 时
   * 由这里补发一条 session-start。
   *
   * 用 Set 而不是无限增长的数组：它只回答「见过没有」。会话结束时删掉，
   * 漏删的代价只是少补一条 session-start，不是内存泄漏——DSH 进程本身
   * 就是按天重启的量级。
   */
  const seen = new Set()

  if (config.mirror) {
    /**
     * `session/event` 是 post-commit、fire-and-forget 的追加流。
     * DSH 会兜住观察者抛出的异常、不让它影响已提交的 append——但**慢**它兜不住，
     * 所以这个回调里从头到尾没有 await。
     */
    ctx.on('session/event', (session, event) => {
      try {
        const sid = sessionIdOf(session)
        if (!sid) return

        if (!seen.has(sid)) {
          seen.add(sid)
          /**
           * `owner_pid` = DSH 自己的进程号。
           *
           * clamicro 靠它判「还有没有后端在用」，全没了就自己退出，而不是
           * 空转到天亮。这个插件跑在 DSH 主进程内，所以 `process.pid`
           * **就是** DSH——不用像 hook 脚本那样去追父进程。
           *
           * 注意它是**所有会话共用的**：DSH 不像 Claude Code 一个会话一个
           * 进程。所以它只够回答「DSH 还开着吗」，不够回答「这个会话还
           * 活着吗」。
           */
          reporter.send('session-start', {
            session_id: sid, cwd: cwdOf(session), source: 'dsh', owner_pid: process.pid,
          })
        }

        const mapped = translator.map(sid, event)
        if (!mapped) return

        reporter.send(mapped.event, { session_id: sid, cwd: cwdOf(session), ...mapped.payload })

        if (mapped.event === 'session-end') {
          seen.delete(sid)
          translator.forget(sid)
        }
      } catch (err) {
        // 观察者里的任何意外都到此为止。DSH 会记录并隔离，但没必要让它记：
        // 这是我们自己的 bug，该出现在我们自己的日志里
        log(`处理事件时出错（已忽略）：${err?.message ?? err}`)
      }
    })
    log(`状态镜像已启用 → ${config.origin}`)
  }

  if (config.approve) {
    /**
     * 审批答复器。waterfall：返回 outcome 即认领这次决定，调 next() 即交给下一个。
     *
     * 每一条出错路径都走 next()，一条都不能走 'rejected'：
     * 「clamicro 连不上」和「用户拒绝了」是两件完全不同的事，混为一谈的
     * 结果是服务一挂，DSH 的所有工具调用全被静默拒绝。next() 会把这次提问
     * 交回给人（DSH 自己的 Web UI 会弹），这是我们能给出的最诚实的降级。
     */
    ctx.on('approval/request', async (req, next) => {
      /**
       * 会话 id 来自 `req.agent.id`。
       *
       * ApprovalRequest 里**没有 session 字段**（实测 dsh-user-approval 的
       * 类型定义：只有 agent / toolName / callId / reason / signal）。
       * Agent.id 的注释写着「The single identity shared with session」，
       * 就是同一个 SessionId。
       */
      const sid = req?.agent?.id ?? sessionIdOf(req?.agent?.session) ?? null
      // 不删：随后的 tool/result 还要靠它查工具名，见 calls.js 的 get()
      const call = req?.callId ? calls.get(req.callId) : null
      try {
        const decision = await reporter.requestApproval({
          session_id: sid,
          /**
           * cwd 必须带上。
           *
           * clamicro 的风险评估里有一条「写入工作目录之外」，判据是
           * `cwd && path.startsWith('/') && !path.startsWith(cwd)`——
           * 不给 cwd，这条**整条跳过**，DSH 往工作区外写文件不会被标高危。
           * 漏一条规则和规则判错一样严重，而且更难发现。
           */
          cwd: cwdOf(req?.agent?.session) ?? null,
          tool_name: canonicalTool(req?.toolName ?? call?.toolName),
          tool_input: call?.args ?? null,
          /**
           * 参数到底知不知道，必须显式说。
           *
           * clamicro 的风险评估是按 tool_input 打分的：传个 {} 进去会算出
           * 「低风险」，而真实情况是「不知道」。低风险卡片在手机上长得人畜
           * 无害，还可能落进自动通过的档位——那就是一次没人真正看过的放行。
           */
          args_known: Boolean(call),
          reason: req?.reason ?? null,
        }, { signal: req?.signal, timeoutMs: config.timeoutMs })

        if (decision === 'allow') return 'allowed-once'
        if (decision === 'deny') return 'rejected'
        return next()
      } catch (err) {
        log(`审批没能问到手机，交回人类：${err?.message ?? err}`)
        return next()
      }
    })
    /**
     * tools/pre-execute 答复器：让 askTools 里的工具每次调用都「ask」。
     *
     * DSH 的 gate 默认 fallback 是 {kind:"allow"}，不注册这个就永远不会有
     * 「每次问」。这里是还原 Claude Code 审批体验的关键一环：bash 每次
     * 都要人点一下，风险分档（普通自动通过/高危等人）交给 clamicro。
     *
     * 顺手把 exec.arguments 塞进 callId 表——审批答复器拿参数靠它，而它
     * 不能依赖 mirror 的事件时序（mirror 关掉时审批也得能用）。
     */
    const askSet = new Set(config.askTools)
    ctx.on('tools/pre-execute', (exec, next) => {
      if (exec && typeof exec.name === 'string' && askSet.has(exec.name)) {
        if (exec.callId) calls.put(exec.callId, canonicalTool(exec.name), exec.arguments ?? null)
        return { kind: 'ask' }
      }
      return next()
    }, { prepend: true })

    log(`手机审批已启用（截止 ${Math.round(config.timeoutMs / 1000)}s，超时交回人类）`)
  }
}

export default { name, apply }
