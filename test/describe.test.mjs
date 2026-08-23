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
import {
  analyze,
  describeMismatch,
  truncateDetail,
  firstMeaningfulLine,
  fileChange,
  MAX_DETAIL,
  MAX_CHANGE_LINES,
  MAX_CHANGE_LINE_CHARS,
} from '../src/view/describe.mjs'

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

/**
 * 写文件类操作的内容预览。
 *
 * 在这之前这一支只给一个文件路径——手机上问你「修改 auth.ts，批准吗」，
 * 而你唯一的依据是模型自己写的那句话，也就是这个文件里反复说的
 * 「链路里唯一不可信的文本」。这组测试守的是：**要写进去的东西必须
 * 到得了屏幕上，而看不到的部分必须明说**。
 */
test('写文件的内容预览', async (t) => {
  await t.test('Write：全文按新增给出', () => {
    const c = fileChange('Write', { file_path: '/a/b.ts', content: 'line1\nline2' })
    assert.deepEqual(c.lines, [{ t: '+', s: 'line1' }, { t: '+', s: 'line2' }])
    assert.equal(c.added, 2)
    assert.equal(c.removed, 0)
  })

  await t.test('Edit：旧的标减、新的标加', () => {
    const c = fileChange('Edit', { file_path: '/a/b.ts', old_string: 'old', new_string: 'new' })
    assert.deepEqual(c.lines, [{ t: '-', s: 'old' }, { t: '+', s: 'new' }])
  })

  await t.test('首尾一致的上下文被掐掉，但要说掐了几行', () => {
    // 模型常在 old/new 两侧各带几行一模一样的上下文。掐掉是安全的
    // （两侧逐字相同，没有内容被藏起来），但必须告诉用户掐了多少，
    // 否则他没法判断自己看到的是不是全部
    const c = fileChange('Edit', {
      file_path: '/a/b.ts',
      old_string: 'ctx1\nctx2\nOLD\nctx3',
      new_string: 'ctx1\nctx2\nNEW\nctx3',
    })
    assert.deepEqual(c.lines, [{ t: '-', s: 'OLD' }, { t: '+', s: 'NEW' }])
    assert.equal(c.trimmed, 3)
  })

  await t.test('完全没变的改动不会变成空白', () => {
    // 掐完两头什么都不剩。给一行空的也比什么都不给强——
    // 空白会让人以为是没加载出来
    const c = fileChange('Edit', { file_path: '/a/b.ts', old_string: 'same', new_string: 'same' })
    assert.ok(c.lines.length >= 1)
  })

  await t.test('插入（old_string 是空串）也算数', () => {
    // 空串是合法输入，判真假会把它当成「没有这个字段」整个丢掉
    const c = fileChange('Edit', { file_path: '/a/b.ts', old_string: '', new_string: 'added' })
    assert.ok(c.lines.some((l) => l.t === '+' && l.s === 'added'))
  })

  await t.test('预算用尽只能从尾部截断，不许中间挖洞', () => {
    /**
     * 这一条是修一个真 bug 留下的。原来字符预算的循环用 continue：某一行
     * 超出剩余预算被跳过，而它**后面**较短的行仍然通过检查显示出来——
     * diff 中间静默少一行，页面底下却只说「还有 N 行未显示」，读起来是
     * 「尾部截断了」。用户照着一段被挖了洞的内容点批准。
     *
     * 判据不是「截了多少」，是**显示出来的必须是原文的一段连续前缀**。
     */
    const lines = []
    for (let i = 0; i < 20; i++) lines.push('x'.repeat(199)) // 累计 3980
    lines.push('DROPPED-'.padEnd(199, 'y'))                  // 超预算，会被截
    lines.push('rm -rf ~')                                   // 短，别让它顶上来
    const c = fileChange('Write', { file_path: '/a.sh', content: lines.join('\n') })

    const shown = c.lines.map((l) => l.s)
    assert.deepEqual(shown, lines.slice(0, shown.length), '显示的内容不是原文的连续前缀')
    assert.ok(!shown.includes('rm -rf ~'), '被跳过的行后面的内容顶上来了')
    assert.equal(c.truncated.lines, lines.length - shown.length)
  })

  await t.test('纯删除就是纯删除，不许多出一行新增', () => {
    // ''.split('\n') 返回 ['']，于是空的那一侧变成「一个空行」而不是「没有行」。
    // 后果是一次纯删除被标成「+1 −1」，而那个标签还会出现在首页列表和通知里
    const c = fileChange('Edit', { file_path: '/a.ts', old_string: 'const secret = 1', new_string: '' })
    assert.deepEqual(c.lines, [{ t: '-', s: 'const secret = 1' }])
    assert.equal(c.added, 0)
    assert.equal(c.removed, 1)
  })

  await t.test('纯插入同理，不许多出一行删除', () => {
    const c = fileChange('Edit', { file_path: '/a.ts', old_string: '', new_string: 'added' })
    assert.deepEqual(c.lines, [{ t: '+', s: 'added' }])
    assert.equal(c.removed, 0)
  })

  await t.test('行数超上限 → 截断并说明还剩多少', () => {
    const content = Array.from({ length: MAX_CHANGE_LINES + 25 }, (_, i) => `l${i}`).join('\n')
    const c = fileChange('Write', { file_path: '/a/b.ts', content })
    assert.equal(c.lines.length, MAX_CHANGE_LINES)
    assert.equal(c.truncated.lines, 25)
    // added 报的是**真实**的改动行数，不是显示出来的那些 ——
    // 标签行上那个数字必须说的是这次操作的规模
    assert.equal(c.added, MAX_CHANGE_LINES + 25)
  })

  await t.test('单行超长 → 截断那一行，并计入被截字符数', () => {
    const c = fileChange('Write', { file_path: '/a/b.ts', content: 'x'.repeat(MAX_CHANGE_LINE_CHARS + 40) })
    assert.equal(c.lines[0].s.length, MAX_CHANGE_LINE_CHARS)
    assert.equal(c.truncated.chars, 40)
  })

  await t.test('没有内容可看的工具返回 null，不硬凑', () => {
    assert.equal(fileChange('Edit', { file_path: '/a/b.ts' }), null)
    assert.equal(fileChange('Write', { file_path: '/a/b.ts' }), null)
  })

  await t.test('NotebookEdit 删单元格：说清楚删的是哪个', () => {
    const c = fileChange('NotebookEdit', { notebook_path: '/a/n.ipynb', edit_mode: 'delete', cell_id: 'c7' })
    assert.equal(c.lines[0].t, '-')
    assert.match(c.lines[0].s, /c7/)
  })

  await t.test('analyze 把改动量放进标签行', () => {
    // 「改了多少」是判断「这是不是我要的那个改动」最快的信号，
    // 而它不需要展开内容就能看到
    const v = analyze('Edit', { file_path: '/a/b.ts', old_string: 'a', new_string: 'b\nc' })
    assert.ok(v.change)
    assert.ok(v.impact.some((i) => /\+2/.test(i.label)))
  })

  await t.test('路径仍然是 detail —— 风险判定只看它', () => {
    // assess.mjs 对 Edit/Write 只读 file_path（敏感路径、越界写入）。
    // 内容再怎么截断都不会藏起判定依据，但前提是路径**永远**完整给出
    const v = analyze('Write', { file_path: '/Users/x/.ssh/config', content: 'a' })
    assert.equal(v.detail, '/Users/x/.ssh/config')
  })
})
