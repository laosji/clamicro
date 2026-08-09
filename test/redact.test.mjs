/**
 * 凭证不能从自己的事件流里漏出去。
 *
 * 这个测试是踩到实物之后补的：在自己机器的 `history.json` 里搜到了 5 次
 * 主令牌。来源是 Claude 的回复原文——它在对话里贴过登录地址
 * `http://host:8765/ui?t=<主令牌>`，Stop hook 把整段回复存进了 `events[].detail`。
 *
 * 危害不是「日志里有密码」这种程度，是**提权**：
 *
 *   · 配对后的手机只持有**设备令牌**，可以被 `clamicro forget <id>` 单独吊销
 *   · 主令牌不属于任何设备，forget 吊销不掉，而且还能签发新设备
 *   · 事件流通过 /api/state 发给任何持有效令牌的客户端
 *
 * 于是一台本该只有「自己那一份可吊销权限」的手机，能读回一把万能钥匙。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeRedactor, noRedact } from '../src/redact.mjs'
import { Store } from '../src/state.mjs'

/**
 * 夹具必须是**一眼假**的。
 *
 * 第一版我照着自己机器上的真令牌敲，前 8 个字符一模一样，而这个文件是要
 * 推到公开仓库的——43 位里泄 8 位，搜索空间实打实小了一截。发布前扫描只查
 * 「有没有完整令牌」，完整匹配不上就放行了，前缀泄漏它看不出来。
 *
 * 测试用的凭证不需要「看起来真」，只需要长度够（redact 对 <12 字符的不做
 * 全局替换）、且不像任何真实存在的东西。
 */
const TOKEN = 'EXAMPLE-MAIN-TOKEN-DO-NOT-USE-000000000000'
const DEVICE = 'EXAMPLE-DEVICE-TOKEN-DO-NOT-USE-0000'

test('抹除器', async (t) => {
  const redact = makeRedactor(() => [TOKEN, DEVICE])

  await t.test('抹掉主令牌', () => {
    const got = redact(`扫这个：http://mac.local:8765/ui?t=${TOKEN}`)
    assert.ok(!got.includes(TOKEN), got)
  })

  await t.test('抹掉设备令牌', () => {
    assert.ok(!redact(`cookie ccm=${DEVICE}`).includes(DEVICE))
  })

  await t.test('按 ?t= 形状抹，值不用认识——这道网罩住已轮换的旧令牌', () => {
    const old = 'someOldTokenThatWasRotatedAwayLongAgo'
    const got = redact(`http://x:8765/ui?t=${old}`)
    assert.ok(!got.includes(old), `旧令牌没被抹: ${got}`)
  })

  await t.test('单条审批的 ?k= 一样抹', () => {
    const got = redact('http://x:8765/ui/a/abc?k=Ky7Qm2XvNbLsKtRw3EyU')
    assert.ok(!got.includes('Ky7Qm2XvNbLsKtRw3EyU'), got)
  })

  await t.test('&t= 也要抹，不只是 ?t=', () => {
    assert.ok(!redact('http://x/ui?foo=1&t=SecretValue123456').includes('SecretValue123456'))
  })

  await t.test('一段文字里出现多次，全部抹掉', () => {
    const got = redact(`${TOKEN} 中间 ${TOKEN} 结尾 ${TOKEN}`)
    assert.equal(got.includes(TOKEN), false)
  })

  await t.test('正常文本原样保留', () => {
    const s = '把 src/ 重构完了，测试 416 通过'
    assert.equal(redact(s), s)
  })

  await t.test('太短的凭证不做全局替换——会把正常文本打得到处是 ***', () => {
    const short = makeRedactor(() => ['abc'])
    assert.equal(short('abc 出现在很多单词里'), 'abc 出现在很多单词里')
  })

  await t.test('非字符串原样返回，不抛', () => {
    for (const v of [null, undefined, 123, {}]) assert.equal(redact(v), v)
  })

  await t.test('凭证列表是函数——配对新设备后立刻生效', () => {
    let list = [TOKEN]
    const r = makeRedactor(() => list)
    const fresh = 'brandNewDeviceToken1234567890'
    assert.ok(r(fresh).includes(fresh), '还没加进去时不抹')
    list = [TOKEN, fresh]
    assert.ok(!r(fresh).includes(fresh), '加进去之后必须立刻抹')
  })
})

test('Store：事件明细不得带出凭证', async (t) => {
  const mk = () => new Store().setRedactor(makeRedactor(() => [TOKEN]))

  await t.test('stop 事件的助手回复被抹', () => {
    const s = mk()
    s.applyHook('stop', {
      session_id: 'x',
      last_assistant_message: `登录地址：http://a:8765/ui?t=${TOKEN}`,
    }, { onStop: false, minTurnMs: 0 })
    const dump = JSON.stringify(s.events(0))
    assert.ok(!dump.includes(TOKEN), `事件流里还有令牌: ${dump.slice(0, 200)}`)
  })

  await t.test('会话上的 last_message 也被抹', () => {
    // 事件抹了但会话快照没抹的话，/api/sessions 照样把它发出去
    const s = mk()
    s.applyHook('stop', { session_id: 'x', last_assistant_message: `t=${TOKEN}` }, { onStop: false, minTurnMs: 0 })
    const dump = JSON.stringify(s.sessions())
    assert.ok(!dump.includes(TOKEN), `会话快照里还有令牌: ${dump}`)
  })

  await t.test('出错路径同样要抹', () => {
    const s = mk()
    s.applyHook('stop-failure', { session_id: 'x', error: `失败于 ?t=${TOKEN}` }, { onError: false })
    assert.ok(!JSON.stringify(s.events(0)).includes(TOKEN))
  })

  await t.test('用户提示词里的令牌也抹——粘贴登录地址问「这打不开」是常见操作', () => {
    const s = mk()
    s.applyHook('user-prompt-submit', { session_id: 'x', prompt: `这个打不开 http://a/ui?t=${TOKEN}` }, {})
    assert.ok(!JSON.stringify(s.events(0)).includes(TOKEN))
  })

  await t.test('不注入抹除器时行为不变（测试与旧调用方不受影响）', () => {
    const s = new Store()
    s.applyHook('stop', { session_id: 'x', last_assistant_message: 'hello' }, { onStop: false, minTurnMs: 0 })
    assert.equal(s.events(0).at(-1).detail, 'hello')
    assert.equal(new Store().setRedactor(null) instanceof Store, true, '传非函数要退回不抹，而不是崩')
  })
})

test('从盘上读回的旧事件也要抹', async (t) => {
  const dirty = [
    { id: 1, session_id: 'x', ts: 1, type: 'stop', detail: `地址 http://a/ui?t=${TOKEN}` },
    { id: 2, session_id: 'x', ts: 2, type: 'prompt', detail: '正常内容' },
  ]

  await t.test('restoreEvents 绕过 #log，不在那里抹就是个洞', () => {
    const s = new Store().setRedactor(makeRedactor(() => [TOKEN]))
    s.restoreEvents(dirty, 3)
    assert.ok(!JSON.stringify(s.events(0)).includes(TOKEN))
  })

  await t.test('顺带把老用户 history.json 里已有的凭证清掉', () => {
    // 升级到带抹除的版本后第一次启动，历史里那把钥匙就该没了，
    // 而不是等 3000 条上限慢慢把它挤出去
    const s = new Store().setRedactor(makeRedactor(() => [TOKEN]))
    s.restoreEvents(dirty, 3)
    assert.match(s.events(0)[0].detail, /\*\*\*/)
    assert.equal(s.events(0)[1].detail, '正常内容', '正常事件不能被动到')
  })

  await t.test('id 与 nextEventId 不受影响', () => {
    const s = new Store().setRedactor(makeRedactor(() => [TOKEN]))
    s.restoreEvents(dirty, 3)
    assert.deepEqual(s.events(0).map((e) => e.id), [1, 2])
    assert.equal(s.nextEventId, 3)
  })
})

test('noRedact 是恒等函数', () => {
  assert.equal(noRedact('abc'), 'abc')
})
