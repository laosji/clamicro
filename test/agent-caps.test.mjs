/**
 * 能力矩阵在服务端算不算数。
 *
 * 这个文件是补出来的，因为原来**只有界面按能力渲染**，端点谁都收。而
 * `capOf` 在 cfg 还没到手时回退成「全都支持」——手机上缓存着升级前的页面
 * 正是这个状态，而那恰恰是升级后的第一分钟。三条实测出来的后果：
 *
 *   · 对 DSH 会话点暂停 → 端点收下，界面显示「已暂停」，DSH 那边照跑
 *   · 对 DSH 会话发消息 → 排进队列，下一次 stop 上报把它排空并写进回包，
 *     而 DSH 的桥接是 fire-and-forget、根本不看回包 —— 消息永久丢失，
 *     界面记着「已注入」
 *   · Codex 的 approve 写着 false，审批照样跑完整套（那个字段没有任何
 *     代码读它）
 *
 * 三条都是同一个形状：**看起来生效了，其实什么都没发生**。这比「按钮点了
 * 没反应」糟，因为你不会去查。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startServer } from './helpers/server.mjs'
import { adoptAgent } from '../src/routes/hooks.mjs'
import { AGENTS } from '../src/agents.mjs'

let S
test.before(async () => { S = await startServer({ port: 8798 }) })
test.after(async () => { await S?.stop() })

/** 让某个 session_id 以某个后端的身份存在 */
const startSession = (sid, agent) =>
  fetch(`${S.base}/hooks/session-start?agent=${agent}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sid, cwd: `/tmp/${sid}` }),
  })

test('不支持暂停的后端，端点也得拒绝', async () => {
  await startSession('dsh-a', 'dsh')
  const r = await S.post('/api/sessions/dsh-a/pause', {})
  assert.equal(r.status, 409)
  assert.equal((await r.json()).error, 'unsupported')
})

test('不支持取消的后端同理', async () => {
  await startSession('dsh-b', 'dsh')
  const r = await S.post('/api/sessions/dsh-b/cancel', {})
  assert.equal(r.status, 409)
})

test('resume 永远放行', async () => {
  // 它是解除方向，不会制造假状态；挡住它反而可能把一个已经挂起的会话
  // 永远留在暂停里（能力表改动之前挂上的那种）
  await startSession('dsh-c', 'dsh')
  const r = await S.post('/api/sessions/dsh-c/resume', {})
  assert.equal(r.status, 200)
})

test('不支持发消息的后端，消息不许进队列', async () => {
  await startSession('dsh-d', 'dsh')
  const r = await S.post('/api/sessions/dsh-d/say', { text: '喂' })
  assert.equal(r.status, 409)
  // 关键是队列真的没东西 —— 收下再丢掉是最糟的那种
  const inbox = await (await S.get('/api/inbox')).json()
  assert.deepEqual(inbox.inbox?.['dsh-d'] ?? [], [])
})

test('Claude Code 一切照旧', async (t) => {
  await startSession('cc-a', 'claude-code')
  await t.test('暂停', async () => {
    assert.equal((await S.post('/api/sessions/cc-a/pause', {})).status, 200)
  })
  await t.test('发消息', async () => {
    assert.equal((await S.post('/api/sessions/cc-a/say', { text: '继续' })).status, 200)
  })
})

test('没见过的会话按默认能力放行', async () => {
  // 升级期唯一安全的假设：老 hook 不带 agent 字段。落回空能力会让一个
  // 正常的 Claude Code 会话突然被端点拒绝
  assert.equal((await S.post('/api/sessions/never-seen/pause', {})).status, 200)
})

test('approve 为假的后端不建审批记录，也不拦', async () => {
  assert.equal(AGENTS.codex.approve, false, '这条用例的前提是 codex 还没开审批')
  await startSession('cx-a', 'codex')

  const before = (await (await S.get('/api/approvals')).json()).approvals.length
  const r = await fetch(`${S.base}/hooks/permission-request?agent=codex`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: 'cx-a',
      cwd: '/tmp/cx-a',
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
    }),
  })

  // 立刻回，而且是「无意见」——不是一个决定
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), {})
  const after = (await (await S.get('/api/approvals')).json()).approvals.length
  assert.equal(after, before, '手机上不该冒出一张这个后端的审批卡片')
})

test('认不得的 agent 名在入口就被规范化', async (t) => {
  // 原来 s.agent 走 normalizeAgent、挑应答方言却比原始值，于是一个拼错的
  // 名字会让会话按 claude-code 渲染、审批回包却是 Claude Code 读不懂的
  // 中性形状 —— 决定被静默丢弃，手机上你明明批了
  const url = { searchParams: new URLSearchParams('agent=codx') }

  await t.test('拼错的落回默认后端', () => {
    const p = {}
    adoptAgent(p, url)
    assert.equal(p.agent, 'claude-code')
  })

  await t.test('认得的原样保留', () => {
    const p = {}
    adoptAgent(p, { searchParams: new URLSearchParams('agent=codex') })
    assert.equal(p.agent, 'codex')
  })

  await t.test('body 里写了的以 body 为准', () => {
    const p = { agent: 'dsh' }
    adoptAgent(p, url)
    assert.equal(p.agent, 'dsh')
  })

  await t.test('没写的保持没写', () => {
    // 「老版本上报」跟「写了个不认识的」不是一回事：后者该被纠正，
    // 前者不该被凭空补上一个字段
    const p = {}
    adoptAgent(p, { searchParams: new URLSearchParams('') })
    assert.equal('agent' in p, false)
  })
})
