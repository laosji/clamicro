/**
 * 提醒通道的分发。
 *
 * 存在的理由很具体：刘海胶囊写完了、注释也写了「仿系统连外设那条」，但
 * `notify()` 从头到尾走的是 `display notification`——**代码在，就是没接线**，
 * 不报错、日志照打、看起来一切正常，只有肉眼看屏幕才能发现不对。
 *
 * 这是这个项目反复出现的那类故障：静默失败伪装成正常。所以这里不测
 * osascript 到底渲染成什么样（那测不了），只测一件事：
 * **样式设成什么，就必须真的走到那个通道。**
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeNotifier } from '../src/notify.mjs'

const spy = () => {
  const calls = []
  const fn = (msg) => calls.push(msg)
  fn.calls = calls
  return fn
}
const setup = (notifyCfg) => {
  const notch = spy()
  const banner = spy()
  const notify = makeNotifier({ notify: { macNotify: true, ...notifyCfg } }, { notch, banner })
  return { notify, notch, banner }
}
const MSG = { title: 'Clamicro', icon: '⚠️', subtitle: 'proj 需要审批', body: 'rm -rf ./x' }

test('样式分发', async (t) => {
  await t.test("'notch' 只走刘海", async () => {
    const { notify, notch, banner } = setup({ style: 'notch' })
    await notify(MSG)
    assert.equal(notch.calls.length, 1)
    assert.equal(banner.calls.length, 0)
  })

  await t.test("'banner' 只走系统横幅", async () => {
    const { notify, notch, banner } = setup({ style: 'banner' })
    await notify(MSG)
    assert.equal(notch.calls.length, 0)
    assert.equal(banner.calls.length, 1)
  })

  await t.test("'both' 两个都走", async () => {
    const { notify, notch, banner } = setup({ style: 'both' })
    await notify(MSG)
    assert.equal(notch.calls.length, 1)
    assert.equal(banner.calls.length, 1)
  })

  await t.test('没配 style 时默认刘海——老配置文件升级上来不会变哑', async () => {
    const { notify, notch, banner } = setup({})
    await notify(MSG)
    assert.equal(notch.calls.length, 1, '缺字段不能退化成两个通道都不走')
    assert.equal(banner.calls.length, 0)
  })

  await t.test('未知样式退回刘海，不是静默丢弃', async () => {
    // 手改配置打错一个字母就一声不响什么都不弹，是最坏的故障形态：
    // 你会以为它还在守着
    for (const bad of ['notchh', 'Notch', '', null, 123]) {
      const { notify, notch } = setup({ style: bad })
      await notify(MSG)
      assert.equal(notch.calls.length, 1, `style=${JSON.stringify(bad)} 时没弹任何东西`)
    }
  })
})

test('macNotify 关掉时两个通道都不走', async () => {
  const notch = spy()
  const banner = spy()
  const notify = makeNotifier({ notify: { macNotify: false, style: 'both' } }, { notch, banner })
  await notify(MSG)
  assert.equal(notch.calls.length, 0)
  assert.equal(banner.calls.length, 0)
})

test('消息原样透传，通道自己决定怎么排版', async () => {
  const { notify, notch } = setup({ style: 'notch' })
  await notify(MSG)
  assert.deepEqual(notch.calls[0], MSG)
})

test('通道抛异常不能带走 hook 链路', async (t) => {
  // 工具调用还阻塞着等这个 HTTP 请求返回，提醒失败绝不能变成任务失败
  await t.test('刘海抛', async () => {
    const notify = makeNotifier(
      { notify: { macNotify: true, style: 'notch' } },
      { notch: () => { throw new Error('osascript 没了') }, banner: spy() },
    )
    await assert.doesNotReject(() => notify(MSG))
  })

  await t.test('横幅抛（异步）', async () => {
    const notify = makeNotifier(
      { notify: { macNotify: true, style: 'banner' } },
      { notch: spy(), banner: async () => { throw new Error('boom') } },
    )
    await assert.doesNotReject(() => notify(MSG))
  })

  await t.test("'both' 下刘海抛了，横幅还是要发出去", async () => {
    const banner = spy()
    const notify = makeNotifier(
      { notify: { macNotify: true, style: 'both' } },
      { notch: () => { throw new Error('boom') }, banner },
    )
    await notify(MSG)
    assert.equal(banner.calls.length, 1, '一个通道坏掉不该把另一个也拖下水')
  })
})

test('专注模式：静音但不隐藏', async (t) => {
  const mk = (focus, cfg = {}) => {
    const notch = spy()
    const banner = spy()
    const notify = makeNotifier(
      { notify: { macNotify: true, style: 'notch', ...cfg } },
      { notch, banner, focus: () => focus },
    )
    return { notify, notch, banner }
  }

  await t.test('专注开着时照样显示', async () => {
    const { notify, notch } = mk(true)
    await notify(MSG)
    assert.equal(notch.calls.length, 1, '藏起来的话，待审批会卡到超时被拒')
  })

  await t.test('但标记为静音', async () => {
    const { notify, notch } = mk(true)
    await notify(MSG)
    assert.equal(notch.calls[0].silent, true)
  })

  await t.test('专注关着时不动原消息', async () => {
    const { notify, notch } = mk(false)
    await notify(MSG)
    assert.equal(notch.calls[0].silent, undefined)
  })

  await t.test('respectFocus: false 时无视专注', async () => {
    const { notify, notch } = mk(true, { respectFocus: false })
    await notify(MSG)
    assert.equal(notch.calls[0].silent, undefined)
  })

  await t.test('原消息对象不被就地改写', async () => {
    // 同一条 msg 会同时发给刘海和横幅，就地改会串味
    const { notify } = mk(true)
    const msg = { ...MSG }
    await notify(msg)
    assert.equal(msg.silent, undefined)
  })
})
