/**
 * ui/view.js —— **真的把它跑起来**。
 *
 * 这是整个 UI 层第二个有执行级测试的文件（第一个是 agentUsage）。在此之前，
 * home.html 里 47 个顶层函数只有一个被执行过，其余的测试全是
 * readFileSync + 正则——扫得出「这段字在不在」，扫不出「跑起来对不对」。
 * 那一轮三个「测试全绿、界面是坏的」，全出在那里；view.js 存在的理由就是
 * 让这一类判断能在这里被调用，而不是只能被 grep。
 *
 * 所以下面每一条都**调用**，不匹配源码。
 *
 * 时间一律显式传 now：不传的话跟时间有关的分支只能靠 sleep 去撞，
 * 而那种测试会在慢机器上随机变红——然后被人加 retry，然后它就再也不报警了。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(root, 'ui/view.js'), 'utf8')

/**
 * 空白的 vm context —— 没有 document、没有 window、没有任何全局。
 *
 * 这本身就是一条断言：view.js 里但凡有一处伸手去摸全局或 DOM，这里就
 * ReferenceError。「能不能在空 context 里跑」正是决定一个函数该不该搬进
 * view.js 的判据，把它做成测试环境比写在注释里管用。
 */
const V = vm.runInContext(
  `${src}\n;({ sessionStaleNote, ago, quotaStale, quotaStaleNote, isIdleView })`,
  vm.createContext({}),
)

const T0 = 1_700_000_000_000 // 一个固定的「现在」，随便哪一刻都行，只要不动
const min = (n) => n * 60_000

test('sessionStaleNote：只陈述事实，不下死亡判定', async (t) => {
  await t.test('没标记就什么都不说', () => {
    // 服务端没标 stale_since = 它还在正常上报，这行字不该出现
    assert.equal(V.sessionStaleNote({ state: 'Running' }, T0), '')
  })

  await t.test('会话对象缺失时也不炸', () => {
    // 渲染路径上会话可能刚被清掉。这里返回空串，不是抛异常——
    // 一个异常会让整张列表渲染不出来，代价远大于少一行小字
    assert.equal(V.sessionStaleNote(null, T0), '')
    assert.equal(V.sessionStaleNote(undefined, T0), '')
  })

  await t.test('不到一小时说分钟', () => {
    const out = V.sessionStaleNote({ stale_since: T0 - min(7) }, T0)
    assert.match(out, /已经 7 分钟没有任何上报/)
  })

  await t.test('过了一小时改说小时', () => {
    // 「180 分钟」要在脑子里除一下才知道有多久，而这行字的全部作用
    // 就是让人一眼判断「这还正常吗」
    const out = V.sessionStaleNote({ stale_since: T0 - min(180) }, T0)
    assert.match(out, /已经 3 小时没有任何上报/)
    assert.doesNotMatch(out, /分钟/)
  })

  await t.test('两种可能都说出来，不替用户下判断', () => {
    // 一条跑二十分钟的测试命令，和一个 kill -9 掉的会话，在服务端看来
    // 一模一样。我们分不出来，就不能装作分得出来
    const out = V.sessionStaleNote({ stale_since: T0 - min(30) }, T0)
    assert.match(out, /可能还在跑一条长命令/)
    assert.match(out, /也可能那边已经没了/)
  })
})

test('ago：越久越粗，但不许粗到要人心算', async (t) => {
  await t.test('没有时间戳就说不知道', () => {
    // 编一个「刚刚」出来是最坏的选项：它看起来是个确定的答案
    assert.equal(V.ago(null, T0), '未知')
    assert.equal(V.ago(0, T0), '未知')
    assert.equal(V.ago(undefined, T0), '未知')
  })

  await t.test('四档各自的说法', () => {
    assert.equal(V.ago(T0 - 30_000, T0), '30 秒前')
    assert.equal(V.ago(T0 - min(5), T0), '5 分钟前')
    assert.equal(V.ago(T0 - min(180), T0), '3 小时前')
    assert.equal(V.ago(T0 - min(60 * 24 * 4), T0), '4 天前')
  })

  await t.test('到天为止，不会冒出「96 小时前」', () => {
    // 这是加最后一档的原因：小时封顶时，四天前的额度数据会写成
    // 「96 小时前」，而人看到那个数字第一反应是去除以 24
    assert.doesNotMatch(V.ago(T0 - min(60 * 24 * 4), T0), /小时/)
  })
})

test('quotaStale：「没拿到过」和「拿到过但旧了」不是一件事', async (t) => {
  await t.test('从没拿到过额度时不算过期', () => {
    // 这两种情况界面上说的话完全不同：一个是「新开一个会话后这里会出现
    // 数字」，一个是压灰 + 说明多旧。混成一个布尔的话，第一次打开页面的人
    // 会看到一句「这是旧数据」，而屏幕上根本没有数据
    assert.equal(V.quotaStale(null, T0), false)
    assert.equal(V.quotaStale(undefined, T0), false)
  })

  await t.test('十分钟以内算新鲜', () => {
    assert.equal(V.quotaStale({ at: T0 - min(9) }, T0), false)
  })

  await t.test('超过十分钟就是旧的', () => {
    // statusLine 在活跃会话里每次响应都上报。十分钟没动静 = 没有会话在报，
    // 那么屏幕上那个百分比就不再是当前值
    assert.equal(V.quotaStale({ at: T0 - min(11) }, T0), true)
    assert.equal(V.quotaStale({ at: T0 - min(60 * 19) }, T0), true)
  })
})

test('quotaStaleNote：先说多旧，再说怎么办', async (t) => {
  const quota = { at: T0 - min(60 * 19) }

  await t.test('两件事各说一次，中间用 · 分开', () => {
    const out = V.quotaStaleNote(quota, 'no-field', T0)
    assert.match(out, /^19 小时前的数据 · /)
    assert.equal(out.split('·').length, 2, '一句话里不该出现第二个分隔符')
  })

  await t.test('不再是一条 ⚠️ 警告', () => {
    // 它曾经是灰环下面最响的东西：一个黄三角配两句话，为的是说一件既不
    // 紧急、也不需要你此刻做任何事的事。而「不是当前值」两只灰环已经说过了
    const out = V.quotaStaleNote(quota, 'no-field', T0)
    assert.doesNotMatch(out, /⚠️|警告/)
  })

  await t.test('这个界面刷不出来时，说的是另一条路', () => {
    // hooks-only = 装了 clamicro 但没走 statusLine。这时候「新开一个会话
    // 就会刷新」是**假话**——新开多少个都不会，得在终端里跑 claude
    const out = V.quotaStaleNote(quota, 'hooks-only', T0)
    assert.match(out, /此界面不刷新/)
    assert.match(out, /<code>claude<\/code>/)
    assert.doesNotMatch(out, /新开一个 Claude Code 会话就会刷新/)
  })

  await t.test('其余情况才说「新开一个会话就会刷新」', () => {
    for (const why of ['no-field', 'nothing', 'no-cc', undefined]) {
      assert.match(V.quotaStaleNote(quota, why, T0), /新开一个 Claude Code 会话就会刷新/)
    }
  })

  await t.test('「就会」不是「才会」', () => {
    // 前者说的是「这么点事就够了」，后者听起来像在拦你
    assert.doesNotMatch(V.quotaStaleNote(quota, 'no-field', T0), /才会刷新/)
  })
})

test('isIdleView：参考信息在有事发生时让位', async (t) => {
  const idle = (over = {}) => V.isIdleView({ now: T0, ...over })

  await t.test('什么都没有时是空闲', () => {
    assert.equal(idle(), true)
    assert.equal(idle({ sessions: [{ state: 'Idle' }, { state: 'Waiting Input' }] }), true)
  })

  await t.test('断线时不算空闲', () => {
    // 断线时屏幕上所有数字都是断开前的旧值。把用量、skill 计数这类参考信息
    // 摆出来，等于拿旧数据冒充当前状态
    assert.equal(idle({ disconnected: true }), false)
  })

  await t.test('有待批就不算空闲', () => {
    assert.equal(idle({ pending: [{ id: 'a' }] }), false)
  })

  for (const state of ['Running', 'Waiting Approval', 'Paused', 'Error']) {
    await t.test(`有一个 ${state} 的会话就不算空闲`, () => {
      assert.equal(idle({ sessions: [{ state: 'Idle' }, { state }] }), false)
    })
  }

  await t.test('刚完成的一分钟里也算有事', () => {
    // 那一分钟你多半正想看结果，这时候把位置让给参考信息是抢戏
    assert.equal(idle({ sessions: [{ state: 'Done', updated_at: T0 - 30_000 }] }), false)
  })

  await t.test('完成超过一分钟就归于平静', () => {
    assert.equal(idle({ sessions: [{ state: 'Done', updated_at: T0 - min(2) }] }), true)
  })

  await t.test('一个参数都不传也不炸', () => {
    // 调用方是 viewState()，正常总会给全。但页面早期 sessions 还是 []、
    // cfg 还是 null 的那一小段时间里，这个函数会先被调到
    assert.equal(V.isIdleView(), true)
  })
})
