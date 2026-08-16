/**
 * DSH 的 `session/event` → Clamicro 的 hook 事件。
 *
 * ## 事件形状的出处
 *
 * 全部对照 `@deepseek-ai/dsh-session@0.1.0-rc.6` 的
 * `lib/types/types.d.ts`（SessionEventMap）与 `lib/known-event-types.js`
 * 实际核对过，不是照文档猜的。几处容易写错的：
 *
 *   · `tool/call.arguments` 是**模型原样吐出来的 JSON 字符串**，不是对象
 *   · `tool/call` 里工具名叫 `name`，不叫 `toolName`
 *   · `tool/result` **不带工具名**，callId 也藏在 `message.content[0].toolCallId` 里
 *   · `turn/end` 只有 `{turn, reason}`，**没有正文**——正文在 `assistant/message`
 *   · `turn/start` 只有 `{turn}`，**没有 prompt**——prompt 在 `user/message`
 *
 * 前两条写错了不会报错，只会让手机上每张卡片都显示 `?` 和一串转义过的 JSON；
 * 后两条写错了会让「已完成」通知永远是空的。都属于安静地坏掉。
 *
 * ## 没有 session/start
 *
 * 权威事件表里没有会话开始（`known-event-types.js` 46 项，`session/end-seed`
 * 有、开始没有）。`turn/start` 是每轮都发的，拿它当会话开始会让 clamicro
 * 每轮新建一次会话。所以由桥接侧在首次见到某个 session id 时合成一条。
 */

/**
 * DSH 工具名 → clamicro（Claude Code）的词汇。
 *
 * 实测 0.1.0-rc.6 的注册名全是小写下划线：`bash` / `read` / `write` / `edit` /
 * `read_image` / `web_fetch` / `web_search` / `job_*`。
 *
 * 翻译它们是为了让手机端已有的那套显示逻辑直接生效——子状态推导
 * （`Searching` / `Editing` / `Running Command`）、命令高亮区间，都是按
 * Claude Code 的名字写的。
 *
 * **但这层翻译不承担安全责任。** 风险评估已经改成按「有没有 command 参数」
 * 判定，不依赖工具名（见 clamicro 的 src/risk/assess.mjs）。这里漏一个名字
 * 的后果只是显示得糙一点，不会让高危操作溜过去。安全不能建立在一张
 * 需要人工维护的映射表上。
 *
 * 没列进来的（`ask_user_question` 尤其）故意不映射：clamicro 对
 * `AskUserQuestion` 有专门的选择题渲染，而 DSH 的载荷形状不同，
 * 硬映射会渲染出一张读不懂的卡片。那条路要单独做，见方案文档 §8。
 */
const TOOL_NAMES = {
  bash: 'Bash',
  read: 'Read',
  read_image: 'Read',
  write: 'Write',
  edit: 'Edit',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
}

/** 认不出就原样返回：显示成 DSH 自己的名字，比显示成 `?` 有用。 */
export function canonicalTool(name) {
  if (typeof name !== 'string' || !name) return '?'
  return TOOL_NAMES[name] ?? name
}

/** DSH 的 session 对象里挖会话 id。`Agent.id` 与 `Session` 共用同一个身份。 */
export function sessionIdOf(session) {
  return session?.id ?? session?.sessionId ?? session?.session_id ?? null
}

/** 工作目录。手机端拿它做会话标题（取最后一段目录名）。 */
export function cwdOf(session) {
  // 真实 Session 对象把 cwd 放在 header（SessionHeader.cwd），不是 meta/cwd/workspace。
  // 漏了 header 这条，DSH 会话在 clamicro 里 cwd=null，会话标题退化，
  // 更严重的是审批时「写入工作目录之外」这条风险规则整条跳过（见 dsh-bridge.test.mjs）。
  return session?.header?.cwd ?? session?.meta?.cwd ?? session?.cwd ?? session?.workspace?.path ?? null
}

/** 把 ContentBlock[] 里的文本块拼起来。非文本块（图片、工具结果）跳过。 */
function textOf(message) {
  const blocks = message?.content
  if (typeof blocks === 'string') return blocks
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

/**
 * 解析 `tool/call.arguments`。
 *
 * 它是模型直接吐出来的字符串，**可能不是合法 JSON**（模型截断、幻觉出多余
 * 文本都发生过）。解析失败时返回 null 而不是 {}——null 一路传下去会变成
 * `args_known: false`，让 clamicro 把风险判成未知；返回 {} 则会被当成
 * 「一个没有参数的调用」，进而算出低风险。这个区别就是这个文件里最要紧的一处。
 */
function parseArgs(raw) {
  if (raw == null) return null
  if (typeof raw === 'object') return raw // 防御：万一哪个版本改成了对象
  if (typeof raw !== 'string') return null
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

/**
 * 有状态的翻译器。
 *
 * 有状态是因为 DSH 把一件事拆在了多个事件里：工具名只在 `tool/call` 出现，
 * 而 `tool/result` 要用；助手正文只在 `assistant/message` 出现，而 `turn/end`
 * 要用。跨事件的东西必须存下来。
 */
export class Translator {
  #calls
  #watch
  #lastText = new Map() // sessionId -> 最近一条助手正文
  /**
   * sessionId -> 累计 token。
   *
   * DSH 的 `TokenUsage` 只有 `{inputTokens, outputTokens, cacheReadTokens?,
   * cacheWriteTokens?, reasoningTokens?}`——**没有花费**。DSH 不算钱。
   *
   * 所以这里只累计 token，绝不换算成美元：那需要一张按模型分档的价目表，
   * 而价目表会在我们不知情的时候过期，然后手机上安静地显示一个错的金额。
   * 一个不准的数字比没有数字更糟，因为你会拿它做决定。
   */
  #tokens = new Map()

  constructor({ calls, watch = null }) {
    this.#calls = calls
    this.#watch = watch
  }

  /** 会话结束时清掉它的残留，别让 Map 跟着进程一直长 */
  forget(sessionId) {
    this.#lastText.delete(sessionId)
    this.#tokens.delete(sessionId)
  }

  /**
   * @returns {{event: string, payload: object} | null}
   *   null = 这条不上报（未知事件、纯内部事件、或者只是被记下来备用）
   */
  map(sessionId, event) {
    const type = event?.type ?? event?.name
    if (typeof type !== 'string') return null
    const d = event?.data ?? event

    /**
     * 形状对不上仍然照常翻译，只是警告一次。
     *
     * 不在这里 return null：DSH 改了个我们没读的字段、或者只是加了新字段，
     * 都会让某条判据变严而误报。翻译尽力而为、把疑点喊出来，比因为一次
     * 误判就让整个会话从手机上消失要好——后者没有任何线索可查。
     */
    this.#watch?.check(type, d)

    switch (type) {
      /**
       * 只有**真人打的字**算一次提问。
       *
       * user/message 同时承载 `agent.inject()` 的合成上下文（文件变更通知、
       * AGENTS.md、skill 内容、定时任务…），靠 source.kind 区分。不分的话，
       * 手机上会因为一次后台注入而显示「用户提交了新任务」。
       */
      case 'user/message': {
        if (d?.source?.kind && d.source.kind !== 'user') return null
        return { event: 'user-prompt-submit', payload: { prompt: textOf(d) } }
      }

      // 记下来给 turn/end 用，本身不上报
      case 'assistant/message': {
        const text = textOf(d?.message)
        if (text) this.#lastText.set(sessionId, text)
        // usage 只在这条事件上出现，且「适配器没报」时整个字段缺席。
        // 累计起来给 turn/end 用——手机是在两轮之间看的，一轮报一次正好
        const u = d?.usage
        if (u) {
          const prev = this.#tokens.get(sessionId) ?? 0
          this.#tokens.set(sessionId, prev + (Number(u.inputTokens) || 0) + (Number(u.outputTokens) || 0))
        }
        return null
      }

      case 'tool/call': {
        const callId = d?.callId ?? null
        const toolName = canonicalTool(d?.name)
        const args = parseArgs(d?.arguments)
        // 攒参数是这条分支的主要目的：审批卡片和风险评估全靠它，
        // 因为 ApprovalRequest 本身不带参数
        this.#calls.put(callId, toolName, args)
        return {
          event: 'pre-tool-use',
          payload: { tool_name: toolName, tool_input: args ?? {} },
        }
      }

      case 'tool/result': {
        const block = d?.message?.content?.[0]
        const callId = block?.toolCallId ?? null
        // 工具名只能从 tool/call 那边查——tool/result 自己不带
        const toolName = this.#calls.get(callId)?.toolName ?? '?'
        this.#calls.delete(callId) // 一次调用的生命到此为止
        const failed = d?.error != null || block?.isError === true
        return {
          event: failed ? 'post-tool-failure' : 'post-tool-use',
          payload: { tool_name: toolName },
        }
      }

      /**
       * 一轮结束。reason.kind 决定是「完成」还是「出错」。
       *
       * 只有 `error` 算出错。aborted / blocked / interrupted 都不是失败——
       * 把用户自己按的取消显示成红色「出错」，会让人以为出了 bug。
       */
      case 'turn/end': {
        const kind = d?.reason?.kind
        const text = this.#lastText.get(sessionId) ?? ''
        if (kind === 'error') {
          const err = d.reason.error
          return {
            event: 'stop-failure',
            payload: { error: err?.message ?? err?.code ?? '任务因错误终止' },
          }
        }
        const seen = this.#tokens.has(sessionId)
        const tokens = this.#tokens.get(sessionId)
        return {
          event: 'stop',
          payload: {
            last_assistant_message: text,
            /**
             * 显式区分「上报过用量（哪怕是 0）」和「适配器压根没报」。
             * tokens 只在有正数时才给；「没报」靠 usage_reported 这个布尔说出口，
             * 而不是靠「没有 tokens 字段」——字段缺席有两种读法，布尔只有一种。
             */
            usage_reported: seen,
            ...(tokens && tokens > 0 ? { tokens } : {}),
          },
        }
      }

      case 'session/end-seed':
        return { event: 'session-end', payload: { reason: 'ended' } }

      /**
       * 审批的审计事件不上报。
       *
       * 我们自己就是那条 waterfall 上的答复器，审批状态由 clamicro 的
       * approvals 存储维护。再从事件流报一遍等于两个来源写同一份状态，
       * 而它们的时序没有保证。
       */
      case 'approval/asked':
      case 'approval/decided':
      case 'approval/policy':
        return null

      default:
        /**
         * 认不出的一律丢弃。
         *
         * 这一句会命中很多：权威表里 46 个事件类型，我们只翻译 7 个，
         * 剩下的（compaction/*、hook/*、llm/retry、tool-workflow/* …）
         * 对手机看板没有意义。而且插件还能通过 declaration merging 往里加，
         * 所以这里永远会遇到没见过的名字——绝不能抛。
         */
        return null
    }
  }
}
