/**
 * 日志时间戳。
 *
 * 服务日志一度是 2836 行、一个时间戳都没有。排查一条错误时，能确定的只有
 * 「它出现在某次退出之前」——是哪天、离现在多久、和前一条隔多长，一概答不出。
 *
 * 这里测两件容易错的：格式稳定（补零，否则列对不齐、也不好排序），以及
 * **不能重复装**（装两次就会出现两个前缀）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stamp, stampConsole } from '../src/log.mjs'

test('格式：MM-DD HH:MM:SS，一律补零', async (t) => {
  await t.test('个位数月/日/时/分/秒都补零', () => {
    // 不补零的话列对不齐，扫日志时眼睛要一行行重新定位
    assert.equal(stamp(new Date(2026, 0, 5, 3, 7, 9)), '01-05 03:07:09')
  })
  await t.test('两位数原样', () => {
    assert.equal(stamp(new Date(2026, 11, 25, 23, 59, 59)), '12-25 23:59:59')
  })
  await t.test('长度固定 —— 前缀不定长会让对齐失效', () => {
    const a = stamp(new Date(2026, 0, 1, 0, 0, 0))
    const b = stamp(new Date(2026, 11, 31, 23, 59, 59))
    assert.equal(a.length, b.length)
  })
})

test('包装 console', async (t) => {
  const mk = () => {
    const lines = []
    const fake = { log: (...a) => lines.push(a), warn: (...a) => lines.push(a), error: (...a) => lines.push(a) }
    return { fake, lines }
  }
  const at = new Date(2026, 7, 13, 19, 45, 12)

  await t.test('每行前面加时间戳，原参数原样传下去', () => {
    const { fake, lines } = mk()
    const undo = stampConsole(fake, () => at)
    fake.log('[clamicro] 监听', 8765)
    undo()
    assert.deepEqual(lines[0], ['08-13 19:45:12', '[clamicro] 监听', 8765])
  })

  await t.test('warn 和 error 一样', () => {
    const { fake, lines } = mk()
    const undo = stampConsole(fake, () => at)
    fake.warn('w'); fake.error('e')
    undo()
    assert.equal(lines[0][0], '08-13 19:45:12')
    assert.equal(lines[1][0], '08-13 19:45:12')
  })

  await t.test('装两次不会加两个前缀', () => {
    // server.mjs 只该装一次，但幂等是这种全局补丁的基本要求
    const { fake, lines } = mk()
    const undo = stampConsole(fake, () => at)
    stampConsole(fake, () => at)
    fake.log('x')
    undo()
    assert.equal(lines[0].length, 2, `多加了前缀: ${JSON.stringify(lines[0])}`)
  })

  await t.test('还原之后不再加', () => {
    const { fake, lines } = mk()
    stampConsole(fake, () => at)()
    fake.log('x')
    assert.deepEqual(lines[0], ['x'])
  })
})

test('一次性查询不装时间戳', async () => {
  // clamicro qr 借 server.mjs 跑，输出的是二维码和状态表格，
  // 给那些行挨个加前缀会把二维码毁掉
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs'), 'utf8')
  assert.match(src, /if \(!ONE_SHOT\) stampConsole\(\)/,
    '必须由 ONE_SHOT 把关，否则二维码会被前缀打断')
})

test('日志轮转', async (t) => {
  const { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync, appendFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { rotateLog } = await import('../src/log.mjs')

  const dir = mkdtempSync(join(tmpdir(), 'ccm-log-'))
  const f = join(dir, 'x.log')
  const line = (i) => `08-14 09:00:00 [t] 第 ${i} 行\n`
  const fill = (n) => writeFileSync(f, Array.from({ length: n }, (_, i) => line(i)).join(''))

  await t.test('没到上限就不动', () => {
    fill(10)
    const before = readFileSync(f, 'utf8')
    assert.equal(rotateLog(f, { maxBytes: 1_000_000, keepBytes: 1000 }), null)
    assert.equal(readFileSync(f, 'utf8'), before)
  })

  await t.test('超过上限就截断到指定大小', () => {
    fill(5000)
    const was = statSync(f).size
    const r = rotateLog(f, { maxBytes: 10_000, keepBytes: 4_000 })
    assert.ok(r, '应当发生截断')
    assert.equal(r.was, was)
    assert.ok(statSync(f).size < was / 2, `截断后仍有 ${statSync(f).size}`)
  })

  await t.test('保留的是**末尾**，不是开头', () => {
    // 日志的价值在最近发生了什么；留开头等于把有用的部分丢了
    fill(5000)
    rotateLog(f, { maxBytes: 10_000, keepBytes: 4_000 })
    const s = readFileSync(f, 'utf8')
    assert.match(s, /第 4999 行/, '最后一行必须还在')
    assert.doesNotMatch(s, /第 1 行\n/, '开头应该已经被丢掉')
  })

  await t.test('第一行不能是半截的', () => {
    // 按字节截会切在行中间，第一行看着像日志坏了
    fill(5000)
    rotateLog(f, { maxBytes: 10_000, keepBytes: 4_000 })
    const lines = readFileSync(f, 'utf8').split('\n')
    // 第一行是我们自己写的说明，第二行起是保留下来的原文
    assert.match(lines[0], /已截断/)
    assert.match(lines[1], /^\d\d-\d\d \d\d:\d\d:\d\d \[t\] 第 \d+ 行$/,
      `保留段的第一行是半截的: ${JSON.stringify(lines[1])}`)
  })

  await t.test('留一行说明，否则看起来像日志被啃掉一块', () => {
    fill(5000)
    rotateLog(f, { maxBytes: 10_000, keepBytes: 4_000 })
    assert.match(readFileSync(f, 'utf8').split('\n')[0], /日志超过 .*KB，已截断/)
  })

  await t.test('截断之后追加仍然正常（O_APPEND 语义）', () => {
    // 服务是 shell 用 >> 起的，截断必须不影响后续写入
    fill(5000)
    rotateLog(f, { maxBytes: 10_000, keepBytes: 4_000 })
    const after = statSync(f).size
    appendFileSync(f, 'NEW LINE\n')
    assert.equal(statSync(f).size, after + 'NEW LINE\n'.length)
    assert.match(readFileSync(f, 'utf8'), /NEW LINE\n$/)
  })

  await t.test('文件不存在不抛，返回 null', () => {
    assert.equal(rotateLog(join(dir, 'nope.log')), null)
  })

  await t.test('目录不可写时也不抛 —— 轮转失败不该拖垮服务', () => {
    assert.equal(rotateLog('/dev/null/impossible.log'), null)
  })

  rmSync(dir, { recursive: true, force: true })
})
