/**
 * DSH 桥接的回归测试。
 *
 * 重点全在一件事上：**「参数不知道」不能被当成「没有参数」**。
 *
 * DSH 的 ApprovalRequest 刻意不带工具参数（见 docs/dsh-bridge.zh-CN.md §1），
 * 桥接侧靠 callId 回查 session log，查不到就只能说不知道。如果这时传一个
 * 空对象进来，风险规则一条都匹配不上 → 判 normal → 进入自动通过档位 →
 * 一次**没有任何人看过内容的放行**，而且手机卡片上还显得人畜无害。
 *
 * 这是整条 DSH 链路上唯一能变成安全漏洞的地方，所以钉死在这里。
 *
 * 跑：node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assessRisk } from '../src/risk/assess.mjs'
import { ApprovalStore } from '../src/approvals.mjs'
import { CallTable } from '../plugins/dsh-bridge/lib/calls.js'
import { Translator, sessionIdOf, cwdOf, canonicalTool } from '../plugins/dsh-bridge/lib/map.js'
import { ShapeWatch, noteVersion, TESTED_DSH } from '../plugins/dsh-bridge/lib/compat.js'

/** 事件形状全部对照 @deepseek-ai/dsh-session@0.1.0-rc.6 的 SessionEventMap 实测过 */
const translator = () => new Translator({ calls: new CallTable() })

// ---------------------------------------------------------------------------
test('参数未知 → 判高危，不因为「看起来没风险」而放行', async (t) => {
  await t.test('argsKnown:false 一律 high', () => {
    const r = assessRisk('Bash', null, '/tmp', { argsKnown: false })
    assert.equal(r.level, 'high')
    assert.ok(r.reasons.length, '必须说清为什么，否则卡片上是一片空白的高危')
  })

  await t.test('哪怕工具名看着最无害也一样', () => {
    // Read 在参数已知时是最低风险的工具之一 —— 但「不知道读的是哪个文件」
    // 和「读一个普通文件」完全是两回事
    assert.equal(assessRisk('Read', null, '/tmp', { argsKnown: false }).level, 'high')
  })

  await t.test('缺省仍是 argsKnown:true —— 老调用方行为不能变', () => {
    // Claude Code 那条路从来不传这个参数，它必须继续按参数已知处理，
    // 否则一夜之间所有普通操作都变成高危、全部需要手点
    assert.equal(assessRisk('Read', { file_path: '/tmp/a.txt' }, '/tmp').level, 'normal')
    assert.equal(assessRisk('Read', { file_path: '/tmp/a.txt' }, '/tmp', {}).level, 'normal')
  })
})

// ---------------------------------------------------------------------------
test('参数未知的审批不会自动通过', async (t) => {
  const policy = { autoApproveMs: 10_000, timeoutMs: 60_000, autoApproveHighRisk: false }

  await t.test('args_known:false → 到点是拒绝，不是通过', () => {
    const store = new ApprovalStore()
    const ap = store.create(
      { session_id: 's1', tool_name: 'Bash', tool_input: null, args_known: false, cwd: '/tmp' },
      policy,
    )
    assert.equal(ap.risk.level, 'high')
    assert.equal(ap.auto_decision, 'deny')
  })

  await t.test('同一个调用在参数已知时才允许自动通过', () => {
    const store = new ApprovalStore()
    const ap = store.create(
      { session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls -la' }, cwd: '/tmp' },
      policy,
    )
    assert.equal(ap.auto_decision, 'allow')
  })
})

// ---------------------------------------------------------------------------
test('callId 参数表', async (t) => {
  await t.test('查得到，且查完不删 —— tool/result 还要靠它查工具名', () => {
    const t1 = new CallTable()
    t1.put('c1', 'Bash', { command: 'ls' })
    assert.deepEqual(t1.get('c1'), { toolName: 'Bash', args: { command: 'ls' } })
    // 审批读过一次之后，tool/result 必须还能读到
    assert.deepEqual(t1.get('c1'), { toolName: 'Bash', args: { command: 'ls' } })
    t1.delete('c1')
    assert.equal(t1.get('c1'), null)
  })

  await t.test('取不到返回 null —— 调用方据此判定「不知道」', () => {
    assert.equal(new CallTable().get('nope'), null)
    assert.equal(new CallTable().get(undefined), null)
  })

  await t.test('超出上限时淘汰最老的，不是无界增长', () => {
    const t2 = new CallTable({ max: 3 })
    for (const id of ['a', 'b', 'c', 'd']) t2.put(id, 'Bash', { command: id })
    assert.equal(t2.size, 3)
    assert.equal(t2.get('a'), null, '最老的应已被淘汰')
    assert.ok(t2.get('d'), '最新的必须还在')
  })

  await t.test('过期的取不回来', () => {
    const t3 = new CallTable({ ttlMs: -1 }) // 存进去就算过期
    t3.put('c1', 'Bash', { command: 'ls' })
    assert.equal(t3.get('c1'), null)
  })

  await t.test('没有 callId 的不记 —— 记了也取不回来', () => {
    const t4 = new CallTable()
    t4.put(null, 'Bash', { command: 'ls' })
    assert.equal(t4.size, 0)
  })
})

// ---------------------------------------------------------------------------
test('事件翻译', async (t) => {
  await t.test('认不出的事件一律丢弃，绝不抛', () => {
    // 权威表里 46 个事件类型只翻译 7 个，其余全走这条路；
    // 插件还能通过 declaration merging 再往里加
    const tr = translator()
    assert.equal(tr.map('s', { type: 'compaction/start' }), null)
    assert.equal(tr.map('s', { type: 'llm/retry' }), null)
    assert.equal(tr.map('s', {}), null)
    assert.equal(tr.map('s', null), null)
  })

  await t.test('tool/call：工具名是 name，参数是 JSON 字符串', () => {
    const calls = new CallTable()
    const tr = new Translator({ calls })
    // 真实形状：{turn, step, callId, name, arguments}，arguments 是字符串
    const out = tr.map('s', {
      type: 'tool/call',
      turn: 1, step: 1, callId: 'c9', name: 'Bash',
      arguments: JSON.stringify({ command: 'rm -rf /' }),
    })
    assert.equal(out.event, 'pre-tool-use')
    assert.equal(out.payload.tool_name, 'Bash')
    assert.deepEqual(out.payload.tool_input, { command: 'rm -rf /' })
    assert.deepEqual(calls.get('c9'), { toolName: 'Bash', args: { command: 'rm -rf /' } })
  })

  await t.test('arguments 不是合法 JSON 时给 null，不给 {}', () => {
    // 模型截断过、也吐过多余文本。给 {} 会被当成「没有参数的调用」→ 低风险；
    // 给 null 会一路变成 args_known:false → 高危。这个区别是安全边界
    const calls = new CallTable()
    const tr = new Translator({ calls })
    tr.map('s', { type: 'tool/call', callId: 'c1', name: 'Bash', arguments: '{"command": "rm -' })
    assert.equal(calls.get('c1').args, null)
  })

  await t.test('tool/result：工具名从 callId 回查，callId 藏在 message 里', () => {
    const calls = new CallTable()
    const tr = new Translator({ calls })
    tr.map('s', { type: 'tool/call', callId: 'c2', name: 'Bash', arguments: '{}' })
    // 真实形状：{turn, step, message: {content: [{toolCallId, isError}]}, error?}
    const ok = tr.map('s', {
      type: 'tool/result',
      message: { content: [{ type: 'tool-result', toolCallId: 'c2' }] },
    })
    assert.equal(ok.event, 'post-tool-use')
    assert.equal(ok.payload.tool_name, 'Bash', 'tool/result 自己不带工具名')
    assert.equal(calls.get('c2'), null, 'result 到了就该回收')
  })

  await t.test('tool/result 的失败按 isError / error 判', () => {
    const tr = translator()
    const byBlock = tr.map('s', {
      type: 'tool/result',
      message: { content: [{ toolCallId: 'x', isError: true }] },
    })
    assert.equal(byBlock.event, 'post-tool-failure')
    const byErr = tr.map('s', {
      type: 'tool/result',
      message: { content: [{ toolCallId: 'y' }] },
      error: { name: 'E', code: 'BOOM' },
    })
    assert.equal(byErr.event, 'post-tool-failure')
  })

  await t.test('turn/end 的正文来自 assistant/message，不来自它自己', () => {
    const tr = translator()
    // turn/end 的真实形状只有 {turn, reason}，没有任何正文
    assert.equal(tr.map('s', { type: 'assistant/message', message: { content: [{ type: 'text', text: '做完了' }] } }), null)
    const out = tr.map('s', { type: 'turn/end', turn: 1, reason: { kind: 'completed' } })
    assert.equal(out.event, 'stop')
    assert.equal(out.payload.last_assistant_message, '做完了')
  })

  await t.test('累计 token 在 turn/end 报出，且「没报」不等于 0', () => {
    const tr = translator()
    // usage 只出现在 assistant/message 上，且适配器没报时整个字段缺席
    tr.map('s', { type: 'assistant/message', message: { content: [] }, usage: { inputTokens: 100, outputTokens: 50 } })
    tr.map('s', { type: 'assistant/message', message: { content: [] }, usage: { inputTokens: 10, outputTokens: 5 } })
    assert.equal(tr.map('s', { type: 'turn/end', reason: { kind: 'completed' } }).payload.tokens, 165)

    // 一次 usage 都没有 → 整个字段不出现。报 0 会被显示成「用了 0 个 token」，
    // 而真实情况是「适配器没报用量」，两者完全不同
    const quiet = translator()
    quiet.map('q', { type: 'assistant/message', message: { content: [] } })
    assert.equal('tokens' in quiet.map('q', { type: 'turn/end', reason: { kind: 'completed' } }).payload, false)
  })

  await t.test('token 不换算成金额 —— DSH 的 TokenUsage 里根本没有 cost', () => {
    // 换算需要一张按模型分档的价目表，而它会在我们不知情时过期，
    // 然后手机上安静地显示一个错的金额。不准的数字比没有更糟：你会拿它做决定
    const tr = translator()
    tr.map('s', { type: 'assistant/message', message: { content: [] }, usage: { inputTokens: 1, outputTokens: 1 } })
    const p = tr.map('s', { type: 'turn/end', reason: { kind: 'completed' } }).payload
    assert.equal(p.cost_usd, undefined)
    assert.equal(p.cost, undefined)
  })

  await t.test('只有 error 算出错，取消不算', () => {
    const tr = translator()
    assert.equal(tr.map('s', { type: 'turn/end', reason: { kind: 'error', error: { message: '炸了' } } }).event, 'stop-failure')
    // 用户自己按的取消显示成红色「出错」，会让人以为出了 bug
    assert.equal(tr.map('s', { type: 'turn/end', reason: { kind: 'aborted' } }).event, 'stop')
    assert.equal(tr.map('s', { type: 'turn/end', reason: { kind: 'blocked' } }).event, 'stop')
  })

  await t.test('user/message 只认真人打的字，合成注入不算', () => {
    const tr = translator()
    const real = tr.map('s', { type: 'user/message', source: { kind: 'user' }, content: [{ type: 'text', text: '改一下' }] })
    assert.equal(real.event, 'user-prompt-submit')
    assert.equal(real.payload.prompt, '改一下')
    // agent.inject() 的文件变更通知、AGENTS.md、skill 内容都走 user/message
    assert.equal(tr.map('s', { type: 'user/message', source: { kind: 'plugin', plugin: 'fs' }, content: [] }), null)
  })

  await t.test('审批的审计事件不上报 —— 否则两个来源写同一份状态', () => {
    const tr = translator()
    assert.equal(tr.map('s', { type: 'approval/asked' }), null)
    assert.equal(tr.map('s', { type: 'approval/decided' }), null)
    assert.equal(tr.map('s', { type: 'approval/policy' }), null)
  })

  await t.test('会话 id / cwd 的字段名各试几个，拿不到给 null', () => {
    assert.equal(sessionIdOf({ id: 'x' }), 'x')
    assert.equal(sessionIdOf({}), null)
    // 真实 Session 把 cwd 放在 header（SessionHeader.cwd），这条钉死，防回归
    assert.equal(cwdOf({ header: { cwd: '/a' } }), '/a')
    assert.equal(cwdOf({ meta: { cwd: '/a' } }), '/a')
    assert.equal(cwdOf({}), null)
  })
})

// ---------------------------------------------------------------------------
test('cwd 缺失会让「写入工作目录之外」整条规则失效', async (t) => {
  const outside = { file_path: '/etc/passwd' }

  await t.test('给了 cwd 才拦得住', () => {
    assert.equal(assessRisk('Write', outside, '/workspace').level, 'high')
  })

  await t.test('没给 cwd 就静默放过 —— 所以桥接必须带上它', () => {
    // 这不是要固化「没 cwd 就不拦」这个行为，而是钉住它的**后果**：
    // 桥接层一旦忘了传 cwd，这条规则整条消失且不报错
    assert.equal(assessRisk('Write', outside, undefined).level, 'normal')
  })
})

// ---------------------------------------------------------------------------
test('工具名：DSH 是小写，风险规则不能靠名字匹配', async (t) => {
  await t.test('小写 bash 必须照样命中高危规则', () => {
    // 实测 DSH 0.1.0-rc.6 的工具注册名是 "bash"。原来风险判定写的是
    // toolName === 'Bash'，精确匹配 Claude Code 的名字 —— 差一个字母，
    // 整套 HIGH_RISK_BASH 一条都不跑，rm -rf / 判普通风险然后自动放行
    assert.equal(assessRisk('bash', { command: 'rm -rf /' }, '/tmp').level, 'high')
    assert.equal(assessRisk('Bash', { command: 'rm -rf /' }, '/tmp').level, 'high')
  })

  await t.test('工具名彻底认不出时，靠 command 参数照样拦得住', () => {
    // 判据是「有没有命令」而不是「叫不叫 Bash」，所以后端改名也不失效
    const r = assessRisk('某个没见过的shell工具', { command: 'cat ~/.ssh/id_rsa' }, '/tmp')
    assert.equal(r.level, 'high')
  })

  await t.test('没有 command 的工具不会被误判', () => {
    assert.equal(assessRisk('read', { file_path: '/tmp/a.txt' }, '/tmp').level, 'normal')
  })

  await t.test('桥接层把 DSH 工具名翻成 clamicro 词汇', () => {
    const tr = translator()
    const out = tr.map('s', { type: 'tool/call', callId: 'c', name: 'bash', arguments: '{}' })
    assert.equal(out.payload.tool_name, 'Bash')
    for (const [dsh, ours] of [['read', 'Read'], ['write', 'Write'], ['edit', 'Edit'], ['web_fetch', 'WebFetch']]) {
      const o = translator().map('s', { type: 'tool/call', callId: 'c', name: dsh, arguments: '{}' })
      assert.equal(o.payload.tool_name, ours, `${dsh} 应翻成 ${ours}`)
    }
  })

  await t.test('认不出的工具名原样透传，不变成 ?', () => {
    const tr = translator()
    const out = tr.map('s', { type: 'tool/call', callId: 'c', name: 'job_list', arguments: '{}' })
    assert.equal(out.payload.tool_name, 'job_list', '显示 DSH 自己的名字比显示 ? 有用')
  })

  await t.test('canonicalTool 直接导出：bash→Bash，未知名原样，空→?', () => {
    // index.js 的审批答复器用它把 req.toolName（DSH 小写）翻成 clamicro 词汇，
    // 否则 describe.mjs 里 `toolName === 'Bash'` 的精确匹配不会命中，命令高亮失效
    assert.equal(canonicalTool('bash'), 'Bash')
    assert.equal(canonicalTool('write'), 'Write')
    assert.equal(canonicalTool('edit'), 'Edit')
    assert.equal(canonicalTool('job_list'), 'job_list')
    assert.equal(canonicalTool(''), '?')
    assert.equal(canonicalTool(undefined), '?')
  })
})

// ---------------------------------------------------------------------------
test('DSH 升级后的形状漂移检测', async (t) => {
  const spy = () => {
    const lines = []
    return { lines, log: (m) => lines.push(m) }
  }

  await t.test('形状对就不吭声', () => {
    const s = spy()
    const w = new ShapeWatch({ log: s.log })
    assert.equal(w.check('tool/call', { name: 'Bash', arguments: '{}' }), true)
    assert.equal(w.check('turn/end', { reason: { kind: 'completed' } }), true)
    assert.equal(s.lines.length, 0)
  })

  await t.test('字段改名 → 警告', () => {
    const s = spy()
    const w = new ShapeWatch({ log: s.log })
    // 这个插件所有的翻译错误都是安静的：name 改名后读到 undefined，
    // 手机上每张卡片显示 ? ，没有任何一处会抛
    assert.equal(w.check('tool/call', { toolName: 'Bash', arguments: '{}' }), false)
    assert.equal(s.lines.length, 1)
    assert.match(s.lines[0], /tool\/call/)
  })

  await t.test('每种事件只警告一次 —— 否则要紧的那行会被自己刷掉', () => {
    const s = spy()
    const w = new ShapeWatch({ log: s.log })
    for (let i = 0; i < 500; i++) w.check('tool/call', { bogus: true })
    assert.equal(s.lines.length, 1)
  })

  await t.test('没登记形状的事件不检查 —— 46 个类型我们只管 7 个', () => {
    const s = spy()
    const w = new ShapeWatch({ log: s.log })
    assert.equal(w.check('compaction/start', { whatever: 1 }), true)
    assert.equal(s.lines.length, 0)
  })

  await t.test('判据要宽松：DSH 加字段是最常见的无害变更，不能误报', () => {
    const s = spy()
    const w = new ShapeWatch({ log: s.log })
    assert.equal(w.check('tool/call', { name: 'Bash', arguments: '{}', 新字段: 1 }), true)
    // arguments 万一从字符串改成对象，仍算认得（parseArgs 有对应分支），
    // 但那是我们主动留的后路，不是没检查
    assert.equal(w.check('tool/call', { name: 'Bash', arguments: { a: 1 } }), true)
    assert.equal(s.lines.length, 0)
  })

  await t.test('版本一致不提示，不一致才提示一句', () => {
    const same = spy()
    noteVersion(TESTED_DSH, same.log)
    assert.equal(same.lines.length, 0)

    const drift = spy()
    noteVersion('0.2.0', drift.log)
    assert.equal(drift.lines.length, 1)
    assert.match(drift.lines[0], /0\.2\.0/)

    // 读不到版本时什么都不说：为一件「可能没事」的事喊一嗓子，
    // 只会训练人忽略这个插件的输出
    const none = spy()
    noteVersion(null, none.log)
    assert.equal(none.lines.length, 0)
  })
})
