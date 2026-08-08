/**
 * 从手机往 Claude Code 发消息的排队。
 *
 * hooks 是单向的，唯一的注入点是 Stop 的 decision:block。所以这个功能的
 * 真实语义是「排队，等这一轮跑完时送达」——`drain` 是那个交付时刻，
 * 它一旦漏消息或者重复交付，用户会以为消息丢了或者 Claude 重复执行。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Inbox } from '../src/inbox.mjs'

test('排队与读取', async (t) => {
  const ib = new Inbox()
  await t.test('queue 返回消息本体，带 id 和时间', () => {
    const m = ib.queue('s', '换个做法')
    assert.ok(m.id)
    assert.equal(m.text, '换个做法')
    assert.ok(m.at)
  })
  await t.test('list 拿到该会话的队列', () => {
    assert.equal(ib.list('s').length, 1)
  })
  await t.test('没排过队的会话返回空数组，不是 undefined', () => {
    assert.deepEqual(ib.list('nobody'), [])
  })
  await t.test('会话之间互不干扰', () => {
    ib.queue('other', '别的会话')
    assert.equal(ib.list('s').length, 1)
    assert.equal(ib.list('other').length, 1)
  })
})

test('drain：多条合并成一次注入', async (t) => {
  await t.test('合并而不是逐条', () => {
    // 逐条注入会让 Claude 每收一条就跑一轮，连着写的三句话被拆成三次任务
    const ib = new Inbox()
    ib.queue('s', '第一句')
    ib.queue('s', '第二句')
    ib.queue('s', '第三句')
    const d = ib.drain('s')
    assert.equal(d.count, 3)
    assert.equal(d.text, '第一句\n\n第二句\n\n第三句')
  })

  await t.test('取走即清空——不能重复交付', () => {
    const ib = new Inbox()
    ib.queue('s', 'x')
    ib.drain('s')
    assert.equal(ib.drain('s'), null, '第二次 drain 必须是 null，否则 Claude 会重复执行')
    assert.deepEqual(ib.list('s'), [])
  })

  await t.test('空队列返回 null，不返回空字符串', () => {
    // 返回 { text: '' } 的话，Stop hook 会拿它去 block，Claude 收到一句空话
    const ib = new Inbox()
    assert.equal(ib.drain('s'), null)
    ib.queue('s', 'x')
    ib.drain('s')
    assert.equal(ib.drain('s'), null, '清空之后也要是 null')
  })

  await t.test('保持写入顺序', () => {
    const ib = new Inbox()
    for (const t of ['a', 'b', 'c']) ib.queue('s', t)
    assert.equal(ib.drain('s').text, 'a\n\nb\n\nc')
  })
})

test('remove：撤回还没送达的消息', async (t) => {
  const ib = new Inbox()
  const a = ib.queue('s', 'a')
  const b = ib.queue('s', 'b')

  await t.test('按 id 删掉一条，其他不动', () => {
    assert.equal(ib.remove('s', a.id), true)
    assert.deepEqual(ib.list('s').map((m) => m.text), ['b'])
  })
  await t.test('删不存在的 id 返回 false', () => {
    assert.equal(ib.remove('s', 'nosuch'), false)
  })
  await t.test('删不存在的会话返回 false，不抛异常', () => {
    assert.equal(ib.remove('nobody', 'x'), false)
  })
  await t.test('删空之后会话条目本身也清掉', () => {
    ib.remove('s', b.id)
    assert.deepEqual(ib.all(), {}, '空队列不该留在 all() 里占位')
  })
})

test('all：只列有内容的会话', () => {
  const ib = new Inbox()
  ib.queue('a', 'x')
  ib.queue('b', 'y')
  ib.drain('a')
  assert.deepEqual(Object.keys(ib.all()), ['b'])
})

test('超长消息被截断', () => {
  const ib = new Inbox()
  const m = ib.queue('s', 'x'.repeat(10_000))
  assert.equal(m.text.length, 4000, '4000 字符上限——注入的是对话输入，不该没有边界')
})

test('非字符串输入不炸', async (t) => {
  const ib = new Inbox()
  for (const bad of [123, null, undefined, { a: 1 }]) {
    await t.test(String(bad), () => {
      assert.doesNotThrow(() => ib.queue('s', bad))
      assert.equal(typeof ib.list('s').at(-1).text, 'string')
    })
  }
})

test('change 事件：UI 靠它更新未读数', async (t) => {
  const ib = new Inbox()
  const seen = []
  ib.on('change', (sid) => seen.push(sid))

  const m = ib.queue('s', 'x')
  await t.test('queue 发一次', () => assert.deepEqual(seen, ['s']))

  ib.remove('s', m.id)
  await t.test('remove 也发', () => assert.equal(seen.length, 2))

  ib.queue('s', 'y')
  ib.drain('s')
  await t.test('drain 也发——否则手机上的角标不会归零', () => {
    assert.equal(seen.length, 4)
  })

  await t.test('删失败时不发（没有变化就别惊动 UI）', () => {
    const before = seen.length
    ib.remove('s', 'nosuch')
    assert.equal(seen.length, before)
  })
})
