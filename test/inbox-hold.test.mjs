/**
 * 「等我回话」：把 Stop 挂住，等手机上的回复。
 *
 * ## 它解决的是哪一刻
 *
 * Claude Code 在终端里等你打字的那一刻，**服务手上没有任何能回的请求**：
 * Stop 早就回过 `{}` 了，之后那条 `Notification: idle_prompt` 是单向的，
 * Claude Code 不等它的回包。所以那时你在手机上打的字没有东西可以搭载，
 * 只能躺到你回终端敲一下。
 *
 * 唯一的口子是提前一步：趁这一轮还没结束就说好「结束时挂住等我」。
 *
 * ## 为什么这些要用注入时钟测
 *
 * 挂起是 90 秒。真等一遍的测试没人会跑第二次，而且在慢机器上还会飘。
 * `hold()` 收 `setTimer`/`clearTimer`，测试里换成手动触发——超时那条分支
 * 才测得动，而它恰恰是**代价最大**的一条（终端被堵住的那 90 秒）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Inbox } from '../src/inbox.mjs'

/** 手动定时器：不到你说 fire()，超时永远不会发生 */
function fakeTimer() {
  const jobs = new Map()
  let n = 0
  const setTimer = (fn) => { jobs.set(++n, fn); return n }
  const clearTimer = (id) => { jobs.delete(id) }
  return {
    setTimer,
    clearTimer,
    fire: () => { const all = [...jobs.values()]; jobs.clear(); all.forEach((f) => f()); return all.length },
    pending: () => jobs.size,
  }
}

test('没打开开关时，一切照旧', async (t) => {
  await t.test('hold 立刻返回 null，不挂任何东西', async () => {
    // 这条最要紧：功能默认关着，Stop 必须像以前一样立刻放行。
    // 挂住一个没人要求挂的 Stop，等于凭空堵住别人的终端
    const inbox = new Inbox()
    const t0 = Date.now()
    assert.equal(await inbox.hold('s1'), null)
    assert.ok(Date.now() - t0 < 50, '没开开关却等了一会儿')
    assert.equal(inbox.isHolding('s1'), false)
  })
})

test('开着的时候：挂住，等到话就送出去', async (t) => {
  await t.test('有话进来就地送达', async () => {
    const inbox = new Inbox()
    const timer = fakeTimer()
    inbox.arm('s1')
    const held = inbox.hold('s1', timer)

    await new Promise((r) => setImmediate(r))
    assert.equal(inbox.isHolding('s1'), true, 'Stop 该挂着')

    inbox.queue('s1', '用方案 B')
    assert.equal(inbox.deliverIfHolding('s1'), true)

    assert.deepEqual(await held, { text: '用方案 B', count: 1 })
    assert.equal(inbox.isHolding('s1'), false, '送完不该还挂着')
    assert.equal(timer.pending(), 0, '定时器没清掉——它会在 90 秒后对着空气开火')
  })

  await t.test('多条合并成一次注入', async () => {
    // 逐条注入会让 Claude 每收一条就跑一轮，你连着写的三句话被拆成三次任务
    const inbox = new Inbox()
    const timer = fakeTimer()
    inbox.arm('s1')
    const held = inbox.hold('s1', timer)
    await new Promise((r) => setImmediate(r))

    inbox.queue('s1', '第一句')
    inbox.queue('s1', '第二句')
    inbox.deliverIfHolding('s1')

    const got = await held
    assert.equal(got.count, 2)
    assert.equal(got.text, '第一句\n\n第二句')
  })

  await t.test('没挂着的时候发消息，照旧排队', async () => {
    const inbox = new Inbox()
    inbox.queue('s1', '排着')
    assert.equal(inbox.deliverIfHolding('s1'), false)
    assert.equal(inbox.list('s1').length, 1, '不该被吃掉')
  })
})

test('挂满了没等到话：放行，并且**把开关关掉**', async (t) => {
  await t.test('超时返回 null —— 会话正常停下，和没这功能时一样', async () => {
    const inbox = new Inbox()
    const timer = fakeTimer()
    inbox.arm('s1')
    const held = inbox.hold('s1', timer)
    await new Promise((r) => setImmediate(r))

    assert.equal(timer.fire(), 1, '该有一个待触发的超时')
    assert.equal(await held, null)
    assert.equal(inbox.isHolding('s1'), false)
  })

  await t.test('顺手自动关掉开关', async () => {
    /*
     * 挂满一次都没等到回话，说明你已经走开了。这时候还留着开关，下一轮又堵
     * 一次，一直堵到你想起来为止——而每一次都是你自己的终端在空等。
     *
     * 「忘了关」的代价应该是一次，不是每一轮。
     */
    const inbox = new Inbox()
    const timer = fakeTimer()
    inbox.arm('s1')
    const held = inbox.hold('s1', timer)
    await new Promise((r) => setImmediate(r))
    timer.fire()
    await held

    assert.equal(inbox.isArmed('s1'), false,
      '超时之后开关还开着——下一轮会再堵 90 秒，而且没人再提醒你')
  })

  await t.test('等到话就不关（你还在，接着聊）', async () => {
    // 反面：真用起来的时候不该每回一句就要重新打开一次
    const inbox = new Inbox()
    const timer = fakeTimer()
    inbox.arm('s1')
    const held = inbox.hold('s1', timer)
    await new Promise((r) => setImmediate(r))
    inbox.queue('s1', '接着说')
    inbox.deliverIfHolding('s1')
    await held

    assert.equal(inbox.isArmed('s1'), true, '回了话反而把开关关了，等于每轮都要重开')
  })
})

test('挂着的时候把开关关掉：就地放行', async () => {
  // 人点了「关」，意思就是「别等我了」。还要再堵满 90 秒的话，
  // 这个关闭按钮等于没用
  const inbox = new Inbox()
  const timer = fakeTimer()
  inbox.arm('s1')
  const held = inbox.hold('s1', timer)
  await new Promise((r) => setImmediate(r))

  inbox.arm('s1', false)
  assert.equal(await held, null)
  assert.equal(inbox.isHolding('s1'), false)
  assert.equal(timer.pending(), 0)
})

test('holdingSince：倒数用的时间戳，不给就只能编', async (t) => {
  await t.test('没挂着时是 null', () => {
    const inbox = new Inbox()
    assert.equal(inbox.holdingSince('s1'), null)
  })
  await t.test('挂着时给出开始时刻', async () => {
    const inbox = new Inbox()
    const timer = fakeTimer()
    inbox.arm('s1')
    const before = Date.now()
    inbox.hold('s1', timer)
    await new Promise((r) => setImmediate(r))
    const since = inbox.holdingSince('s1')
    assert.ok(since >= before && since <= Date.now(),
      '界面拿它算「还剩多少秒」——不给的话那个数字就是编的')
  })
})

test('requeue：等到了话但连接断了，消息要退回去', async (t) => {
  await t.test('放回队列，而不是消失', () => {
    /*
     * drain 是破坏性的：队列清空、记一笔「已注入」，而消息能不能到全看后面
     * 那个还没写的 HTTP 响应。挂起可以持续 90 秒，这中间对面被 Ctrl-C、
     * 终端被关掉都是常事。不退回去就是「手机上显示已送达，实际上没人收到」。
     */
    const inbox = new Inbox()
    inbox.queue('s1', '别动数据库')
    const pending = inbox.drain('s1')
    assert.equal(inbox.list('s1').length, 0)

    inbox.requeue('s1', pending)
    assert.equal(inbox.list('s1').length, 1)
    assert.equal(inbox.list('s1')[0].text, '别动数据库')
  })

  await t.test('放回队列**头部**，不是尾部', () => {
    // 它们本来就排在最前面，顺序是用户写下来的顺序
    const inbox = new Inbox()
    inbox.queue('s1', '先说的')
    const pending = inbox.drain('s1')
    inbox.queue('s1', '后说的')
    inbox.requeue('s1', pending)
    assert.deepEqual(inbox.list('s1').map((m) => m.text), ['先说的', '后说的'])
  })

  await t.test('空的不放', () => {
    const inbox = new Inbox()
    assert.equal(inbox.requeue('s1', null), false)
    assert.equal(inbox.list('s1').length, 0)
  })
})

test('forget：会话没了，别留挂起者和开关', async () => {
  const inbox = new Inbox()
  const timer = fakeTimer()
  inbox.arm('s1')
  inbox.queue('s1', 'x')
  const held = inbox.hold('s1', timer)
  await new Promise((r) => setImmediate(r))

  inbox.forget('s1')
  assert.equal(await held, null, '悬挂的 Promise 永远不 resolve，那个 HTTP 响应就永远不写')
  assert.equal(inbox.isArmed('s1'), false)
  assert.equal(inbox.list('s1').length, 0)
})

test('挂起时长取的是 90 秒，不是技术上限', () => {
  /*
   * hook 的系统超时给到 600 秒，减去余量还有 570（src/limits.mjs）。这里主动
   * 取小得多，因为超出的每一秒都花在**堵住你自己的终端**上：挂着 Stop 的
   * 时候，终端不会把提示符还给你，人在 Mac 前面看到的是「它好像还在跑」。
   *
   * 这条断言不是为了钉住 90 这个数，是为了钉住「它必须远小于 570」——
   * 哪天有人为了「更从容」把它调到上限，这里会拦一下。
   */
  assert.equal(Inbox.HOLD_MS, 90_000)
  assert.ok(Inbox.HOLD_MS < 120_000,
    '挂起时长超过两分钟了。这段时间用户的终端是没有提示符的——再长就该先问问他')
})
