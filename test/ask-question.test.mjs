/**
 * AskUserQuestion：在手机上**回答**，而不是批准/拒绝。
 *
 * ## 之前是什么样
 *
 * 它走通用分支：headline 是光秃秃的工具名 `AskUserQuestion`，detail 是一整坨
 * 十几行原始 JSON，底下两个按钮「允许 / 拒绝」。而对一道选择题：
 *   · 允许 = 放行工具调用 = 问题弹回 Mac 终端，手机白看一场
 *   · 拒绝 = 你不想答，模型不知道你选了什么
 *
 * 两个都不是「回答」。手机端事实上无法参与。
 *
 * ## 现在怎么送回去
 *
 * hook 协议里唯一能把**内容**带回模型的字段是 `permissionDecisionReason`，
 * 而它只在拒绝时回传。所以回答 = 拒绝这次调用 + 把选项写进拒绝理由。
 * 绕，但这是现有协议下唯一的通道。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApprovalStore, OUTCOME } from '../src/approvals.mjs'
import { analyze, askQuestions } from '../src/view/describe.mjs'

const INPUT = {
  questions: [{
    question: '倒计时该怎么处理？',
    header: '普通审批时限',
    multiSelect: false,
    options: [
      { label: '不延长，保持 10 秒', description: '首页和详情页一致。' },
      { label: '延长到 30 秒', description: '够读完再滑。' },
    ],
  }],
}

const mk = () => {
  const s = new ApprovalStore()
  const ap = s.create({ session_id: 'x', tool_name: 'AskUserQuestion', tool_input: INPUT }, { autoApproveMs: 10_000 })
  return { s, ap }
}

test('题目被拆成手机能渲染的结构', async (t) => {
  await t.test('标题是人话，不是工具名', () => {
    const v = analyze('AskUserQuestion', INPUT)
    assert.equal(v.headline, '普通审批时限')
    assert.doesNotMatch(v.headline, /AskUserQuestion/, '工具名对人零信息量')
  })

  await t.test('正文是题干，不是原始 JSON', () => {
    const v = analyze('AskUserQuestion', INPUT)
    assert.equal(v.detail, '倒计时该怎么处理？')
    assert.ok(!v.detail.includes('{'), `还是 JSON: ${v.detail.slice(0, 60)}`)
  })

  await t.test('选项带标签和说明', () => {
    const [q] = askQuestions(INPUT)
    assert.equal(q.options.length, 2)
    assert.equal(q.options[0].label, '不延长，保持 10 秒')
    assert.match(q.options[0].description, /首页和详情页一致/)
  })

  await t.test('choices 挂在审批对象上', () => {
    assert.equal(mk().ap.choices.length, 1)
  })

  await t.test('其他工具的 choices 是空数组，不是 undefined', () => {
    // 前端写的是 `a.choices && a.choices.length`，undefined 也能过；
    // 但它要经 JSON 出去，字段直接消失会让下游少一个可判断的位
    const s = new ApprovalStore()
    const ap = s.create({ session_id: 'x', tool_name: 'Bash', tool_input: { command: 'ls' } }, {})
    assert.deepEqual(ap.choices, [])
  })

  await t.test('题目和选项都有长度上限', () => {
    // description 可以写得很长，手机上一屏放不下；而它还要进 HTML
    const [q] = askQuestions({
      questions: [{
        question: 'q'.repeat(9999),
        options: [{ label: 'l'.repeat(9999), description: 'd'.repeat(9999) }],
      }],
    })
    assert.ok(q.question.length <= 500)
    assert.ok(q.options[0].label.length <= 120)
    assert.ok(q.options[0].description.length <= 400)
  })
})

test('回答送回模型的是选项内容', async (t) => {
  await t.test('answer() 结成 answered，并记下选了什么', () => {
    const { s, ap } = mk()
    const out = s.answer(ap.id, ['不延长，保持 10 秒'])
    assert.equal(out.ok, true)
    assert.equal(s.get(ap.id).status, 'answered')
    assert.deepEqual(s.get(ap.id).answer, ['不延长，保持 10 秒'])
  })

  await t.test('hook 拿到的是 deny + 带选项的理由', async () => {
    const { s, ap } = mk()
    const waited = s.wait(ap.id)
    s.answer(ap.id, ['不延长，保持 10 秒'])
    const outcome = await waited
    // deny 是通道不是态度：permissionDecisionReason 只在拒绝时回传给模型
    assert.equal(outcome.decision, OUTCOME.DENY)
    assert.match(outcome.reason, /不延长，保持 10 秒/, '选项内容必须原样带回去')
    assert.match(outcome.reason, /手机/, '要说清是谁在哪做的选择，别被读成一句普通拒绝')
  })

  await t.test('多选原样带回', async () => {
    const { s, ap } = mk()
    const waited = s.wait(ap.id)
    s.answer(ap.id, ['A', 'B'])
    const outcome = await waited
    assert.match(outcome.reason, /「A」、「B」/)
  })
})

test('answer 的边界', async (t) => {
  await t.test('不是选择题的工具不能被回答', () => {
    // 否则任何一次 Bash 审批都能被伪装成「回答」绕过允许/拒绝的语义
    const s = new ApprovalStore()
    const ap = s.create({ session_id: 'x', tool_name: 'Bash', tool_input: { command: 'ls' } }, {})
    assert.equal(s.answer(ap.id, ['随便']).code, 'not_answerable')
    assert.equal(s.get(ap.id).status, 'pending')
  })

  await t.test('空选择不算回答', () => {
    const { s, ap } = mk()
    for (const bad of [[], [''], ['   '], null, undefined]) {
      assert.equal(s.answer(ap.id, bad).code, 'bad_choice', `bad=${JSON.stringify(bad)}`)
    }
    assert.equal(s.get(ap.id).status, 'pending')
  })

  await t.test('已经结掉的不能再答', () => {
    const { s, ap } = mk()
    s.answer(ap.id, ['A'])
    assert.equal(s.answer(ap.id, ['B']).code, 'already_settled')
    assert.deepEqual(s.get(ap.id).answer, ['A'], '第一个写入的赢')
  })

  await t.test('选项数量封顶', () => {
    // 这段文本会原样进模型上下文，不封顶等于给了一个任意长度的注入口
    const { s, ap } = mk()
    s.answer(ap.id, Array.from({ length: 50 }, (_, i) => `选项${i}`))
    assert.ok(s.get(ap.id).answer.length <= 8)
  })

  await t.test('不存在的 id 不抛', () => {
    assert.equal(new ApprovalStore().answer('nope', ['A']).code, 'not_found')
  })
})

test('选择题仍然会被延长 —— 放行等于错过', () => {
  // 它是 normal 风险、到点自动通过，按 extend 的一般规则不该被延长。
  // 但对它「自动通过」= 问题弹回终端 = 手机彻底没机会，和自动拒绝一样不可挽回
  const { s, ap } = mk()
  const before = ap.expires_at
  s.extend(ap.id, 180_000)
  assert.ok(s.get(ap.id).expires_at > before + 100_000)
})
