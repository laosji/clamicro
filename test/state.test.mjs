/**
 * 会话状态机 + 事件时间线。
 *
 * 337 行，此前**零测试**——是质量评估里排第二的缺口（第一是 control.mjs，
 * 已补）。它驱动 UI 显示的一切，而且 `applyHook` 那个大 switch 里有时序逻辑，
 * 已经出过 bug：`turn_started_at` 为空时 elapsed 算成 0，于是「任务完成」
 * 永远不满足最短时长，一次提醒都发不出来。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Store, STATE } from '../src/state.mjs'

const NOTIFY = { onStop: true, onError: true, minTurnMs: 30_000 }
const hook = (s, event, payload = {}, cfg = NOTIFY) =>
  s.applyHook(event, { session_id: 'x', ...payload }, cfg)

test('会话按需创建，并按更新时间排序', async (t) => {
  const s = new Store()
  await t.test('第一次访问就建出来，字段有默认值', () => {
    const a = s.session('a')
    assert.equal(a.state, STATE.IDLE)
    assert.equal(a.session_id, 'a')
    assert.equal(a.turn_started_at, null)
  })
  await t.test('空 id 返回 null，不建幽灵会话', () => {
    assert.equal(s.session(''), null)
    assert.equal(s.session(null), null)
  })
  await t.test('sessions() 最近更新的排前面', () => {
    // 显式设 updated_at 而不是靠 noteControl 去「碰一下」：两个会话若在同一
    // 毫秒内创建并更新，updated_at 相等，排序退化成插入顺序——那样断言的是
    // 时钟精度而不是排序逻辑，会偶发失败。
    const st = new Store()
    st.session('old').updated_at = 1_000
    st.session('new').updated_at = 2_000
    assert.deepEqual(st.sessions().map((s) => s.session_id), ['new', 'old'])
  })
})

test('状态机：一轮完整的对话', async (t) => {
  const s = new Store()

  await t.test('session-start → Idle', () => {
    hook(s, 'session-start', { source: 'startup' })
    assert.equal(s.session('x').state, STATE.IDLE)
  })

  await t.test('user-prompt-submit → Running，并记下这一轮的起点', () => {
    hook(s, 'user-prompt-submit', { prompt: '帮我改一下' })
    const x = s.session('x')
    assert.equal(x.state, STATE.RUNNING)
    assert.equal(x.sub_state, 'Thinking')
    assert.ok(x.turn_started_at, 'turn_started_at 必须被设上——否则完成提醒算不出时长')
  })

  await t.test('pre-tool-use → 子状态按工具推导', () => {
    hook(s, 'pre-tool-use', { tool_name: 'Bash', tool_input: { command: 'npm run build' } })
    assert.equal(s.session('x').sub_state, 'Running Command')
  })

  await t.test('post-tool-use → 回到 Thinking', () => {
    hook(s, 'post-tool-use', { tool_name: 'Bash' })
    assert.equal(s.session('x').sub_state, 'Thinking')
  })

  await t.test('stop → Done，并清掉 turn_started_at', () => {
    hook(s, 'stop', { last_assistant_message: '改好了' })
    const x = s.session('x')
    assert.equal(x.state, STATE.DONE)
    assert.equal(x.last_message, '改好了')
    assert.equal(x.turn_started_at, null)
  })
})

test('子状态是从 tool_name 推导的（Claude Code 不发这类事件）', async (t) => {
  const cases = [
    ['Read', {}, 'Searching'],
    ['Grep', {}, 'Searching'],
    ['Edit', {}, 'Editing'],
    ['Write', {}, 'Editing'],
    ['Task', {}, 'Delegating'],
    ['Bash', { command: 'ls' }, 'Running Command'],
    ['Bash', { command: 'npm run test' }, 'Running Test'],
    ['Bash', { command: 'pytest -q' }, 'Running Test'],
    ['mcp__slack__post', {}, 'Calling MCP'],
    ['SomethingNew', {}, 'Working'],
  ]
  for (const [tool, input, expect] of cases) {
    await t.test(`${tool} → ${expect}`, () => {
      const s = new Store()
      hook(s, 'pre-tool-use', { tool_name: tool, tool_input: input })
      assert.equal(s.session('x').sub_state, expect)
    })
  }
})

test('任务完成提醒的时长阈值', async (t) => {
  await t.test('两秒的对话不提醒（否则每问一句都响）', () => {
    const s = new Store()
    hook(s, 'user-prompt-submit', { prompt: 'hi' })
    const { notify } = hook(s, 'stop', { last_assistant_message: 'ok' })
    assert.equal(notify, null)
  })

  await t.test('超过阈值就提醒', () => {
    const s = new Store()
    hook(s, 'user-prompt-submit', { prompt: 'hi' })
    s.session('x').turn_started_at = Date.now() - 60_000 // 假装跑了一分钟
    const { notify } = hook(s, 'stop', { last_assistant_message: '完成' })
    assert.ok(notify, '超过 30 秒该提醒')
    assert.match(notify.subtitle, /已完成/)
  })

  await t.test('turn_started_at 未知时按「要提醒」处理', () => {
    // 服务在会话中途才启动的情况。曾经这里算出 elapsed = 0，
    // 于是永远不满足阈值——宁可多提醒一次，也别漏掉一次任务完成。
    const s = new Store()
    s.session('x') // 建出来但从没收到过 user-prompt-submit
    const { notify } = hook(s, 'stop', { last_assistant_message: '完成' })
    assert.ok(notify, 'turn_started_at 为空时必须提醒')
  })

  await t.test('关掉 onStop 就不提醒', () => {
    const s = new Store()
    s.session('x')
    const { notify } = hook(s, 'stop', {}, { ...NOTIFY, onStop: false })
    assert.equal(notify, null)
  })
})

test('出错', async (t) => {
  await t.test('stop-failure → Error 并提醒', () => {
    const s = new Store()
    const { notify } = hook(s, 'stop-failure', { error: 'API 超时' })
    assert.equal(s.session('x').state, STATE.ERROR)
    assert.match(notify.subtitle, /出错/)
    assert.equal(notify.body, 'API 超时')
  })
  await t.test('post-tool-failure 记进时间线但不改状态为 Error', () => {
    const s = new Store()
    hook(s, 'pre-tool-use', { tool_name: 'Bash', tool_input: { command: 'x' } })
    hook(s, 'post-tool-failure', { tool_name: 'Bash' })
    assert.equal(s.session('x').state, STATE.RUNNING, '单个工具失败不等于整轮失败')
    assert.ok(s.events().some((e) => e.type === 'tool-error'))
  })
})

test('session-end 把会话移除', () => {
  const s = new Store()
  hook(s, 'session-start')
  hook(s, 'session-end', { reason: 'exit' })
  assert.equal(s.sessions().length, 0)
})

test('没有 session_id 的 payload 一律忽略', () => {
  const s = new Store()
  const r = s.applyHook('stop', {}, NOTIFY)
  assert.deepEqual(r, { body: {}, notify: null })
  assert.equal(s.sessions().length, 0, '不该凭空造会话')
})

test('审批等待状态', async (t) => {
  const s = new Store()
  await t.test('markWaitingApproval → Waiting Approval', () => {
    s.markWaitingApproval('x', { id: 'ap1', tool_name: 'Bash', summary: '删东西', cwd: '/tmp/p' })
    const x = s.session('x')
    assert.equal(x.state, STATE.WAITING_APPROVAL)
    assert.equal(x.pending_approval_id, 'ap1')
    assert.equal(x.cwd, '/tmp/p', 'cwd 要从审批里补上')
  })
  await t.test('clear 之后回到 Running', () => {
    s.clearWaitingApproval('x')
    assert.equal(s.session('x').state, STATE.RUNNING)
    assert.equal(s.session('x').pending_approval_id, null)
  })
  await t.test('不在等待态时 clear 只清 id，不动状态', () => {
    const st = new Store()
    hook(st, 'stop')
    st.clearWaitingApproval('x')
    assert.equal(st.session('x').state, STATE.DONE, '不该把 Done 改成 Running')
  })
})

test('事件时间线', async (t) => {
  const s = new Store()
  hook(s, 'user-prompt-submit', { prompt: 'a' })
  hook(s, 'pre-tool-use', { tool_name: 'Bash', tool_input: { command: 'ls' } })
  s.applyHook('stop', { session_id: 'other' }, NOTIFY)

  await t.test('事件 id 单调递增', () => {
    const ids = s.events().map((e) => e.id)
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b))
  })
  await t.test('按 sinceId 增量拉取', () => {
    const all = s.events()
    assert.deepEqual(s.events(all[0].id).map((e) => e.id), all.slice(1).map((e) => e.id))
  })
  await t.test('能按会话过滤', () => {
    assert.ok(s.events(0, 'x').every((e) => e.session_id === 'x'))
    assert.equal(s.events(0, 'other').length, 1)
  })
  await t.test('超长内容被截断，不把整个 heredoc 塞进时间线', () => {
    const st = new Store()
    st.applyHook('user-prompt-submit', { session_id: 'x', prompt: 'x'.repeat(5000) }, NOTIFY)
    assert.ok(st.events()[0].detail.length < 300)
  })
})

test('restoreEvents：重启后接着原来的 id 往下发', async (t) => {
  await t.test('nextEventId 不回退', () => {
    const s = new Store()
    s.restoreEvents([{ id: 100, session_id: 'x', ts: 1, type: 'stop', detail: '' }], 101)
    hook(s, 'session-start')
    assert.ok(s.events().at(-1).id > 100, '新事件 id 必须大于恢复进来的')
  })
  await t.test('空数组不打断计数', () => {
    const s = new Store()
    s.restoreEvents([], 1)
    hook(s, 'session-start')
    assert.equal(s.events().length, 1)
  })
})

test('额度：账号级，不按会话存', async (t) => {
  const payload = (pct, resets = 111) => ({
    session_id: 'x',
    rate_limits: { five_hour: { used_percentage: pct, resets_at: resets }, seven_day: { used_percentage: 10 } },
  })

  await t.test('记下最新一次观测和来源会话', () => {
    const s = new Store()
    s.applyStatusLine(payload(42))
    const l = s.accountLimits()
    assert.equal(l.five_hour.pct, 42)
    assert.equal(l.from, 'x')
    assert.ok(l.at, '要带时间戳——界面上得标出这是多久前的数')
  })

  await t.test('后来的观测覆盖先前的（哪怕来自别的会话）', () => {
    // 按会话存会出现「旧会话的陈旧数字把最新数字顶掉」
    const s = new Store()
    s.applyStatusLine(payload(42))
    s.applyStatusLine({ ...payload(88), session_id: 'y' })
    assert.equal(s.accountLimits().five_hour.pct, 88)
    assert.equal(s.accountLimits().from, 'y')
  })

  await t.test('statusLineSeenAt 区分「没会话上报」和「上报了但没额度」', () => {
    const s = new Store()
    assert.equal(s.statusLineSeenAt(), null)
    s.applyStatusLine({ session_id: 'x' }) // 没有 rate_limits
    assert.ok(s.statusLineSeenAt(), '调过就要留痕')
    assert.equal(s.accountLimits(), null, '但额度仍是空')
  })
})

test('额度预警：同一个窗口只响一次', async (t) => {
  const at = (pct, resets) => ({
    session_id: 'x',
    rate_limits: { five_hour: { used_percentage: pct, resets_at: resets } },
  })
  const OPT = { quotaWarnPct: 90 }

  await t.test('过阈值时响', () => {
    const s = new Store()
    const w = s.applyStatusLine(at(92, 1000), OPT)
    assert.ok(w)
    assert.match(w.subtitle ?? w.title, /额度/)
  })
  await t.test('同一窗口再上报不重复响', () => {
    const s = new Store()
    s.applyStatusLine(at(92, 1000), OPT)
    assert.equal(s.applyStatusLine(at(95, 1000), OPT), null, '同一个 resets_at 只响一次')
  })
  await t.test('换了窗口才允许再响', () => {
    const s = new Store()
    s.applyStatusLine(at(92, 1000), OPT)
    assert.ok(s.applyStatusLine(at(91, 2000), OPT), 'resets_at 变了 = 新窗口')
  })
  await t.test('没到阈值不响', () => {
    assert.equal(new Store().applyStatusLine(at(50, 1000), OPT), null)
  })
  await t.test('阈值设 0 = 关闭', () => {
    assert.equal(new Store().applyStatusLine(at(99, 1000), { quotaWarnPct: 0 }), null)
  })
})

test('noteControl 把控制动作反映到状态上', async (t) => {
  const s = new Store()
  await t.test('pause → Paused', () => {
    s.noteControl('x', 'pause')
    assert.equal(s.session('x').state, STATE.PAUSED)
  })
  await t.test('resume 从 Paused 回到 Running', () => {
    s.noteControl('x', 'resume')
    assert.equal(s.session('x').state, STATE.RUNNING)
  })
  await t.test('cancelled → Idle', () => {
    s.noteControl('x', 'cancelled')
    assert.equal(s.session('x').state, STATE.IDLE)
  })
  await t.test('resume 一个没在暂停的会话不该把它拉成 Running', () => {
    const st = new Store()
    hook(st, 'stop')
    st.noteControl('x', 'resume')
    assert.equal(st.session('x').state, STATE.DONE)
  })
})

test('noteInbox：注入消息意味着这一轮继续', () => {
  const s = new Store()
  hook(s, 'stop')
  assert.equal(s.session('x').state, STATE.DONE)
  s.noteInbox('x', { text: '换个做法', count: 1 })
  const x = s.session('x')
  assert.equal(x.state, STATE.RUNNING, '注入之后这一轮没停')
  assert.ok(x.turn_started_at, '重新开始计时')
})

test('事件上限：不会无限增长', () => {
  const s = new Store()
  for (let i = 0; i < 2500; i++) hook(s, 'session-start')
  assert.ok(s.allEvents().length <= 2000, `事件数 ${s.allEvents().length} 超过上限`)
})
