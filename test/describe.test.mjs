/**
 * 展示层：把一次工具调用描述成人能读的东西。
 *
 * 之前这些逻辑埋在 ApprovalStore 里，只能通过 create() 间接测。
 * 拆出来之后可以直接打，边界情况也就好覆盖了。
 *
 * 贯穿的原则：模型写的 description 是链路里唯一由被审查方生成的文本，
 * 不可信。这里的测试大半是在守这一条。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyze, describeMismatch, truncateDetail, firstMeaningfulLine, MAX_DETAIL } from '../src/view/describe.mjs'

test('描述与命令不符', async (t) => {
  await t.test('自称只读、实为删除 → 指出具体做了什么', () => {
    const m = describeMismatch('列出项目文件', 'rm -rf /Users/x/proj')
    assert.match(m, /递归\/强制删除/)
  })
  await t.test('英文描述同样识别', () => {
    assert.ok(describeMismatch('list project files', 'rm -rf /tmp/x'))
    assert.ok(describeMismatch('Check the build output', 'sudo rm -rf /'))
  })
  await t.test('描述与命令一致 → 不报', () => {
    assert.equal(describeMismatch('列出项目文件', 'ls -la'), null)
    assert.equal(describeMismatch('查看状态', 'git status'), null)
  })
  await t.test('描述本来就没自称只读 → 不报（不做语义比对）', () => {
    assert.equal(describeMismatch('清理临时目录', 'rm -rf /tmp/x'), null)
    assert.equal(describeMismatch('部署到生产', 'npm publish'), null)
  })
  await t.test('自称只读但命令只是「不确定只读」→ 也要报', () => {
    // 没命中高危规则，但也进不了只读白名单
    const m = describeMismatch('查看构建产物', 'frobnicate --wibble')
    assert.match(m, /并非只读/)
  })
  await t.test('空输入不炸', () => {
    assert.equal(describeMismatch('', 'rm -rf /'), null)
    assert.equal(describeMismatch('查看', ''), null)
    assert.equal(describeMismatch(null, null), null)
  })
  await t.test('超长描述被截断，不撑爆界面', () => {
    const m = describeMismatch('查看' + 'x'.repeat(500), 'rm -rf /tmp/x')
    assert.ok(m.length < 120, `不该把整段描述塞进警告: ${m.length} 字符`)
  })
})

test('analyze 按工具类型分层', async (t) => {
  await t.test('Bash：命令是 detail，描述是 headline', () => {
    const v = analyze('Bash', { command: 'ls -la', description: '列目录' })
    assert.equal(v.detail, 'ls -la')
    assert.equal(v.headline, '列目录')
  })
  await t.test('Bash 没给描述时，取第一条真正干活的命令', () => {
    const v = analyze('Bash', { command: '#!/bin/bash\ncd /tmp\nFOO=1\nrm -rf x' })
    assert.equal(v.headline, 'rm -rf x')
  })
  await t.test('Write / Read / WebFetch / MCP 各有形态', () => {
    assert.match(analyze('Write', { file_path: '/a/b/c.js' }).headline, /写入 c\.js/)
    assert.match(analyze('Read', { file_path: '/a/b/c.js' }).headline, /读取 c\.js/)
    assert.match(analyze('WebFetch', { url: 'https://example.com/x' }).headline, /example\.com/)
    assert.match(analyze('mcp__slack__post', {}).headline, /MCP 调用 slack · post/)
  })
  await t.test('坏 URL 不炸', () => {
    assert.ok(analyze('WebFetch', { url: 'not a url' }).headline)
  })
  await t.test('未知工具有兜底', () => {
    const v = analyze('SomethingNew', { foo: 1 })
    assert.equal(v.headline, 'SomethingNew')
  })
  await t.test('tool_input 不是对象也不炸', () => {
    for (const bad of [null, undefined, 'str', 42]) {
      assert.ok(analyze('Bash', bad).headline, `analyze('Bash', ${bad}) 炸了`)
    }
  })
})

test('截断', async (t) => {
  await t.test('短命令原样返回', () => {
    assert.equal(truncateDetail('ls -la'), 'ls -la')
  })
  await t.test('长命令里被省略的危险行要被提出来', () => {
    const long = 'echo ok\n'.repeat(500) + '\nsudo rm -rf /'
    const out = truncateDetail(long)
    assert.ok(out.length < long.length, '应该被截断')
    assert.ok(out.includes('sudo rm -rf /'), '判定依据的那一行必须可见')
    assert.match(out, /命中风险规则/)
  })
  await t.test('被省略的部分没有危险内容时不加噪音', () => {
    const out = truncateDetail('echo ok\n'.repeat(500))
    assert.ok(!out.includes('命中风险规则'))
    assert.match(out, /中间省略/)
  })
  await t.test('提出来的行有数量上限，别把截断的意义抵消掉', () => {
    const long = 'x'.repeat(MAX_DETAIL) + '\n' + 'sudo rm -rf /tmp/a\n'.repeat(200)
    const out = truncateDetail(long)
    const flagged = out.split('\n').filter((l) => l.trim().startsWith('sudo rm')).length
    assert.ok(flagged <= 10, `提出来 ${flagged} 行，太多了`)
  })
  await t.test('空值不炸', () => {
    assert.equal(truncateDetail(null), '')
    assert.equal(truncateDetail(undefined), '')
  })
})

test('firstMeaningfulLine 跳过噪音行', async (t) => {
  await t.test('跳过注释、cd、变量赋值', () => {
    assert.equal(firstMeaningfulLine('# 说明\ncd /tmp\nexport A=1\nB=2\nnpm run build'), 'npm run build')
  })
  await t.test('全是噪音时退回第一行', () => {
    assert.equal(firstMeaningfulLine('cd /tmp'), 'cd /tmp')
  })
  await t.test('超长行截断', () => {
    assert.ok(firstMeaningfulLine('echo ' + 'x'.repeat(300)).length <= 90)
  })
})
