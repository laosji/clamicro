/**
 * 「所有后端都退出了，服务也该走了」的判据。
 *
 * ## 这个文件真正在防的东西
 *
 * 关错的代价和多跑一会儿的代价**完全不对等**：服务提前关掉之后，hook 全部
 * 失败、审批静默失效，而用户不会把两件事联系起来；多跑一会儿的代价只是一个
 * 闲置的 node 进程。所以下面每一条断言都是在钉「**不确定就别关**」这个方向。
 *
 * 判据本身不能用「会话数为零」——kill -9 / 关终端 / 崩溃都不发 session-end，
 * 那样的会话永远赖在表里，服务于是永远不退（方向正好反了）。也不能按名字
 * 搜进程——service-id.mjs 早有结论。用的是 session-start 时宿主自报的 PID。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldExit, alive } from '../src/lifecycle.mjs'

const NOW = 1_700_000_000_000
const s = (over = {}) => ({ owner_pid: null, updated_at: NOW, ...over })
/** 只有列在 living 里的 pid 算活着 */
const aliveOnly = (...living) => (pid) => living.includes(pid)

/**
 * 默认把会话自带的宿主也放进 owners —— 真实运行时就是这个关系：
 * store 在 session-start 时同时写会话的 owner_pid 和那张 #owners 表。
 * 想单独测两者不一致的情况，显式传 owners 覆盖。
 */
const ask = (sessions, opts = {}) => shouldExit(sessions, {
  now: NOW,
  isAlive: () => false,
  owners: sessions.filter((x) => x.owner_pid).map((x) => ({ pid: x.owner_pid, at: NOW })),
  ...opts,
})

test('宿主还活着就不退', () => {
  const r = ask([s({ owner_pid: 4242 })], { isAlive: aliveOnly(4242) })
  assert.equal(r.exit, false)
  assert.equal(r.why, 'owner-alive')
})

test('宿主全没了才退', async (t) => {
  await t.test('两个会话，一个宿主还在 —— 不退', () => {
    const r = ask([s({ owner_pid: 1 }), s({ owner_pid: 2 })], { isAlive: aliveOnly(2) })
    assert.equal(r.exit, false)
  })

  await t.test('两个宿主都没了 —— 退', () => {
    const r = ask([s({ owner_pid: 1 }), s({ owner_pid: 2 })])
    assert.equal(r.exit, true)
    assert.equal(r.why, 'all-owners-gone')
  })

  await t.test('多个会话共用一个宿主（Codex / DSH 的形状）', () => {
    // Codex 的 app-server、DSH 的主进程都是所有会话共用的常驻进程，
    // 所以同一个 pid 会出现在多条会话上。活着就是全都不退
    const r = ask([s({ owner_pid: 7 }), s({ owner_pid: 7 })], { isAlive: aliveOnly(7) })
    assert.equal(r.exit, false)
  })
})

test('有待审批时一条都不能退', () => {
  /**
   * 服务一走，手机上那张卡片永远挂着；而 Codex 那边拿不到回包会当作
   * 「本 hook 无意见」放行 —— 一次本该被拦下的操作就这么过去了。
   * 这是这个产品最不能出的错，所以它排在所有判据前面。
   */
  const r = ask([s({ owner_pid: 1 })], { pendingApprovals: 1 })
  assert.equal(r.exit, false)
  assert.equal(r.why, 'pending-approvals')
})

test('前台启动的不退', () => {
  // `clamicro start` 是 stdio:'inherit' 的前台进程，人正盯着那个终端窗口，
  // 而窗口里的进程自己消失是最莫名其妙的一种行为
  const r = ask([], { foreground: true })
  assert.equal(r.exit, false)
  assert.equal(r.why, 'foreground')
})

test('不知道宿主是谁的会话 —— 新鲜的拦住，陈旧的不再算数', async (t) => {
  await t.test('刚上报过就拦住', () => {
    // 升级期的老会话没有 owner_pid。不知道就别关
    const r = ask([s({ owner_pid: null, updated_at: NOW - 60_000 })])
    assert.equal(r.exit, false)
    assert.equal(r.why, 'unknown-owner')
  })

  await t.test('超过陈旧线就不再钉住服务', () => {
    // 否则一个 kill -9 留下的老会话（没有 session-end、也没有宿主信息）
    // 会把服务钉死到下次重启
    const r = ask([s({ owner_pid: null, updated_at: NOW - 31 * 60_000 })])
    assert.equal(r.exit, true)
  })

  await t.test('陈旧的未知会话 + 活着的宿主 —— 仍然不退', () => {
    const r = ask(
      [s({ owner_pid: null, updated_at: NOW - 31 * 60_000 }), s({ owner_pid: 9 })],
      { isAlive: aliveOnly(9) },
    )
    assert.equal(r.exit, false)
  })
})

test('应用开着、但当前一个会话都没有 —— 不退', async (t) => {
  /**
   * 这是「所有应用退出后关服务」的字面意思，也是 owners 这张表存在的理由。
   *
   * 会话正常结束（session-end）之后会话就从表里消失了，只看会话的话服务会在
   * 十分钟后退出——而那时 Claude Code 还开着，用户下次开会话又得等它重新
   * 拉起。#owners 不随会话结束而清空，所以这里判得出「应用还在」。
   */
  await t.test('宿主还活着 —— 不退', () => {
    const r = ask([], { owners: [{ pid: 555, at: NOW }], isAlive: aliveOnly(555) })
    assert.equal(r.exit, false)
    assert.equal(r.why, 'owner-alive')
  })

  await t.test('宿主也没了 —— 退', () => {
    const r = ask([], { owners: [{ pid: 555, at: NOW }] })
    assert.equal(r.exit, true)
    assert.equal(r.why, 'all-owners-gone')
  })
})

test('从没见过任何宿主时也退，理由要说得出来', () => {
  const r = ask([])
  assert.equal(r.exit, true)
  assert.equal(r.why, 'no-owner-known', '关停必须留下理由，否则用户手上只有一个消失的进程')
})

test('alive() 的边界', async (t) => {
  await t.test('自己一定活着', () => {
    assert.equal(alive(process.pid), true)
  })

  await t.test('非法 pid 一律当死的，不抛', () => {
    // 这条会喂给 process.kill，而它在的位置是每一次巡检的必经之路
    for (const bad of [0, -1, null, undefined, NaN, 1.5, '123']) {
      assert.equal(alive(bad), false, `${String(bad)} 应该判死且不抛`)
    }
  })

  await t.test('EPERM 算活着 —— 进程在，只是不属于我们', () => {
    const kill = () => { const e = new Error('operation not permitted'); e.code = 'EPERM'; throw e }
    assert.equal(alive(4242, kill), true)
  })

  await t.test('ESRCH 算死了', () => {
    const kill = () => { const e = new Error('no such process'); e.code = 'ESRCH'; throw e }
    assert.equal(alive(4242, kill), false)
  })
})
