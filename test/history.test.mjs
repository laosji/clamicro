/**
 * 审批与事件的落盘。
 *
 * 重点在两条**平时不执行**的路径：
 *   · 坏文件恢复 —— JSON 损坏时挪走留证据、从空开始，而不是让服务起不来
 *   · 原子替换   —— 写一半被杀不能留下半个 JSON
 *
 * 这类代码不出事就永远不跑，真出事时才发现它自己也是坏的。
 *
 * 必须在导入之前改 HOME：HISTORY_FILE 在模块加载时就由 CONFIG_DIR 算好了。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const HOME = mkdtempSync(join(tmpdir(), 'clamicro-hist-'))
process.env.HOME = HOME
mkdirSync(join(HOME, '.claude', 'clamicro'), { recursive: true })

const { History, HISTORY_FILE } = await import('../src/history.mjs')

const silence = () => {
  const log = console.log
  const err = console.error
  console.log = () => {}
  console.error = () => {}
  return () => { console.log = log; console.error = err }
}
const clean = () => {
  for (const f of [HISTORY_FILE, `${HISTORY_FILE}.broken`, `${HISTORY_FILE}.tmp`]) {
    if (existsSync(f)) rmSync(f)
  }
}

test.after(() => rmSync(HOME, { recursive: true, force: true }))

test('没有文件时返回空结构，不抛异常', () => {
  clean()
  const h = new History()
  assert.deepEqual(h.load(), { approvals: [], events: [], nextEventId: 1, limits: null })
})

test('写入 → 读回', () => {
  clean()
  const h = new History()
  h.bind(() => ({
    approvals: [{ id: 'a', status: 'allowed' }],
    events: [{ id: 1, type: 'stop' }],
    nextEventId: 2,
    limits: { five_hour: { pct: 10 } },
  }))
  h.flush()
  const back = new History().load()
  assert.equal(back.approvals[0].id, 'a')
  assert.equal(back.nextEventId, 2)
  assert.equal(back.limits.five_hour.pct, 10)
})

test('坏文件不该让服务起不来', async (t) => {
  clean()
  writeFileSync(HISTORY_FILE, '{ 这不是 JSON')
  const un = silence()
  const loaded = new History().load()
  un()

  await t.test('返回空结构继续跑', () => {
    assert.deepEqual(loaded, { approvals: [], events: [], nextEventId: 1, limits: null })
  })
  await t.test('坏文件被挪走留证据，而不是直接覆盖', () => {
    assert.ok(existsSync(`${HISTORY_FILE}.broken`), '要能事后翻出来看到底坏成什么样')
    assert.equal(readFileSync(`${HISTORY_FILE}.broken`, 'utf8'), '{ 这不是 JSON')
  })
})

test('字段类型不对时逐个兜底，而不是整个丢弃', () => {
  clean()
  writeFileSync(HISTORY_FILE, JSON.stringify({ approvals: 'oops', events: null, nextEventId: 'x' }))
  const un = silence()
  const l = new History().load()
  un()
  assert.deepEqual(l.approvals, [], '不是数组就当空')
  assert.deepEqual(l.events, [])
  assert.equal(l.nextEventId, 1, '不是数字就退回 1')
})

test('文件权限 600 —— 里面有命令原文', () => {
  clean()
  const h = new History()
  h.bind(() => ({ approvals: [], events: [], nextEventId: 1 }))
  h.flush()
  const mode = statSync(HISTORY_FILE).mode & 0o777
  assert.equal(mode, 0o600, `实际 ${mode.toString(8)}`)
})

test('上限：只保留尾部，防止无限增长', async (t) => {
  clean()
  const h = new History()
  h.bind(() => ({
    approvals: Array.from({ length: 500 }, (_, i) => ({ id: `a${i}` })),
    events: Array.from({ length: 5000 }, (_, i) => ({ id: i })),
    nextEventId: 5000,
  }))
  h.flush()
  const back = new History().load()

  await t.test('审批截到 300 条', () => assert.equal(back.approvals.length, 300))
  await t.test('事件截到 3000 条', () => assert.equal(back.events.length, 3000))
  await t.test('留的是最新的那批，不是最旧的', () => {
    assert.equal(back.approvals.at(-1).id, 'a499')
    assert.equal(back.events.at(-1).id, 4999)
  })
})

test('原子替换：不留半个 JSON', () => {
  clean()
  const h = new History()
  h.bind(() => ({ approvals: [{ id: 'a' }], events: [], nextEventId: 1 }))
  h.flush()
  // 写完之后临时文件不该留在盘上——它是 rename 的源，rename 成功即消失
  assert.ok(!existsSync(`${HISTORY_FILE}.tmp`), '临时文件应已被 rename 掉')
  assert.doesNotThrow(() => JSON.parse(readFileSync(HISTORY_FILE, 'utf8')), '落盘的必须是完整 JSON')
})

test('touch 是防抖的，不是每次都写盘', async (t) => {
  clean()
  let snapshots = 0
  const h = new History()
  h.bind(() => {
    snapshots++
    return { approvals: [], events: [], nextEventId: 1 }
  })

  for (let i = 0; i < 50; i++) h.touch()
  await t.test('连续 50 次 touch 还没落盘', () => {
    assert.equal(snapshots, 0, '防抖窗口内不该取快照')
  })

  await t.test('防抖窗口过后写一次', async () => {
    await new Promise((r) => setTimeout(r, 1000))
    assert.equal(snapshots, 1, '50 次 touch 只该写 1 次')
  })
})

test('flushNow：退出前同步落盘，不丢防抖窗口里的变更', () => {
  clean()
  let snapshots = 0
  const h = new History()
  h.bind(() => {
    snapshots++
    return { approvals: [{ id: 'last' }], events: [], nextEventId: 1 }
  })
  h.touch()
  h.flushNow()
  assert.equal(snapshots, 1)
  assert.equal(new History().load().approvals[0].id, 'last', '退出前那次变更必须落盘')
})

test('落盘失败不该把进程带走', () => {
  clean()
  const h = new History()
  h.bind(() => {
    throw new Error('快照函数炸了')
  })
  const un = silence()
  assert.doesNotThrow(() => h.flush(), '持久化是附加能力，坏了也不能影响主流程')
  un()
})
