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
