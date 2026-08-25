/**
 * 跟读器在**真服务**上的接线。
 *
 * test/codex-tail.test.mjs 测的是模块本身；这一份测的是「路由有没有在对的
 * 时机把它挂上」——那是两个独立的失败点，而且第二个已经出过一次事故。
 *
 * ## 挡的是哪个回归
 *
 * 跟读原本只在 `session-start` 时才开始。于是有一整类会话永远跟不上：
 * **服务启动之前就已经开着的那些**。SessionStart 一个会话只发一次，服务
 * 重启之后那条早就过去了，之后只会收到 prompt / pre-tool-use。
 *
 * 而服务重启在生产里是常态：自愈、改配置、机器睡醒。真机现场是服务
 * 16:19:45 重启、会话 16:20:13 发来 prompt，卡片从此停在「运行中」——
 * 而 Codex 那边三秒后就报了额度耗尽。
 *
 * 这个回归**不会让任何单元测试变红**：模块本身好好的，只是没人调用它。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { startServer } from './helpers/server.mjs'

const SID = 'route-01a037f5-3901-7823'
// timestamp 不是装饰：跟读器首拍靠它筛掉旧事件（见 codex-tail.mjs）
const fail = () => JSON.stringify({
  timestamp: new Date().toISOString(),
  type: 'event_msg',
  payload: {
    type: 'task_complete', turn_id: 't1', last_agent_message: null,
    error: { message: "You've hit your usage limit." },
  },
})

let S, rollout

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const stateOf = async () => {
  const r = await S.get('/api/sessions')
  const d = await r.json()
  return d.sessions.find((x) => x.session_id === SID) ?? null
}

before(async () => {
  // 端口在 test/ 下必须唯一：node --test 是并行跑文件的（8798 已被占用）
  S = await startServer({ port: 8799 })
  // 服务用的是自己的临时 HOME，rollout 也要造在那底下
  const dir = join(S.home, '.codex', 'sessions', '2026', '08', '25')
  mkdirSync(dir, { recursive: true })
  rollout = join(dir, `rollout-2026-08-25T16-06-52-${SID}.jsonl`)
  writeFileSync(rollout, '')
})

after(async () => { await S?.stop() })

test('会话在服务启动之前就开着 —— 照样跟得上', async (t) => {
  await t.test('只发 prompt，不发 session-start（重启后的真实时序）', async () => {
    const r = await S.post('/hooks/user-prompt-submit?agent=codex', { session_id: SID, cwd: '/tmp/p', prompt: 'hello' }, { raw: true })
    assert.equal(r.status, 200)
    const s = await stateOf()
    assert.equal(s.state, 'Running', 'prompt 本来就该把它推进运行中')
  })

  await t.test('rollout 里的 task_complete 到了 —— 状态要跟着走', async () => {
    appendFileSync(rollout, `${fail()}\n`)
    // 跟读器是 1 秒一拍
    for (let i = 0; i < 30 && (await stateOf())?.state === 'Running'; i++) await wait(200)
    const s = await stateOf()
    assert.equal(s.state, 'Error',
      '这一条不过 = 服务重启后开着的 Codex 会话会永远停在「运行中」')
  })

  await t.test('卡片上显示的是报错原文，不是那句通用的兜底', async () => {
    // ui/home.html 在 last_message 为空时会回落到「会话异常终止」
    assert.match((await stateOf()).last_message, /usage limit/)
  })
})

test('session-end 之后不再跟读', async (t) => {
  await t.test('收到 session-end，会话从列表里消失', async () => {
    const r = await S.post('/hooks/session-end?agent=codex', { session_id: SID, reason: 'exit' }, { raw: true })
    assert.equal(r.status, 200)
    assert.equal(await stateOf(), null)
  })

  await t.test('之后 rollout 再动也不该把它复活', async () => {
    /**
     * 这条比看上去有分量：`store.session(id)` 对没见过的 id 是**新建**。
     * 所以跟读器要是没被 unfollow，下一条 rollout 事件会凭空造出一个
     * 已经结束的会话，卡片重新出现在首页上。
     */
    appendFileSync(rollout, `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_started', turn_id: 't9' } })}\n`)
    await wait(1600)
    assert.equal(await stateOf(), null, '已经结束的会话不该被 rollout 复活')
  })
})
