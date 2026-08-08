/**
 * Pause / Resume / Cancel。
 *
 * **这个文件是补的最高优先级测试**：126 行并发代码——Promise、定时器、
 * waiter 集合——而且已经出过一个 bug：`cancel()` 唤醒挂起的 waiter 之后
 * 没复位状态，`CANCELLED` 留着被下一个工具调用消费，表现是「取消一次，
 * 下一条命令也被取消」。并发代码 + 零测试是最危险的组合。
 *
 * 语义提醒：Claude Code 没有运行时暂停原语。「暂停」的真实含义是
 * **在下一个 PreToolUse 把它挂住**，当前这一步仍会跑完。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ControlStore, CONTROL } from '../src/control.mjs'

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))

test('默认放行', async () => {
  const c = new ControlStore()
  assert.equal(c.get('s'), CONTROL.NONE)
  assert.equal(await c.gate('s'), null, 'null = 放行')
})

test('pause 把下一个工具调用挂住', async (t) => {
  const c = new ControlStore()
  c.pause('s')

  let settled = false
  const gated = c.gate('s').then((r) => { settled = true; return r })
  await tick()

  await t.test('挂住了，没有立刻返回', () => assert.equal(settled, false))
  await t.test('isHeld 反映有人挂在拦截点上', () => assert.equal(c.isHeld('s'), true))

  await t.test('resume 放行', async () => {
    c.resume('s')
    assert.equal(await gated, null)
    assert.equal(c.isHeld('s'), false)
  })
})

test('cancel 的两条路径', async (t) => {
  await t.test('有人正挂着 → 就地消费，状态复位', async () => {
    // 这就是那个 bug 的形状：消费掉之后必须复位，否则会连累下一个工具调用
    const c = new ControlStore()
    c.pause('s')
    const gated = c.gate('s')
    await tick()

    const out = c.cancel('s')
    assert.equal(out.consumed, true, '应该被就地消费')
    assert.equal((await gated).continue, false, '挂着的那个应收到取消')
    assert.equal(c.get('s'), CONTROL.NONE, '消费后必须复位')

    // 关键断言：下一个工具调用不该被连累
    assert.equal(await c.gate('s'), null, '下一次必须放行——这正是曾经的 bug')
  })

  await t.test('没人挂着 → 留给下一个拦截点消费', async () => {
    const c = new ControlStore()
    const out = c.cancel('s')
    assert.equal(out.consumed, false)
    assert.equal(c.get('s'), CONTROL.CANCELLED, '没人消费就留着')

    const gated = await c.gate('s')
    assert.equal(gated.continue, false, '下一个拦截点收到取消')
    assert.equal(c.get('s'), CONTROL.NONE, '只取消这一轮')

    assert.equal(await c.gate('s'), null, '再下一个恢复正常')
  })
})

test('会话之间互不影响', async () => {
  const c = new ControlStore()
  c.pause('a')
  assert.equal(await c.gate('b'), null, '暂停 a 不该挂住 b')
  assert.equal(c.isHeld('a'), false, '还没有人撞上 a 的拦截点')
})

test('同一会话多个并发拦截点', async () => {
  const c = new ControlStore()
  c.pause('s')
  const g1 = c.gate('s')
  const g2 = c.gate('s')
  await tick()
  c.resume('s')
  assert.deepEqual(await Promise.all([g1, g2]), [null, null], '全部一起放行')
})

test('forget：会话结束时清干净，不留悬挂的 waiter', async () => {
  const c = new ControlStore()
  c.pause('s')
  const gated = c.gate('s')
  await tick()
  c.forget('s')
  assert.equal(await gated, null, '悬挂的 waiter 必须被释放')
  assert.equal(c.get('s'), CONTROL.NONE)
  assert.equal(c.isHeld('s'), false)
})

test('resume 一个没在暂停的会话是无操作', async () => {
  const c = new ControlStore()
  assert.equal(c.resume('s').state, CONTROL.NONE)
  assert.equal(await c.gate('s'), null)
})

test('状态变化会广播出去（UI 靠它更新）', async (t) => {
  const c = new ControlStore()
  const seen = []
  c.on('change', (sid, st) => seen.push([sid, st]))
  c.pause('s')
  c.resume('s')
  await t.test('pause / resume 各一次', () => {
    assert.deepEqual(seen, [['s', CONTROL.PAUSED], ['s', CONTROL.NONE]])
  })

  await t.test('真的挂住时发 held', async () => {
    const held = []
    c.on('held', (sid) => held.push(sid))
    c.pause('s')
    c.gate('s')
    await tick()
    assert.deepEqual(held, ['s'])
    c.resume('s')
  })
})
