/**
 * 文档里写的默认值必须和代码一致。
 *
 * 这条被现实推出来过两次：默认等待时长从 570 秒改成 180 秒之后，中文指南
 * 还写着「约 9 分半」，英文指南写着「~9.5 min」——两处都在**发布前的最后
 * 一轮检查**才被抓到，而它们已经在仓库里躺了很久。
 *
 * 文档说错默认值的后果不是「不好看」：用户据此判断「离开电脑多久任务才会
 * 失败」，差了三倍。而这种错永远不会让任何测试变红，除非专门写一条。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')
const src = read('src/config.mjs')
const num = (key) => Number(String(src.match(new RegExp(`${key}:\\s*([0-9_]+)`))[1]).replace(/_/g, ''))

const DOCS = ['README.md', 'docs/guide.md', 'docs/guide.zh-CN.md']

test('文档不得残留旧的超时值', async (t) => {
  const timeoutMin = num('timeoutMs') / 60_000

  await t.test('代码默认值就是 3 分钟', () => {
    assert.equal(timeoutMin, 3, '默认值改了的话，下面几条断言和文档都要跟着改')
  })

  for (const f of DOCS) {
    await t.test(`${f} 不再说 9 分半`, () => {
      const s = read(f)
      // 570 秒是**硬上限**，文档里提它是对的；「9 分半 / 9.5 min」是把上限
      // 当成默认值在说，那是错的
      assert.doesNotMatch(s, /9\.5\s*min|9 分半|9分半/,
        '这是旧的 570s 默认值，现在默认是 3 分钟')
    })
  }
})

test('文档不得残留旧的自动通过时长', async (t) => {
  const autoSec = num('autoApproveMs') / 1000
  await t.test('代码默认值是 10 秒', () => {
    assert.equal(autoSec, 10)
  })
  for (const f of DOCS) {
    await t.test(`${f} 说的也是 10 秒`, () => {
      const s = read(f)
      // 只在文档确实提到「自动通过」时才校验，避免误伤
      if (!/自动通过|auto-approve|auto-pass/i.test(s)) return
      assert.match(s, /10\s*(seconds?\b|s\b|秒)/, `${f} 提到了自动通过却没写 10 秒`)
    })
  }
})

test('README 必须写明风险识别不是沙箱', () => {
  // 正则挡不住 base64 解码后管道执行、变量间接引用、curl | sh。
  // 不写清楚的话，「普通」这个标签会被读成「安全」
  const s = read('README.md')
  assert.match(s, /not a sandbox/i, 'README 要明说风险识别只是提示')
  assert.match(s, /base64/i, '要给出具体的绕过例子，不能只说一句抽象的话')
})

test('文档不得声称自动通过的操作「不推送」', async (t) => {
  // notifyAutoApproved 默认是 true —— 它们**会**推送。文档曾经写反，而这正是
  // 「我明明手动批了却提示已自动通过」那个困惑的来源：人收到通知、点进去、
  // 划一下，而那条早在 10 秒时就自己过了。
  const src = readFileSync(join(root, 'src/config.mjs'), 'utf8')
  const on = /notifyAutoApproved:\s*true/.test(src)
  await t.test('代码里默认开着', () => assert.equal(on, true))
  for (const f of DOCS) {
    await t.test(`${f} 没说反`, () => {
      assert.doesNotMatch(readFileSync(join(root, f), 'utf8'),
        /deliberately don't notify|不会推送|故意不推送/,
        '默认是会推送的')
    })
  }
})

/**
 * 架构文档里那张能力矩阵，必须和 src/agents.mjs 的 AGENTS 逐格一致。
 *
 * 这条的理由跟这个文件里其它几条一模一样：**文档说错了永远不会让任何测试
 * 变红**。而这张表比超时值更容易过期——它本来就是为「会变」而存在的：
 * Codex 的 approve 一旦真机验收通过就要从 ✗ 翻成 ✓，DSH 的 cancel/inbox
 * 接上控制端点之后同理。
 *
 * 说错的后果也更重。这张表是**给下一个改代码的人看的判断依据**：他据此
 * 决定「这个后端能不能加暂停按钮」。文档说能而代码说不能，产出的就是一个
 * 点了没反应的按钮——正是 agents.mjs 顶上那段注释花一整屏在防的东西。
 */
test('架构文档的能力矩阵和 AGENTS 一致', async (t) => {
  const { AGENTS } = await import('../src/agents.mjs')
  const doc = read('docs/architecture.zh-CN.md')
  const yes = (v) => (v ? '✓' : '✗')

  for (const [key, cap] of Object.entries(AGENTS)) {
    await t.test(`${cap.label}`, () => {
      // 认表里那一行：以 | 后端名 | 开头，一直到行尾
      const row = doc.split('\n').find((l) => l.trim().startsWith(`| ${cap.label} |`))
      assert.ok(row, `文档的能力矩阵里没有 ${cap.label} 这一行`
        + `（新加了后端？那 §7 那四个问题也该回答一遍）`)

      const cells = row.split('|').map((c) => c.trim()).filter(Boolean)
      const [, approve, pause, cancel, inbox, quota] = cells
      assert.equal(approve, yes(cap.approve), `${cap.label} 的 approve 写反了`)
      assert.equal(pause, yes(cap.pause), `${cap.label} 的 pause 写反了`)
      assert.equal(cancel, yes(cap.cancel), `${cap.label} 的 cancel 写反了`)
      assert.equal(inbox, yes(cap.inbox), `${cap.label} 的 inbox 写反了`)
      assert.equal(quota, cap.quota.toUpperCase(), `${cap.label} 的额度形态写错了`)
    })
  }

  /**
   * 只看能力矩阵那一张表。
   *
   * 不能拿「含 ✓/✗ 的行」去全文筛：§3 那张「每条边的生产者」同样用 ✗ 填格，
   * 而它的第一列是转移名不是后端名。第一版就是这么写的，于是「→ Paused」
   * 被当成了一个不存在的后端。
   */
  const capTable = () => {
    const lines = doc.split('\n')
    const head = lines.findIndex((l) => l.trim().startsWith('| | approve |'))
    assert.notEqual(head, -1, '找不到能力矩阵的表头，是不是改列名了？')
    // 表头 + 分隔行之后，一直取到表结束（空行或不再是表格行）
    const rows = []
    for (const l of lines.slice(head + 2)) {
      if (!l.trim().startsWith('|')) break
      rows.push(l)
    }
    return rows
  }

  await t.test('表里没有多出来的后端', () => {
    const labels = new Set(Object.values(AGENTS).map((a) => a.label))
    for (const row of capTable()) {
      const label = row.split('|')[1].trim()
      assert.ok(labels.has(label),
        `文档里的 ${label} 在 AGENTS 里不存在——写成计划了？`
        + `这张表只描述现在能做到的，计划写进 §7`)
    }
  })

  await t.test('每个后端都在表里，一个不落', () => {
    const listed = new Set(capTable().map((r) => r.split('|')[1].trim()))
    for (const cap of Object.values(AGENTS)) {
      assert.ok(listed.has(cap.label), `${cap.label} 不在能力矩阵里`)
    }
  })

  await t.test('文档里没有「?」这一档', () => {
    // 能力表的规矩是「没验证过的按不存在处理」。一个问号会被读成
    // 「去试试看」，而试的方式就是把那条没验证过的路径接上生产
    assert.doesNotMatch(capTable().join('\n'), /[?？]/,
      '能力矩阵里不能有「?」——没验证过就是 ✗')
  })
})

/**
 * 架构文档里指到的文件和符号，必须真的存在。
 *
 * 这条是被**这份文档自己**推出来的：它原来用 `文件:行号` 引用代码，而同一轮
 * 里改 src/state.mjs 加了一个状态档，一口气把五处行号顶跑了——没有任何测试
 * 会因此变红，读文档的人点过去看到的是毫不相干的一行。
 *
 * 所以引用改成「文件 + 符号名」，并由这条测试钉住。符号名不会因为上面加了
 * 几行就失效，而它一旦被改名，这里就红。
 */
test('架构文档引用的文件和符号都还在', async (t) => {
  const doc = read('docs/architecture.zh-CN.md')
  // [显示文本](../相对路径) 后面可选地跟着「的 `符号`」
  const re = /\[[^\]]+\]\(\.\.\/([^)]+)\)(?:\s*的\s*`([^`]+)`)?/g

  let n = 0
  for (const [, rel, symbol] of doc.matchAll(re)) {
    n++
    await t.test(`${rel}${symbol ? ` 的 ${symbol}` : ''}`, () => {
      let src
      try {
        src = read(rel)
      } catch {
        assert.fail(`文档指向 ${rel}，但这个文件不在了`)
      }
      if (!symbol) return
      // 分支名（turn-usage / permission-request）和标识符（noteControl）都在
      // 源码里以原样出现，直接搜字符串就够——这里要挡的是「改名了没同步」
      assert.ok(src.includes(symbol),
        `文档说 ${rel} 里有 ${symbol}，但搜不到。改名了就把文档一起改`)
    })
  }
  await t.test('至少解析到了一批引用', () => {
    // 正则写坏了会一条都匹配不到，然后这个测试永远绿——那比没有更糟
    assert.ok(n >= 15, `只解析到 ${n} 条引用，正则是不是失效了？`)
  })
})
