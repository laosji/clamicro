/**
 * 控制标记的生命周期，跑在**真服务**上。
 *
 * 单测能证明 ControlStore 自己是对的，证明不了 server.mjs 那几个监听器把它
 * 接对了——而这一轮真正的 bug 全在接线处：`held` 只发一个方向、`control`
 * 广播了没人读。所以这个文件走 HTTP，看的是**手机拿到的那份会话对象**。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startServer } from './helpers/server.mjs'

let S
const SID = 'lifecycle-1'

const sessionOf = async () => {
  const r = await S.get('/api/sessions')
  const d = await r.json()
  return d.sessions.find((x) => x.session_id === SID) ?? null
}

const hook = (event, payload) =>
  S.post(`/hooks/${event}`, { session_id: SID, ...payload }, { raw: true })

before(async () => {
  S = await startServer({ port: 8803 })
})
after(async () => { await S?.stop() })

test('held 跟着挂起集合走，resume 之后要落回 false', async (t) => {
  await hook('session-start', { cwd: '/tmp/x' })
  await hook('user-prompt-submit', { prompt: '跑一下' })

  await t.test('还没暂停时没有 held', async () => {
    const s = await sessionOf()
    assert.equal(s.state, 'Running')
    assert.ok(!s.held)
  })

  await S.post(`/api/sessions/${SID}/pause`)

  await t.test('点了暂停：状态立刻是 Paused，但还没真挂住', async () => {
    const s = await sessionOf()
    assert.equal(s.state, 'Paused')
    assert.ok(!s.held, '这一段正是「界面说已暂停、agent 还在跑」的窗口')
  })

  // 一条会被挂住的工具调用。**不能 await**：它就是要一直不返回
  const heldCall = hook('pre-tool-use', { tool_name: 'Bash', tool_input: { command: 'ls' } })

  await t.test('撞上拦截点之后 held 为真', async () => {
    // 挂起是在服务端发生的，给它一拍
    for (let i = 0; i < 40 && !(await sessionOf())?.held; i++) {
      await new Promise((r) => setTimeout(r, 50))
    }
    const s = await sessionOf()
    assert.equal(s.held, true)
    assert.equal(s.state, 'Paused')
  })

  await S.post(`/api/sessions/${SID}/resume`)
  await heldCall // 放行之后这条请求才会返回

  await t.test('resume 之后 held 必须清掉', async () => {
    const s = await sessionOf()
    assert.equal(s.held, false,
      '只在挂住时发一次事件的那一版，这里会一直是 true——'
      + '一个恢复了的会话永远显示「正卡在工具调用前」')
    assert.equal(s.state, 'Running')
  })
})

test('取消从「已请求」到「已生效」', async (t) => {
  const SID2 = 'lifecycle-2'
  const h = (event, payload) => S.post(`/hooks/${event}`, { session_id: SID2, ...payload }, { raw: true })
  const s2 = async () => {
    const d = await (await S.get('/api/sessions')).json()
    return d.sessions.find((x) => x.session_id === SID2) ?? null
  }

  await h('session-start', { cwd: '/tmp/y' })
  await h('user-prompt-submit', { prompt: '部署' })
  await S.post(`/api/sessions/${SID2}/cancel`)

  await t.test('点完取消：状态不变，靠 control 说话', async () => {
    const s = await s2()
    assert.equal(s.state, 'Running', 'cancel 跟 pause 相反，不立刻改状态')
    assert.equal(s.control, 'cancelled',
      '这个字段就是「已请求、还没落地」——界面据它显示「将阻止下一步」')
  })

  await t.test('下一个拦截点消费掉它', async () => {
    const r = await h('pre-tool-use', { tool_name: 'Bash', tool_input: { command: 'terraform apply' } })
    const body = await r.json()
    assert.equal(body.continue, false, '这一条要被真的挡下来')

    const s = await s2()
    assert.equal(s.state, 'Idle')
    assert.equal(s.control, 'none', '消费完标记必须复位，否则会连累下一轮')
  })
})

/**
 * session-end 时 `control.forget()` 走的是 `#release`，而它现在**会发 held
 * 事件**。server.mjs 的监听器里有一句 `store.session(sid)`——那个方法对没见过
 * 的 id 是**新建**。
 *
 * 所以顺序很要紧：forget 必须在 store 删掉会话**之前**调用，否则事件会把
 * 一个刚结束的会话原地复活，而手机上那张卡片再也不会消失。
 *
 * 现在的顺序是对的（hooks.mjs 里 forget 在 applyHook 之前），这条测试是拿来
 * 挡住将来有人调换它们的。
 */
test('会话在挂起状态下结束，不会被 held 事件复活', async () => {
  const SID3 = 'lifecycle-3'
  const h = (event, payload) => S.post(`/hooks/${event}`, { session_id: SID3, ...payload }, { raw: true })
  const alive = async () => {
    const d = await (await S.get('/api/sessions')).json()
    return d.sessions.some((x) => x.session_id === SID3)
  }

  await h('session-start', { cwd: '/tmp/z' })
  await h('user-prompt-submit', { prompt: '跑' })
  await S.post(`/api/sessions/${SID3}/pause`)
  const heldCall = h('pre-tool-use', { tool_name: 'Bash', tool_input: { command: 'sleep 1' } })

  for (let i = 0; i < 40; i++) {
    const d = await (await S.get('/api/sessions')).json()
    if (d.sessions.find((x) => x.session_id === SID3)?.held) break
    await new Promise((r) => setTimeout(r, 50))
  }
  assert.equal(await alive(), true, '前提：这会儿它还在，而且挂着')

  await h('session-end', { reason: 'exit' })
  await heldCall // forget 会把它放行

  assert.equal(await alive(), false,
    '会话结束了就该消失。复活的话，手机上会留一张永远关不掉的卡片')
})
