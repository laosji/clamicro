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

  /**
   * 陈旧的未知会话**不再算数**——但那只是让它不再"拦住"，不等于"因此就退"。
   *
   * 这条断言原来写的是 `exit === true`，而那是错的：走到这一步时我们对宿主
   * 一无所知（`known === 0`），退出的依据只剩「一条老会话过期了」。真机上
   * 就是这么关掉的（见下面「零信息的时候不许关自己」那一组）。
   *
   * 原来的顾虑仍然成立——kill -9 留下的老会话不该把服务钉死到重启——
   * 但解法是**别让它成为唯一依据**，而不是在零信息的时候动手。
   */
  await t.test('超过陈旧线就不再拦住（但也不构成退出的理由）', () => {
    const r = ask([s({ owner_pid: null, updated_at: NOW - 31 * 60_000 })])
    assert.notEqual(r.why, 'unknown-owner', '过期了还在拦，那条陈旧线白设了')
    assert.equal(r.exit, false, '对宿主一无所知，只凭一条老会话过期就关自己')
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

/**
 * 这条测试原来叫「从没见过任何宿主时**也退**」，断言 `exit === true`。
 *
 * **它把 bug 写成了规范。** 2.17.0 发出去当天就在真机上撞了：服务重启后
 * 一无所知，十分钟没有 hook 到达（用户在读代码），于是自己关了，而 Claude
 * Code 一直开着。名字和断言一起改掉，别让下一个人照着它再改回去。
 *
 * 理由字符串保留：关停也好、不关也好，`why` 都得说得出来，否则用户手上
 * 只有一个消失的进程和零条线索。
 */
test('从没见过任何宿主 —— 不退，但理由要说得出来', () => {
  const r = ask([])
  assert.equal(r.exit, false, '一无所知 ≠ 没人在用')
  assert.equal(r.why, 'no-owner-known')
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

/**
 * **一无所知不等于没人在用。**
 *
 * 这一组是 2.17.0 发出去之后当场撞到的回归，日志留着：
 *
 *     14:44:03 [clamicro] 监听 http://127.0.0.1:8765     ← 服务重启
 *     14:49:03 [lifecycle] 没有后端在用了（no-owner-known），再确认一次就退出
 *     14:54:03 [lifecycle] 所有后端都退出了，服务关闭
 *
 * 而那台机器上 Claude Code 一直开着、正在干活。
 *
 * 触发路径：会话表和 owners 都不落盘，服务重启后一无所知；而 SessionStart
 * 一个会话只发一次、早就过去了。于是接下来十分钟没有 hook 到达（用户在读
 * 代码、在想事情），服务就走了。上面那道 unknown-owner 拦不住——它要求
 * **会话记录存在**，而重启后那张表是空的。
 *
 * 代价不对等：关错 = 九个 hook 全部连不上，而 hook 失败被当成非阻塞错误，
 * PermissionRequest 不再阻塞，本该上手机的操作直接跑过去。另一边只是一个
 * 闲置的 node 进程。
 */
test('零信息的时候不许关自己', async (t) => {
  const now = Date.now()

  await t.test('刚重启、什么都没收到 → 不退', () => {
    const r = shouldExit([], { owners: [], now })
    assert.equal(r.exit, false, '一无所知就把自己关了 —— 这是 2.17.0 的那个回归')
    assert.equal(r.why, 'no-owner-known')
  })

  await t.test('会话表空、owners 空，隔多久都不退', () => {
    // 「等久一点再退」不是解法：用户读一小时代码期间一条 hook 都不会来
    for (const ago of [0, 60_000, 3600_000, 86_400_000]) {
      assert.equal(shouldExit([], { owners: [], now: now + ago }).exit, false, `${ago}ms 后退了`)
    }
  })

  /**
   * 反过来这一条同样要钉住：确实**知道过**宿主、而它们现在都死了，
   * 那就该退。否则这个功能等于没有。
   */
  await t.test('知道过宿主、且都死了 → 退', () => {
    const r = shouldExit([], { owners: [{ pid: 4242 }], now, isAlive: () => false })
    assert.equal(r.exit, true, '功能被修没了')
    assert.equal(r.why, 'all-owners-gone')
  })

  await t.test('知道过、还有一个活着 → 不退', () => {
    assert.equal(shouldExit([], { owners: [{ pid: 4242 }], now, isAlive: () => true }).exit, false)
  })
})

/**
 * statusLine 也带宿主 pid —— 这是「重启后重新认识宿主」那条路。
 *
 * SessionStart 一个会话只发一次，服务重启后再也收不到。而 statusLine
 * 每回合都跑（bin/statusline.sh），所以重启之后**一个回合**服务就重新
 * 知道谁在用，不必等下一次开会话。
 *
 * 上面那条「零信息不许关自己」是兜底；这条是让它尽快不再处于零信息。
 */
test('statusLine 能把宿主重新教给服务', async (t) => {
  const { Store } = await import('../src/state.mjs')

  await t.test('noteOwner 记进 owners，且不随会话结束清空', () => {
    const st = new Store()
    assert.equal(st.owners().length, 0)
    st.noteOwner(4242)
    assert.deepEqual(st.owners().map((o) => o.pid), [4242])
    // 会话结束不影响：owners 回答的是「应用还开着吗」
    st.applyHook('session-end', { session_id: 'x' }, {})
    assert.deepEqual(st.owners().map((o) => o.pid), [4242])
  })

  await t.test('非法 pid 一律不记 —— 它要喂给 process.kill', () => {
    const st = new Store()
    for (const bad of [0, -1, null, undefined, NaN, 1.5, '123', {}]) {
      assert.equal(st.noteOwner(bad), false, `${String(bad)} 不该被记下`)
    }
    assert.equal(st.owners().length, 0)
  })

  await t.test('重启的现场：一无所知 → 收到一次 statusLine → 重新有了依据', () => {
    const st = new Store()
    // 重启后：没有会话、没有 owners
    assert.equal(shouldExit(st.sessions(), { owners: st.owners() }).why, 'no-owner-known')
    st.noteOwner(process.pid) // statusLine 带上来的
    const r = shouldExit(st.sessions(), { owners: st.owners() })
    assert.equal(r.exit, false)
    assert.equal(r.why, 'owner-alive', '收到 owner 之后判据应该变成「宿主活着」')
  })
})
