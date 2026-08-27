/**
 * 跟读 Codex rollout：把「回合结束了」补回来。
 *
 * ## 这个文件挡的是什么
 *
 * Codex **没有回合级的结束事件**（0.149 的十个 hook 事件里没有 stop），
 * 所以 Codex 会话收到 user-prompt-submit 之后会永远停在「运行中」——
 * 跑成功了也一样。真机上抓到过这个现场：`task_complete` 在 15:35:39 就落盘了，
 * 而看板到 15:38 还在转圈。
 *
 * 这类回归**不会让任何别的测试变红**：服务照常跑、hook 照常收、请求照常
 * 200。唯一的症状是界面上那个状态永远不变。所以它必须有自己的测试。
 *
 * 用真实文件而不是伪造 fs：跟读器全部的难点就在文件这一侧——半行、追加、
 * 截断、文件还没出现。把 fs 换成 mock 等于把要测的东西测掉了。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, truncateSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store, STATE } from '../src/state.mjs'
import { createCodexTail, findRollout, parseLine, readWindows } from '../src/codex-tail.mjs'

const NOTIFY = { onStop: true, onError: true, minTurnMs: 30_000 }
const CFG = { notify: NOTIFY }
const SID = '01a037d7-6d53-7a13-afea-33cd87987f30'

/**
 * 真机上抓到的那几行的形状。
 *
 * **外层的 `timestamp` 不是装饰**：跟读器首拍要靠它筛掉旧事件（见
 * codex-tail.mjs 的「从哪里开始读」）。造假数据时漏掉它，测的就是一个
 * 现实中不存在的形状——这里为此挂过一次。
 */
const at = (o = 0) => new Date(Date.now() + o).toISOString()
const started = (turn = 't1', ts = at()) =>
  JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'task_started', turn_id: turn } })
const done = (msg = '好了', ts = at()) =>
  JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', last_agent_message: msg, error: null } })
const usage = (total = 20263, ts = at()) =>
  JSON.stringify({ timestamp: ts, type: 'event_msg', payload: {
    type: 'token_count',
    info: { total_token_usage: { input_tokens: 20056, output_tokens: 207, total_tokens: total } },
    rate_limits: { primary: { used_percent: 0, window_minutes: 43200, resets_at: 1789190870 } },
  } })
/** 额度耗尽时的真实形状：info 整个是 null，rate_limits 里也全是 null */
const usageEmpty = (ts = at()) =>
  JSON.stringify({ timestamp: ts, type: 'event_msg', payload: {
    type: 'token_count', info: null,
    rate_limits: { limit_id: 'premium', primary: null, secondary: null },
  } })
const failed = (m = "You've hit your usage limit.", ts = at()) =>
  JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', last_agent_message: null, error: { message: m } } })

/** 造一个假的 CODEX_HOME 布局：<home>/.codex/sessions/2026/08/25/rollout-…-<id>.jsonl */
function fakeHome(sessionId = SID, lines = []) {
  const home = mkdtempSync(join(tmpdir(), 'clamicro-tail-'))
  const dir = join(home, '.codex', 'sessions', '2026', '08', '25')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `rollout-2026-08-25T15-34-20-${sessionId}.jsonl`)
  writeFileSync(file, lines.map((l) => `${l}\n`).join(''))
  return { home, file }
}

/** 手动推一拍并等它读完。跟读器内部是 setInterval，测试里不等实时。 */
/**
 * 等跟读器至少走一拍。
 *
 * **这个定时器绝不能 unref。** 原来写的是
 *
 *     new Promise((r) => setTimeout(r, 40).unref?.() ?? setTimeout(r, 40))
 *
 * 两个毛病叠在一起：
 *
 *   1. `Timeout.unref()` 返回的是 **Timeout 本身**（真值），所以 `??` 右边
 *      那个兜底的 setTimeout **永远不执行**——它看着像「不支持 unref 就退回
 *      普通定时器」，实际上一次都没退过。
 *   2. 于是只剩一个 unref 的定时器，而 unref 的定时器**不保活事件循环**。
 *      循环一空，就再也没有人来 resolve 这个 promise。
 *
 * 表现是 node 的测试运行器报
 * `Promise resolution is still pending but the event loop has already resolved`，
 * 而且**只在某些 node 版本上**——CI 里 18/20/22 全红、24 绿，本地 25 也绿。
 * 不是 flaky，是这个写法本来就不成立，只是在某些版本上恰好有别的句柄替它
 * 撑着循环。用 `node -e` 单独跑那一行能直接看到退出码 13。
 *
 * codex-tail.mjs 自己的轮询定时器 unref 是**对的**——跟读是补充信息，
 * 不该把服务钉在事件循环上不让它退。但那条理由在测试里正好反过来：
 * 这里要的就是「把循环撑到那一拍跑完」。同一个手法，两个相反的场景。
 */
const tick = () => new Promise((r) => setTimeout(r, 40))

test('parseLine 只认回合事件，别的一律当没看见', async (t) => {
  await t.test('task_started', () => {
    const ts = '2026-08-25T08:06:53.502Z'
    assert.deepEqual(parseLine(started('abc', ts)), { kind: 'start', at: Date.parse(ts), turnId: 'abc' })
  })

  await t.test('时间戳缺失或坏掉 —— at 是 null，不是 NaN', () => {
    // 首拍靠 at 筛事件，NaN 会让每个比较都悄悄变成 false，很难查
    const noTs = JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })
    assert.equal(parseLine(noTs).at, null)
  })

  await t.test('task_complete 正常结束', () => {
    const e = parseLine(done('搞定'))
    assert.equal(e.kind, 'end')
    assert.equal(e.error, null)
    assert.equal(e.message, '搞定')
  })

  await t.test('task_complete 带 error —— 取 message，不是整个对象', () => {
    // 整个对象塞进时间线的话，用户看到的是一坨 JSON 而不是那句人话
    const e = parseLine(failed('额度用完了'))
    assert.equal(e.error, '额度用完了')
  })

  await t.test('token_count 带数字 —— 认成用量，窗口一并带出来', () => {
    assert.deepEqual(parseLine(usage(20263, '2026-08-25T08:06:53.502Z')), {
      kind: 'usage',
      at: Date.parse('2026-08-25T08:06:53.502Z'),
      tokens: 20263,
      windows: [{ key: 'primary', label: '30d', pct: 0, resets_at: 1789190870 }],
    })
  })

  await t.test('window_minutes 43200 翻成 30d，不硬套 Claude 的 5h/7d', () => {
    // 借别人的窗口名字等于在界面上说一句不成立的话
    assert.equal(readWindows({ primary: { used_percent: 1, window_minutes: 43200 } })[0].label, '30d')
    assert.equal(readWindows({ primary: { used_percent: 1, window_minutes: 300 } })[0].label, '5h')
    assert.equal(readWindows({ primary: { used_percent: 1, window_minutes: 10080 } })[0].label, '7d')
  })

  await t.test('used_percent 是 null —— 整条丢掉，不写成 0%', () => {
    // Number(null) 是 0 且 isFinite 通过，「不知道」会被悄悄写成「0%」，
    // 而这两者在界面上长得一样、含义相反。为此挂过一次
    assert.deepEqual(readWindows({ primary: { used_percent: null, window_minutes: 43200 } }), [])
    // 但真正的 0% 要留着
    assert.equal(readWindows({ primary: { used_percent: 0, window_minutes: 43200 } }).length, 1)
  })

  await t.test('token_count 但 info 是 null —— 当没发生', () => {
    // 额度耗尽时的真实形状。报一个 0 比不报更糟：界面会显示「累计 0 tok」，
    // 而事实是「这一轮没报」
    assert.equal(parseLine(usageEmpty()), null)
  })

  await t.test('rollout 里的其它行不是异常，返回 null', () => {
    for (const l of [
      JSON.stringify({ type: 'response_item', payload: { foo: 1 } }),
      JSON.stringify({ type: 'session_meta', payload: {} }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } }),
    ]) {
      assert.equal(parseLine(l), null, `不该认领：${l}`)
    }
  })

  await t.test('半行 / 垃圾行只跳过自己，不抛', () => {
    // rollout 是 Codex 的内部格式，没有版本承诺。解析失败必须是「跳过这一行」，
    // 不能是「跟读器挂掉」——挂掉的表现又回到「状态永远不更新」
    assert.doesNotThrow(() => parseLine('{"type":"event_ms'))
    assert.equal(parseLine('{"type":"event_ms'), null)
    assert.equal(parseLine(''), null)
  })
})

test('findRollout 按 session_id 找到那份文件', async (t) => {
  const { home, file } = fakeHome()
  t.after(() => rmSync(home, { recursive: true, force: true }))

  await t.test('找得到', () => {
    assert.equal(findRollout(SID, { home }), file)
  })

  await t.test('别的 id 找不到，且不抛', () => {
    assert.equal(findRollout('不存在的会话', { home }), null)
  })

  await t.test('目录整个不在也只是找不到', () => {
    assert.equal(findRollout(SID, { home: join(home, '没有这个目录') }), null)
  })
})

test('回合跑完 → 会话走出「运行中」', async (t) => {
  const { home, file } = fakeHome()
  const store = new Store()
  const tail = createCodexTail({ store, notify: null, config: CFG, home, tickMs: 10 })
  t.after(() => { tail.stop(); rmSync(home, { recursive: true, force: true }) })

  // 现场复原：hook 收到 prompt 把会话推进 Running，然后 Codex 什么都不再发
  store.applyHook('user-prompt-submit', { session_id: SID, agent: 'codex', prompt: '看看有什么 bug' }, NOTIFY)
  assert.equal(store.session(SID).state, STATE.RUNNING)

  tail.follow(SID)
  await tick()

  await t.test('task_complete 到了就该是 Done', async () => {
    appendFileSync(file, `${done('跑完了')}\n`)
    await tick()
    const s = store.session(SID)
    assert.equal(s.state, STATE.DONE, '这一条不过 = 手机上那张卡片会一直转')
    assert.equal(s.turn_started_at, null)
  })

  await t.test('最后一句话也带过来了', () => {
    assert.equal(store.session(SID).last_message, '跑完了')
  })
})

test('回合失败 → Error，不是 Done', async (t) => {
  const { home, file } = fakeHome()
  const store = new Store()
  const tail = createCodexTail({ store, notify: null, config: CFG, home, tickMs: 10 })
  t.after(() => { tail.stop(); rmSync(home, { recursive: true, force: true }) })

  tail.follow(SID)
  await tick()
  appendFileSync(file, `${started()}\n`)
  await tick()

  await t.test('task_started 把它推进 Running', () => {
    assert.equal(store.session(SID).state, STATE.RUNNING)
  })

  await t.test('带 error 的 task_complete 是 Error', async () => {
    // 额度耗尽那个回合**什么都没干成**，报「已完成」等于撒谎
    appendFileSync(file, `${failed()}\n`)
    await tick()
    assert.equal(store.session(SID).state, STATE.ERROR)
  })

  await t.test('报错原文进了 last_message —— 首页卡片渲染的就是它', () => {
    // 为空的话 ui/home.html 会回落到一句通用的「会话异常终止」，
    // 而我们手里有那句真话。连续几轮失败会看起来像状态卡住了没动
    assert.match(store.session(SID).last_message, /usage limit/)
  })

  await t.test('报错原文进了时间线', () => {
    const ev = store.events().filter((e) => e.session_id === SID)
    const last = ev[ev.length - 1]
    assert.equal(last.type, 'turn-error')
    assert.match(last.detail, /usage limit/)
  })
})

test('文件那一侧的糙活', async (t) => {
  await t.test('跟读时文件还没落盘 —— 出现之后照样接上', async () => {
    const home = mkdtempSync(join(tmpdir(), 'clamicro-tail-'))
    const store = new Store()
    const tail = createCodexTail({ store, notify: null, config: CFG, home, tickMs: 10 })
    t.after(() => { tail.stop(); rmSync(home, { recursive: true, force: true }) })

    tail.follow(SID)          // 此刻 ~/.codex/sessions 整个都不存在
    await tick()
    assert.deepEqual(tail.following(), [SID], '找不到文件不该把会话丢掉')

    const dir = join(home, '.codex', 'sessions', '2026', '08', '25')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `rollout-x-${SID}.jsonl`)
    writeFileSync(file, '')
    await tick()
    appendFileSync(file, `${done('迟到但接上了')}\n`)
    await tick()
    assert.equal(store.session(SID).state, STATE.DONE)
  })

  await t.test('半行写入不会被当成垃圾丢掉', async () => {
    const { home, file } = fakeHome()
    const store = new Store()
    const tail = createCodexTail({ store, notify: null, config: CFG, home, tickMs: 10 })
    t.after(() => { tail.stop(); rmSync(home, { recursive: true, force: true }) })

    tail.follow(SID)
    await tick()
    // 追加日志不是原子的：一拍正好读到半行是常态，不是异常
    const line = done('半行拼回来了')
    appendFileSync(file, line.slice(0, 20))
    await tick()
    assert.equal(store.session(SID).state, STATE.IDLE, '半行不该产生任何状态变化')
    appendFileSync(file, `${line.slice(20)}\n`)
    await tick()
    assert.equal(store.session(SID).state, STATE.DONE, '后半行到了就该拼起来生效')
  })

  await t.test('文件被截断 —— 从头读，不拿旧 offset 去读新内容', async () => {
    const { home, file } = fakeHome(SID, [started(), done('第一轮')])
    const store = new Store()
    const tail = createCodexTail({ store, notify: null, config: CFG, home, tickMs: 10 })
    t.after(() => { tail.stop(); rmSync(home, { recursive: true, force: true }) })

    tail.follow(SID)
    await tick()
    truncateSync(file, 0)
    appendFileSync(file, `${failed('截断之后的新内容')}\n`)
    await tick()
    assert.equal(store.session(SID).state, STATE.ERROR)
  })

  await t.test('unfollow 之后不再理会新事件', async () => {
    const { home, file } = fakeHome()
    const store = new Store()
    const tail = createCodexTail({ store, notify: null, config: CFG, home, tickMs: 10 })
    t.after(() => { tail.stop(); rmSync(home, { recursive: true, force: true }) })

    tail.follow(SID)
    await tick()
    tail.unfollow(SID)
    appendFileSync(file, `${done()}\n`)
    await tick()
    assert.equal(store.session(SID).state, STATE.IDLE)
    assert.deepEqual(tail.following(), [])
  })
})

test('首拍不回放历史 —— 旧回合不该被当成刚发生', async (t) => {
  /**
   * 跟读一个**已经跑过几轮**的会话（真实情况：服务重启、或者用户中途
   * 才装上 clamicro）。首拍会往回退一段去接住那一秒的竞态，但退到的
   * 那些旧事件必须被时间戳挡掉——否则一挂上就凭空报一次「已完成」。
   */
  const old = new Date(Date.now() - 3600_000).toISOString()
  const { home, file } = fakeHome(SID, [started('t0', old), done('一小时前那轮', old)])
  const store = new Store()
  const tail = createCodexTail({ store, notify: null, config: CFG, home, tickMs: 10 })
  t.after(() => { tail.stop(); rmSync(home, { recursive: true, force: true }) })

  tail.follow(SID)
  await tick()

  await t.test('旧的 task_complete 被忽略', () => {
    assert.equal(store.session(SID).state, STATE.IDLE, '不该凭空报一次「已完成」')
  })

  await t.test('新追加的照常生效', async () => {
    appendFileSync(file, `${done('这一轮')}\n`)
    await tick()
    assert.equal(store.session(SID).state, STATE.DONE)
    assert.equal(store.session(SID).last_message, '这一轮')
  })
})

test('用量：Codex 的累计 token 走 rollout', async (t) => {
  const { home, file } = fakeHome()
  const store = new Store()
  const tail = createCodexTail({ store, notify: null, config: CFG, home, tickMs: 10 })
  t.after(() => { tail.stop(); rmSync(home, { recursive: true, force: true }) })

  tail.follow(SID)
  await tick()

  await t.test('拿到数字之前，usage_reported 保持 null', () => {
    // null = 「还没跑完一轮」。置 false 会让界面说「该后端不上报用量」，
    // 那是另一回事，而且现在已经是假话
    assert.equal(store.session(SID).usage_reported, null)
    assert.equal(store.session(SID).tokens, null)
  })

  await t.test('token_count 到了 —— 累计 token 写进会话', async () => {
    appendFileSync(file, `${usage(20263)}\n`)
    await tick()
    assert.equal(store.session(SID).tokens, 20263)
    assert.equal(store.session(SID).usage_reported, true)
  })

  await t.test('窗口配额记在后端上，不记在会话上', () => {
    // 它是**账户级**的属性，不属于某一个会话（同 accountLimits 的道理）
    assert.deepEqual(store.agentLimits().codex.windows,
      [{ key: 'primary', label: '30d', pct: 0, resets_at: 1789190870 }])
  })

  await t.test('info 为 null 的那条不该把数字抹掉', async () => {
    // 额度耗尽之后每一轮都会报这种空的。覆盖成 0 等于把已知的用量弄丢
    appendFileSync(file, `${usageEmpty()}\n`)
    await tick()
    assert.equal(store.session(SID).tokens, 20263)
  })

  await t.test('回合结束不会覆盖用量', async () => {
    // turn-end 走的是现成的 stop 那条路，而它的 payload 里没有 tokens——
    // 那两处扩散是有条件的，条件不成立时必须**保持原值**而不是写 0
    appendFileSync(file, `${done('跑完了')}\n`)
    await tick()
    assert.equal(store.session(SID).tokens, 20263)
    assert.equal(store.session(SID).state, STATE.DONE)
  })
})

test('follow 是幂等的', () => {
  const { home } = fakeHome()
  const tail = createCodexTail({ store: new Store(), notify: null, config: CFG, home, tickMs: 10 })
  tail.follow(SID)
  tail.follow(SID)
  assert.deepEqual(tail.following(), [SID])
  tail.follow('')      // 空 id 不该建出幽灵条目
  assert.deepEqual(tail.following(), [SID])
  tail.stop()
  rmSync(home, { recursive: true, force: true })
})
