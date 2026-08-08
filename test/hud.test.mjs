/**
 * 胶囊提示的排队。
 *
 * 存在的理由是用户报的一句话：**「有时候通知不显示，只听见声音了」**。
 *
 * 原因：屏幕上那个位置只能放一个胶囊，最初的做法是新的来了就**杀掉旧的**。
 * 审批批准和任务完成经常隔几百毫秒连着来，于是后一条在前一条还没画出来时
 * 就把它干掉了；而声音当时在 notify 层单独发，照响不误。听见两声、看见一个，
 * 丢掉的恰好是**先发生**的那件事。
 *
 * 所以这里测的不是「能不能弹」（那要真机截图），是**一条都不能被悄悄吞掉**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHudQueue, MAX_QUEUE } from '../src/hud.mjs'

/** 记录放过哪些、并把「放完」的时机交给测试控制 */
function fakeRunner() {
  const shown = []
  const pending = []
  const run = (item, done) => {
    shown.push(item)
    pending.push(done)
  }
  return {
    run,
    shown,
    /** 让当前这条播完 */
    finish(code = 0) {
      const d = pending.shift()
      assert.ok(d, '没有正在播的条目')
      d(code)
    },
    get inFlight() {
      return pending.length
    },
  }
}
const item = (t) => ({ icon: '✓', title: t, subtitle: '', ms: 100, sound: false })

const silence = () => {
  const w = console.warn
  const e = console.error
  console.warn = () => {}
  console.error = () => {}
  return () => { console.warn = w; console.error = e }
}

test('串行：一次只放一条', async (t) => {
  const f = fakeRunner()
  const q = createHudQueue(f.run)

  await t.test('第一条立刻开始', () => {
    q.push(item('a'))
    assert.deepEqual(f.shown.map((i) => i.title), ['a'])
  })

  await t.test('第二条要等——两条叠在同一位置会互相透出文字', () => {
    q.push(item('b'))
    assert.deepEqual(f.shown.map((i) => i.title), ['a'], 'b 不该在 a 还在播时开始')
  })

  await t.test('前一条播完，后一条自动接上（不是丢掉）', () => {
    f.finish()
    assert.deepEqual(f.shown.map((i) => i.title), ['a', 'b'])
  })
})

test('用户报的那个 bug：连着两条不能只剩一条', () => {
  // 审批 + 完成经常隔几百毫秒连着来，原来的实现会杀掉第一条
  const f = fakeRunner()
  const q = createHudQueue(f.run)
  q.push(item('审批'))
  q.push(item('完成'))
  f.finish()
  assert.deepEqual(f.shown.map((i) => i.title), ['审批', '完成'], '两条都必须出现过')
})

test('积压时丢最旧的，而且要出声', async (t) => {
  const un = silence()
  const f = fakeRunner()
  const q = createHudQueue(f.run)
  for (let i = 0; i < MAX_QUEUE + 5; i++) q.push(item(`m${i}`))
  un()

  await t.test(`排队深度不超过上限 + 正在播的那条`, () => {
    assert.ok(q.depth <= MAX_QUEUE + 1, `depth=${q.depth}`)
  })

  await t.test('丢的是最旧的，留下的是最新的——旧状态播出来时早已过期', async () => {
    const un2 = silence()
    while (f.inFlight) f.finish()
    un2()
    const titles = f.shown.map((i) => i.title)
    assert.equal(titles[0], 'm0', '第一条已经在播了，不受丢弃影响')
    assert.ok(titles.includes(`m${MAX_QUEUE + 4}`), '最新的一条必须留下')
  })

  await t.test('丢弃必须打日志——静默丢弃是这个项目明令禁止的', () => {
    const seen = []
    const w = console.warn
    console.warn = (m) => seen.push(String(m))
    const g = createHudQueue(() => {})
    for (let i = 0; i < MAX_QUEUE + 2; i++) g.push(item(`x${i}`))
    console.warn = w
    assert.ok(seen.some((m) => m.includes('丢弃')), `没有丢弃日志: ${JSON.stringify(seen)}`)
  })
})

test('一条失败不能卡住整个队列', async (t) => {
  await t.test('runner 抛异常时后面的照常放', () => {
    const un = silence()
    const shown = []
    let first = true
    const q = createHudQueue((it) => {
      if (first) { first = false; throw new Error('spawn 失败') }
      shown.push(it.title)
    })
    q.push(item('炸的'))
    q.push(item('好的'))
    un()
    assert.deepEqual(shown, ['好的'], '第一条炸了，第二条必须还能放')
  })

  await t.test('非 0 退出码要报出来——没画出来必须留痕', () => {
    const seen = []
    const e = console.error
    console.error = (m) => seen.push(String(m))
    const f = fakeRunner()
    const q = createHudQueue(f.run)
    q.push(item('a'))
    f.finish(137)
    console.error = e
    assert.ok(seen.some((m) => m.includes('137')), `没报退出码: ${JSON.stringify(seen)}`)
  })

  await t.test('exit 和 error 都来时只算一次，不会把队列推快一格', () => {
    const shown = []
    let saved = null
    const q = createHudQueue((it, done) => { shown.push(it.title); saved = done })
    q.push(item('a'))
    q.push(item('b'))
    q.push(item('c'))
    const d = saved
    d(0)
    d(0) // 重复回调
    assert.deepEqual(shown, ['a', 'b'], 'c 不该被提前拉起来')
  })
})

test('idle()：等队列放完', async (t) => {
  await t.test('空队列立刻 resolve', async () => {
    await createHudQueue(() => {}).idle()
  })

  await t.test('有东西在播时要等——自检靠它，不等就是「说通了但没看见」', async () => {
    const f = fakeRunner()
    const q = createHudQueue(f.run)
    q.push(item('a'))
    q.push(item('b'))
    let done = false
    const p = q.idle().then(() => { done = true })
    await null
    assert.equal(done, false, 'a 还在播就 resolve 了')
    f.finish()
    f.finish()
    await p
    assert.equal(done, true)
  })
})
