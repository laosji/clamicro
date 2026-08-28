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
import { ControlStore, CONTROL, CANCEL_TTL_MS } from '../src/control.mjs'

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

/**
 * `held` 事件必须**两个方向都发**。
 *
 * 这条是被一个半接通的功能推出来的：`gate()` 挂住时会 emit('held')，
 * server.mjs 据此把 `s.held` 置为 true——而释放的时候**什么都不发**，
 * 于是那个标记再也清不掉。一个曾经被暂停过的会话，此后永远显示「正卡在
 * 工具调用前」，哪怕早就恢复了。
 *
 * 当时没人发现，是因为没有任何前端读 `s.held`。接上之后它就是一条持续
 * 说假话的界面——正是这个项目最不想要的那类故障。
 */
test('held 事件在挂住和释放时都会发', async () => {
  const c = new ControlStore()
  /** @type {boolean[]} 每次 held 事件发生时的真实挂起状态 */
  const seen = []
  c.on('held', (sid) => seen.push(c.isHeld(sid)))

  c.pause('s')
  const gated = c.gate('s')
  await tick()
  assert.deepEqual(seen, [true], '挂住时发一次，且此刻确实挂着')

  c.resume('s')
  await gated
  assert.deepEqual(seen, [true, false], '释放时也要发，且此刻已经不挂了')
  assert.equal(c.isHeld('s'), false)
})

test('取消消费掉挂起时同样会发 held', async () => {
  const c = new ControlStore()
  const seen = []
  c.on('held', (sid) => seen.push(c.isHeld(sid)))

  c.pause('s')
  const gated = c.gate('s')
  await tick()
  c.cancel('s')
  const out = await gated

  assert.equal(out?.continue, false, '取消要真的挡下这一步')
  assert.deepEqual(seen, [true, false])
})

test('超时自己放行之后 held 也要落回 false', async () => {
  // MAX_HOLD_MS 是分钟级的，不等它；直接用 #drop 那条路——forget() 走的是
  // #release，超时走的是 #drop，两条都得发，所以两条都要有断言
  const c = new ControlStore()
  const seen = []
  c.on('held', (sid) => seen.push(c.isHeld(sid)))

  c.pause('s')
  const gated = c.gate('s')
  await tick()
  c.forget('s')
  await gated

  assert.deepEqual(seen, [true, false])
  assert.equal(c.isHeld('s'), false)
})

/**
 * **没被消费掉的取消只对这一轮有效。**
 *
 * 这是架构文档 §6.2.1 记的那个：「armed cancel 会跨回合」——取消请求没被
 * 消费掉的话会留到**下一轮的第一个工具调用**上，表现是「我上次点的取消，
 * 把这次的第一条命令干掉了」。那时的结论是「改它要动控制面的语义，
 * 没在这一轮做」。现在做了。
 *
 * turnKey 用会话的 `turn_started_at`：三个后端都有，不需要新字段，
 * 而且「这一轮」的定义天然就是它。
 */
test('取消只作用于点它的那一轮', async (t) => {
  await t.test('同一轮的下一个工具调用 —— 拦下', async () => {
    const c = new ControlStore()
    c.cancel('x', { turnKey: 1000 })
    const g = await c.gate('x', { turnKey: 1000 })
    assert.equal(g?.continue, false)
  })

  await t.test('**下一轮**的第一个工具调用 —— 放行', async () => {
    const c = new ControlStore()
    c.cancel('x', { turnKey: 1000 })          // 这一轮点的取消，没被消费
    const g = await c.gate('x', { turnKey: 2000 }) // 新一轮开始了
    assert.equal(g, null, '上一轮的取消干掉了这一轮的第一条命令')
  })

  await t.test('过期的取消不再生效', async () => {
    const c = new ControlStore()
    c.cancel('x', { turnKey: 1000, now: 0 })
    const g = await c.gate('x', { turnKey: 1000, now: CANCEL_TTL_MS + 1 })
    assert.equal(g, null, 'TTL 过了还在拦')
  })

  await t.test('没过期就还在', async () => {
    const c = new ControlStore()
    c.cancel('x', { turnKey: 1000, now: 0 })
    const g = await c.gate('x', { turnKey: 1000, now: CANCEL_TTL_MS - 1 })
    assert.equal(g?.continue, false)
  })

  /**
   * 服务在会话中途启动时 `turn_started_at` 是 null，两边都是 null 就比成了
   * 「同一轮」。所以还得有第二道：回合结束时显式作废（server.mjs 接
   * store 的 turn-end 事件）。
   */
  await t.test('轮次未知（服务中途启动）→ 仍然拦，但回合结束就作废', async () => {
    const c = new ControlStore()
    c.cancel('x', { turnKey: null })
    assert.equal(c.clearCancel('x', 'turn-end'), true, '应该有东西可清')
    const g = await c.gate('x', { turnKey: null })
    assert.equal(g, null, '回合都结束了还在拦')
  })

  await t.test('当场被挂起者消费掉的，不留 armed 标记', async () => {
    const c = new ControlStore()
    c.pause('x')
    const gate = c.gate('x', { turnKey: 1000 })   // 挂住
    await new Promise((r) => setTimeout(r, 10))
    const out = c.cancel('x', { turnKey: 1000 })
    assert.equal(out.consumed, true)
    assert.equal((await gate)?.continue, false, '挂着的那条要被取消掉')
    // 消费掉了就不该再留下什么，下一条命令照常跑
    assert.equal(await c.gate('x', { turnKey: 1000 }), null, '消费过还留着标记')
  })

  await t.test('clearCancel 对没有 armed 的会话是 no-op', () => {
    const c = new ControlStore()
    assert.equal(c.clearCancel('x'), false)
  })
})
