/**
 * 提醒通道的健康记录。
 *
 * ## 为什么需要
 *
 * 所有 notify 调用点都是 `.catch(() => {})`——**这是对的**，提醒失败绝不能拖垮
 * hook 链路，工具调用还等着那个请求返回。但代价是通道整个死掉时，这件事没有
 * 任何地方记着，于是：
 *
 *   · 高危审批全部走到 180 秒超时被拒 → 表现成「Claude 老是被拒绝」
 *   · 普通审批照常 10 秒自动放行 → 那 10 秒本来是留给你的机会
 *
 * 两种都不会报错，只会让人以为「它在守着」。
 *
 * ## 为什么只记事实、不给「通道是否正常」这种布尔值
 *
 * 刘海那条路的教训摆在那里：孤儿进程里窗口建得出来、退出码 0、屏幕上什么都
 * 没有。**没抛异常不等于送达了。** 所以这里只记录能确凿知道的——哪次抛了、
 * 抛了什么、连续几次。
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { makeNotifier, notifyHealth, resetNotifyHealth } from '../src/notify.mjs'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os' 

const cfg = (style = 'banner') => ({ notify: { macNotify: true, style, respectFocus: false } })
const ok = () => {}
const boom = (msg = 'terminal-notifier ENOENT') => () => { throw new Error(msg) }

beforeEach(() => resetNotifyHealth())

test('成功与失败各自记账', async (t) => {
  await t.test('发出去 → ok+1，连续失败清零', async () => {
    const notify = makeNotifier(cfg(), { banner: ok, notch: ok, focus: () => false })
    await notify({ title: 'x' })
    const h = notifyHealth()
    assert.equal(h.ok, 1)
    assert.equal(h.failed, 0)
    assert.equal(h.consecutiveFails, 0)
    assert.ok(h.lastOkAt > 0)
  })

  await t.test('抛了 → failed+1，并记下原因', async () => {
    const notify = makeNotifier(cfg(), { banner: boom(), notch: ok, focus: () => false })
    await notify({ title: 'x' })
    const h = notifyHealth()
    assert.equal(h.failed, 1)
    assert.equal(h.consecutiveFails, 1)
    assert.match(h.lastError, /ENOENT/, '错误文本要留下来，否则 status 里只能说「失败了」')
    assert.ok(h.lastErrorAt > 0)
  })
})

test('consecutiveFails 是「连续」，不是「累计」', async () => {
  /**
   * 我第一版拿 `if (!health.consecutiveFails) recordOk()` 判这一次成不成功。
   * 那是错的：consecutiveFails 跨调用累积，只要以前失败过一次它就永远大于 0，
   * 之后每一次成功都会被判成失败——**通道再也「恢复」不了**，status 会一直
   * 红着，而红着的告警等于没有告警。
   *
   * 这几步必须在**同一个 test 里**连着跑：文件级的 beforeEach 在每个子测试前
   * 都会重置，拆成子测试的话第二步看到的是一张白纸，恰好把要测的东西测没了。
   * 我第一版就是这么写的，于是它「通过」了——而它什么都没验证。
   */
  const bad = makeNotifier(cfg(), { banner: boom(), notch: ok, focus: () => false })
  await bad({ title: 'x' })
  await bad({ title: 'x' })
  assert.equal(notifyHealth().consecutiveFails, 2)

  const good = makeNotifier(cfg(), { banner: ok, notch: ok, focus: () => false })
  await good({ title: 'x' })

  const h = notifyHealth()
  assert.equal(h.consecutiveFails, 0, '成功一次就该清零')
  assert.equal(h.failed, 2, '累计数不清零 —— 偶发一次和通道长期坏是两回事')
  assert.equal(h.ok, 1)
})

test('两个通道都挂了要记两次以上', async () => {
  // style=both 时刘海和横幅各发各的。两边都挂 = 这一条哪儿都没出去
  const notify = makeNotifier(cfg('both'), {
    notch: boom('画不出窗口'), banner: boom('横幅也挂了'), focus: () => false,
  })
  await notify({ title: 'x' })
  assert.ok(notifyHealth().failed >= 2, '每个通道各记一次，否则看不出是全挂还是挂了一半')
  assert.equal(notifyHealth().ok, 0, '有通道失败就不该记成功')
})

test('关掉 macNotify 时不记账', async () => {
  // 没开提醒不等于提醒坏了。混为一谈会让 status 对着一个关掉的功能报警
  const notify = makeNotifier({ notify: { macNotify: false } }, { banner: boom(), notch: boom() })
  await notify({ title: 'x' })
  assert.deepEqual(notifyHealth(), { ok: 0, failed: 0, consecutiveFails: 0, lastError: null, lastErrorAt: null, lastOkAt: null })
})

test('快照是副本，改不坏内部状态', () => {
  const h = notifyHealth()
  h.consecutiveFails = 999
  assert.equal(notifyHealth().consecutiveFails, 0)
})

test('错误文本会截断', async () => {
  // 它要走 JSON 出去、再进终端。一段几 KB 的堆栈会把 status 淹掉
  const notify = makeNotifier(cfg(), { banner: boom('x'.repeat(5000)), notch: ok, focus: () => false })
  await notify({ title: 'x' })
  assert.ok(notifyHealth().lastError.length <= 200)
})


/**
 * **真实的横幅通道**，不是注入的桩。
 *
 * 上面每一条都用 `banner: boom()` 测「抛了会不会记账」，而真正的
 * notifyBanner 原来**从来不抛**：`p.on('close', resolve)` 不看退出码，
 * osascript 语法错误、二进制不在、被安全策略拦下，全都算「发出去了」。
 * 于是这整个文件测的健康记录，对生产里那条横幅通道一次都没生效过。
 *
 * 而这不是假想：转义顺序那个 bug（先转义后截断，留下悬空反斜杠）实测扫
 * 120 种对齐有 48 次让 osascript 真的编译失败——日志里一行没有，
 * failed 一直是 0。**没抛异常不等于送达了**，这条对横幅同样成立。
 *
 * 用 PATH 换掉 osascript：spawn 在调用那一刻按 process.env.PATH 找二进制，
 * 所以同进程改一下就够，不必起子进程。
 */
test('横幅：osascript 非 0 退出要记成失败，不能算送达', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'clamicro-osa-'))
  const realPath = process.env.PATH
  const stub = (body) => {
    writeFileSync(join(dir, 'osascript'), body)
    chmodSync(join(dir, 'osascript'), 0o755)
    process.env.PATH = `${dir}:${realPath}`
  }
  t.after(() => {
    process.env.PATH = realPath
    rmSync(dir, { recursive: true, force: true })
  })

  await t.test('语法错误 → failed+1，且 stderr 进 lastError', async () => {
    resetNotifyHealth()
    stub('#!/bin/sh\necho "0:0: syntax error: A identifier can not go after this (-2740)" >&2\nexit 1\n')
    // 不注入 banner：要走真的那条
    await makeNotifier(cfg(), { notch: ok, focus: () => false })({ title: 'x', body: 'rm -rf /' })
    const h = notifyHealth()
    assert.equal(h.failed, 1, '非 0 退出被当成了成功')
    assert.equal(h.ok, 0)
    assert.match(h.lastError, /syntax error/, `理由要说人话，实际: ${h.lastError}`)
  })

  await t.test('退出码 0 → 仍然算 ok', async () => {
    resetNotifyHealth()
    stub('#!/bin/sh\nexit 0\n')
    await makeNotifier(cfg(), { notch: ok, focus: () => false })({ title: 'x', body: 'ls' })
    assert.equal(notifyHealth().failed, 0)
    assert.equal(notifyHealth().ok, 1)
  })
})
