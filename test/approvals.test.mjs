/**
 * 审批状态机与对账。
 *
 * matchKey 那组对应一个真实 bug：第一版用 tool_use_id 对账，
 * 而 PermissionRequest 的 payload 里根本没有这个字段，于是 supersede()
 * 是段永远匹配不上的死代码，界面上「已经跑完却还让你批」的幽灵条目
 * 一条都没被销掉。见 NOTES.md。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApprovalStore, matchKey, OUTCOME } from '../src/approvals.mjs'

const NO_AUTO = { autoApproveMs: 0, timeoutMs: 60_000 }
const mk = (st, over = {}) =>
  st.create({ session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' }, ...over }, NO_AUTO)

test('matchKey 稳定且有区分度', async (t) => {
  await t.test('键顺序不同结果相同（两个 hook 的 payload 形状不一样）', () => {
    assert.equal(
      matchKey('s', 'Bash', { command: 'ls', description: 'x' }),
      matchKey('s', 'Bash', { description: 'x', command: 'ls' }),
    )
  })
  await t.test('嵌套结构也稳定', () => {
    assert.equal(
      matchKey('s', 'T', { a: { x: 1, y: 2 }, b: [{ p: 1, q: 2 }] }),
      matchKey('s', 'T', { b: [{ q: 2, p: 1 }], a: { y: 2, x: 1 } }),
    )
  })
  await t.test('会话/工具/输入任一不同则键不同', () => {
    const base = matchKey('s1', 'Bash', { command: 'ls' })
    assert.notEqual(base, matchKey('s2', 'Bash', { command: 'ls' }))
    assert.notEqual(base, matchKey('s1', 'Read', { command: 'ls' }))
    assert.notEqual(base, matchKey('s1', 'Bash', { command: 'rm' }))
  })
})

test('supersede：工具已经开跑就销掉挂起的审批', async (t) => {
  await t.test('对上账并返回 allow（操作事实上已在跑，回 deny 与现实矛盾）', async () => {
    const st = new ApprovalStore()
    const ap = mk(st)
    const waiting = st.wait(ap.id)
    const gone = st.supersede(matchKey('s1', 'Bash', { command: 'ls' }))
    assert.equal(gone?.id, ap.id)
    assert.equal(ap.status, 'superseded')
    assert.equal((await waiting).decision, OUTCOME.ALLOW)
  })

  await t.test('同一会话跑两条相同命令时，一次只销最早的那条', () => {
    const st = new ApprovalStore()
    const a1 = mk(st)
    const a2 = mk(st)
    const key = matchKey('s1', 'Bash', { command: 'ls' })
    assert.equal(st.supersede(key)?.id, a1.id)
    assert.equal(a2.status, 'pending')
    assert.equal(st.supersede(key)?.id, a2.id)
    assert.equal(st.pending().length, 0)
  })

  await t.test('对不上账返回 null', () => {
    const st = new ApprovalStore()
    mk(st)
    assert.equal(st.supersede(matchKey('s1', 'Bash', { command: 'other' })), null)
  })

  await t.test('已终结的不会被再次 supersede', () => {
    const st = new ApprovalStore()
    const ap = mk(st)
    st.decide(ap.id, OUTCOME.DENY)
    assert.equal(st.supersede(ap.match_key), null)
    assert.equal(ap.status, 'denied')
  })
})

test('决策幂等：第一个写入的赢', () => {
  const st = new ApprovalStore()
  const ap = mk(st)
  assert.equal(st.decide(ap.id, OUTCOME.ALLOW).ok, true)
  const second = st.decide(ap.id, OUTCOME.DENY)
  assert.equal(second.ok, false)
  assert.equal(second.code, 'already_settled')
  assert.equal(ap.status, 'allowed', '后到的决策不得改写结果')
})

test('自动决策按风险分档', async (t) => {
  const st = new ApprovalStore()
  await t.test('普通操作短时自动通过', () => {
    const ap = st.create(
      { session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls -la' } },
      { autoApproveMs: 10_000 },
    )
    assert.equal(ap.auto_decision, OUTCOME.ALLOW)
  })
  await t.test('高危操作不自动通过，超时即拒绝', () => {
    const ap = st.create(
      { session_id: 's', tool_name: 'Bash', tool_input: { command: 'sudo rm -rf /' } },
      { autoApproveMs: 10_000 },
    )
    assert.equal(ap.auto_decision, OUTCOME.DENY)
  })
  await t.test('显式开启后高危也自动通过（默认关，开了等于放弃防护）', () => {
    const ap = st.create(
      { session_id: 's', tool_name: 'Bash', tool_input: { command: 'sudo rm -rf /' } },
      { autoApproveMs: 10_000, autoApproveHighRisk: true },
    )
    assert.equal(ap.auto_decision, OUTCOME.ALLOW)
  })
})

test('restore：重启后仍挂起的一律转 abandoned，并补齐 match_key', () => {
  const st = new ApprovalStore()
  const { orphaned } = st.restore([
    { id: 'a', status: 'pending', session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls' } },
    { id: 'b', status: 'allowed', session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls' } },
  ])
  assert.equal(orphaned, 1)
  assert.equal(st.get('a').status, 'abandoned', '重启后连接早断了，显示成待审批是骗人')
  assert.equal(st.get('a').match_key, matchKey('s', 'Bash', { command: 'ls' }))
})

test('描述与命令不符时给出警告', async (t) => {
  const st = new ApprovalStore()
  const analyze = (command, description) =>
    st.create({ session_id: 's', tool_name: 'Bash', tool_input: { command, description } }, NO_AUTO)

  await t.test('描述称只读、命令却是删除 → 警告', () => {
    const ap = analyze('rm -rf /Users/x/proj', '列出项目文件')
    assert.ok(ap.mismatch, '应给出不符警告')
    assert.match(ap.mismatch, /递归\/强制删除/)
  })
  await t.test('描述与命令一致 → 不警告', () => {
    assert.equal(analyze('ls -la', '列出项目文件').mismatch, null)
  })
  await t.test('描述本来就不声称只读 → 不警告（不做语义比对）', () => {
    assert.equal(analyze('rm -rf /tmp/x', '清理临时目录').mismatch, null)
  })
})

test('截断不得把命中风险的内容藏起来', () => {
  const st = new ApprovalStore()
  const long = 'echo ok\n'.repeat(400) + '\nsudo rm -rf /'
  const ap = st.create(
    { session_id: 's', tool_name: 'Bash', tool_input: { command: long, description: '构建' } },
    NO_AUTO,
  )
  assert.equal(ap.risk.level, 'high', '判定读的是全文')
  assert.ok(
    ap.detail.includes('sudo rm -rf /'),
    '用户看到的内容必须包含判定所依据的那一行，否则等于让人对着看不见的东西签字',
  )
})

/**
 * 有人在看的时候，时钟要停。
 *
 * 这一条是被真实故障推出来的：普通风险默认 10 秒自动通过（目的是别为
 * `npm run build` 打扰你），但我们**同时**还推一条通知请你去决定。于是
 *
 *   手机震动 → 解锁 → 点通知 → 页面加载 → 读命令 → 滑动
 *   → 客户端还要等 3 秒撤销窗口 → 才真正发出决策
 *
 * 10 秒早过了。历史数据里每一条普通审批都是 `by=timeout` 在整 10 秒结的，
 * **人不可能赢**。用户看到的是「我明明手动批了，却提示已自动通过」。
 *
 * 所以详情页一打开就 extend。这些用例钉的是 extend 的三条性质。
 */
test('extend：有人在看就停表', async (t) => {
  const mk = (policy) => {
    const s = new ApprovalStore()
    return { s, ap: s.create({ session_id: 'x', tool_name: 'Bash', tool_input: { command: 'ls' } }, policy) }
  }

  await t.test('把时限推到新的截止点', () => {
    const { s, ap } = mk({ autoApproveMs: 10_000 })
    const before = ap.expires_at
    s.extend(ap.id, 180_000)
    assert.ok(s.get(ap.id).expires_at > before + 100_000, '10 秒的窗口应该被推到 3 分钟量级')
  })

  await t.test('只延长不缩短', () => {
    // 高危默认 3 分钟。反复打开页面不能把它一次次砍回 10 秒
    const { s, ap } = mk({ timeoutMs: 180_000 })
    const before = s.get(ap.id).expires_at
    s.extend(ap.id, 10_000)
    assert.equal(s.get(ap.id).expires_at, before, '短的目标时限必须被忽略')
  })

  await t.test('auto_decision 不变——变的是「你有多久插手」，不是「不插手会怎样」', () => {
    const { s, ap } = mk({ autoApproveMs: 10_000 })
    const before = ap.auto_decision
    s.extend(ap.id, 180_000)
    assert.equal(s.get(ap.id).auto_decision, before)
  })

  await t.test('已经结掉的不动', () => {
    const { s, ap } = mk({})
    s.decide(ap.id, 'allow')
    const after = s.get(ap.id).expires_at
    assert.equal(s.extend(ap.id, 999_000), null)
    assert.equal(s.get(ap.id).expires_at, after)
  })

  await t.test('不存在的 id 不抛', () => {
    assert.equal(new ApprovalStore().extend('nope', 1000), null)
  })

  await t.test('延长之后，等待中的那个真的会晚点到期', async () => {
    // 只改 expires_at 是不够的——定时器在创建那一刻就把延迟算死了，
    // 不重新排期的话它照样在原来的时间点开火，延长等于没做
    const s = new ApprovalStore()
    const ap = s.create({ session_id: 'x', tool_name: 'Bash', tool_input: { command: 'ls' } },
      { autoApproveMs: 60 })
    const waited = s.wait(ap.id)
    s.extend(ap.id, 5_000)
    const raced = await Promise.race([
      waited.then(() => 'settled'),
      new Promise((r) => setTimeout(() => r('still-pending'), 300)),
    ])
    assert.equal(raced, 'still-pending', '定时器没有被重新排期，延长没生效')
    assert.equal(s.get(ap.id).status, 'pending')
  })
})

test('extend 必须封顶在 hook 的系统超时之前', async (t) => {
  const mk = () => {
    const s = new ApprovalStore()
    return { s, ap: s.create({ session_id: 'x', tool_name: 'Bash', tool_input: { command: 'ls' } },
      { autoApproveMs: 10_000 }) }
  }

  await t.test('反复延长顶不过 570 秒', () => {
    // 详情页每几秒 sync 一次，每次都 extend。没有天花板的话，在那个页面上
    // 停留超过 570 秒这条审批就永远不会自己结掉——而那会走到 hook 的 600s
    // 系统超时，被当成「非阻塞错误」放行到 Claude Code 自己的权限流程，
    // 终端空挂着等一个没人看的弹框。570s 这条线的全部意义就是不让它发生。
    const { s, ap } = mk()
    for (let i = 0; i < 50; i++) s.extend(ap.id, 180_000)
    const ttl = s.get(ap.id).expires_at - ap.created_at
    assert.ok(ttl <= 570_000, `延长到了 ${Math.round(ttl / 1000)}s，越过了 570s 红线`)
  })

  await t.test('一次要一个超大的时限也顶不过去', () => {
    const { s, ap } = mk()
    s.extend(ap.id, 99_999_000)
    assert.ok(s.get(ap.id).expires_at - ap.created_at <= 570_000)
  })

  await t.test('天花板从 created_at 算，不是从现在算', () => {
    // 它是这条 hook 连接能活多久的上限，跟你什么时候点开页面无关
    const { s, ap } = mk()
    s.extend(ap.id, 570_000)
    assert.ok(s.get(ap.id).expires_at <= ap.created_at + 570_000 + 50)
  })
})
