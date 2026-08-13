/**
 * 等待 Mac 确认的那一段状态机。
 *
 * 存在的理由：加了 Mac 授权确认之后，`/ui/pair/:id` 会阻塞到有人点按钮为止
 * ——最长 60 秒。手机那边就是一个白屏加载页，Safari 只有一根细进度条。人会
 * 以为「扫了没反应」，于是返回、重扫，把券一张张烧掉。改成扫码请求立刻返回
 * 等待页、确认在后台跑、页面轮询结果，就需要这个中间状态。
 *
 * 两条不能松的性质，都在这里钉：
 *   · **凭据是 watch 不是配对 id** —— id 曾出现在二维码里，见过 Mac 屏幕的人
 *     就能拿它去轮询把令牌接走，而 Mac 确认恰恰是为了防这种人
 *   · **allowed 只能领一次** —— 否则同一个 watch 能反复换设备令牌
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConfirmStore } from '../src/auth/pairing.mjs'

test('三态流转', async (t) => {
  await t.test('开出来是 pending', () => {
    const s = new ConfirmStore()
    const w = s.begin({ name: 'iPhone' })
    assert.equal(s.peek(w).state, 'pending')
  })

  await t.test('允许 → allowed，元数据带得回来', () => {
    const s = new ConfirmStore()
    const w = s.begin({ name: 'iPhone', viaTunnel: false })
    s.settle(w, true)
    const st = s.peek(w)
    assert.equal(st.state, 'allowed')
    assert.equal(st.meta.name, 'iPhone')
  })

  await t.test('拒绝 → denied', () => {
    const s = new ConfirmStore()
    const w = s.begin()
    s.settle(w, false)
    assert.equal(s.peek(w).state, 'denied')
  })

  await t.test('没见过的 watch → unknown，不是报错', () => {
    // 页面在后台待太久之后回来轮询，会落到这一条。它是正常路径，
    // 不该让前端看到 500
    assert.equal(new ConfirmStore().peek('nope').state, 'unknown')
  })
})

test('allowed 只能领一次', async (t) => {
  await t.test('领完就没了', () => {
    const s = new ConfirmStore()
    const w = s.begin({ name: 'iPhone' })
    s.settle(w, true)
    assert.equal(s.claim(w).name, 'iPhone')
    assert.equal(s.claim(w), null, '第二次领必须落空——否则一个 watch 能反复换令牌')
    assert.equal(s.peek(w).state, 'unknown')
  })

  await t.test('pending 和 denied 都领不到', () => {
    const s = new ConfirmStore()
    const a = s.begin()
    assert.equal(s.claim(a), null, 'pending 不能领')
    const b = s.begin()
    s.settle(b, false)
    assert.equal(s.claim(b), null, 'denied 不能领')
  })
})

test('settle 只认第一次', async (t) => {
  await t.test('结过账之后改不动', () => {
    // 确认框的 resolve 和兜底的 catch 都可能触发 settle，先到的说了算。
    // 后到的能改的话，一次「已拒绝」可能被翻成「已允许」
    const s = new ConfirmStore()
    const w = s.begin()
    assert.equal(s.settle(w, false), true)
    assert.equal(s.settle(w, true), false)
    assert.equal(s.peek(w).state, 'denied')
  })

  await t.test('对不存在的 watch settle 不抛', () => {
    assert.equal(new ConfirmStore().settle('nope', true), false)
  })
})

test('过期与清理', async (t) => {
  const T0 = 1_700_000_000_000
  const TTL = 180_000

  await t.test('超时之后查不到', () => {
    const s = new ConfirmStore()
    const w = s.begin({}, T0)
    s.settle(w, true, T0 + 1000)
    assert.equal(s.peek(w, T0 + TTL - 1).state, 'allowed')
    assert.equal(s.peek(w, T0 + TTL + 1).state, 'unknown', '过期的 allowed 不能还能领')
  })

  await t.test('过期的领不到', () => {
    const s = new ConfirmStore()
    const w = s.begin({}, T0)
    s.settle(w, true, T0)
    assert.equal(s.claim(w, T0 + TTL + 1), null)
  })

  await t.test('peek 顺手把过期项删掉，不会无限堆积', () => {
    const s = new ConfirmStore()
    const w = s.begin({}, T0)
    s.peek(w, T0 + TTL + 1)
    assert.equal(s.size, 0)
  })

  await t.test('begin 时清一遍老的', () => {
    const s = new ConfirmStore()
    s.begin({}, T0)
    s.begin({}, T0)
    assert.equal(s.size, 2)
    s.begin({}, T0 + TTL + 1)
    assert.equal(s.size, 1, '只剩新开的那条')
  })
})

test('watch 之间互不干扰', () => {
  // 两台手机同时扫（比如一台扫失败了换一台），各自的结果不能串
  const s = new ConfirmStore()
  const a = s.begin({ name: 'iPhone' })
  const b = s.begin({ name: 'iPad' })
  s.settle(a, true)
  assert.equal(s.peek(a).state, 'allowed')
  assert.equal(s.peek(b).state, 'pending')
  assert.equal(s.claim(a).name, 'iPhone')
  assert.equal(s.peek(b).state, 'pending', '领走 a 不该动 b')
})

test('watch 足够长，猜不出来', () => {
  // 它是这一段唯一的凭据：拿到它就能把设备令牌接走
  const s = new ConfirmStore()
  const w = s.begin()
  assert.ok(w.length >= 32, `watch 只有 ${w.length} 字符`)
  assert.notEqual(w, s.begin(), '两次不能撞')
})
