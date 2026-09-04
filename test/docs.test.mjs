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

/**
 * `skills/clamicro/SKILL.md` 也在这张表里，而它是**最该在**的一份。
 *
 * 那份 skill 在仓库外躺了四周（只存在于 `~/.claude/skills/`），没有版本、没有
 * 任何测试覆盖，于是同时烂掉了六处：cookie 说成一年（实际 30 天）、教人跑一条
 * 已经删掉的 `autostart` 命令、把 570 秒硬上限说成默认值（实际 180 秒）、教人
 * 改一个已经下线的 Bark 字段、自己拼 curl 把主令牌展开进 argv、以及用
 * `node -e` 非原子地重写 config.json。
 *
 * 而它**每天都在被触发**——用户说「给我个二维码」它就上场，然后照着讲错的东西。
 * 一份没人测的文档比没有文档危险，因为它看起来是权威的。
 *
 * **但把它加进这张表，只逮住了六处里的一处**（cookie 那条）。实测过：570 和
 * 那条已删的 `autostart` 命令都照样绿。原因是上面那颗钉子匹配的是「9 分半」
 * 这个**措辞**，而老 skill 写的是「最长 570 秒后自动拒绝」——同一个错，换了
 * 个说法就穿过去了。所以下面补了一条按**数值**判的。
 *
 * 记这一条是因为它是这类测试的通病：钉住的是当时那句话，不是那件事。
 */
const DOCS = ['README.md', 'docs/guide.md', 'docs/guide.zh-CN.md', 'skills/clamicro/SKILL.md']

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

test('文档不得写错登录 cookie 的有效期', async (t) => {
  /**
   * 这一条是从真事里长出来的：两份 guide（中英文）都写着「一年有效 / valid
   * for a year」，而代码里是 `Max-Age=2592000`，30 天。差 12 倍，而且是往
   * **松**的方向差。
   *
   * 它比一个数字错得更重：`token.mjs` 里那行注释说得很清楚——这颗 cookie
   * 能批准 `rm -rf`、能读 `~/.ssh`，一年的有效期对这种权限太长了，所以才
   * 特意收到 30 天。文档把它说回一年，等于把那次刻意的收紧当着用户的面
   * 撤销掉，而用户据此判断「多久要重新配对一次」。
   */
  const tok = readFileSync(join(root, 'src/auth/token.mjs'), 'utf8')
  const days = Number(/Max-Age=(\d+)/.exec(tok)[1]) / 86_400

  await t.test('代码里是 30 天', () => {
    assert.equal(days, 30, '改了有效期的话，下面几条断言和文档都要跟着改')
  })

  for (const f of DOCS.concat('README.zh-CN.md')) {
    await t.test(`${f} 不说「一年」`, () => {
      const s = read(f)
      assert.doesNotMatch(s, /valid for a year|有效期?一年|一年有效/i,
        `${f} 把 30 天说成了一年`)
    })
    await t.test(`${f} 提到有效期时写的是 30 天`, () => {
      const s = read(f)
      // 只在文档确实谈到这颗 cookie 时才校验，避免误伤
      if (!/cookie/i.test(s)) return
      assert.match(s, /30\s*(days?\b|天)/, `${f} 谈到了 cookie 却没写 30 天`)
    })
  }
})

test('文档不得把 570 秒说成超时默认值', async (t) => {
  /**
   * 570 是**硬上限**（`MAX_APPROVAL_TIMEOUT_MS`），默认是 180 秒。
   *
   * 文档里提 570 是对的——它解释了「为什么不能设更大」。错的是把它当成
   * 「高危操作会等多久」，那会让人以为走开九分半还来得及回来。老的 skill
   * 就是这么写的：「最长 570 秒后自动拒绝」。
   *
   * 上面那条钉的是「9 分半 / 9.5 min」这个措辞，换个说法就穿过去了。这条
   * 按数值判：570 只许出现在「上限」的语境里。
   */
  const timeoutSec = num('timeoutMs') / 1000

  await t.test('代码默认值是 180 秒', () => {
    assert.equal(timeoutSec, 180)
  })

  for (const f of DOCS.concat('README.zh-CN.md')) {
    await t.test(`${f} 里的 570 只出现在「上限」语境`, () => {
      const s = read(f)
      assert.doesNotMatch(s,
        /570\s*(秒|s\b|seconds?)[^。.\n]{0,12}(后)?[^。.\n]{0,12}(自动)?(拒绝|deny|reject)/i,
        `${f} 把 570 秒当成了超时默认值 —— 那是硬上限，默认是 ${timeoutSec} 秒`)
    })
  }
})

test('文档里出现的每条命令，cli.mjs 都得真的认', async (t) => {
  /**
   * 这条比上面两条通用：它钉的不是某个值，是**「文档教的命令还存在吗」**。
   *
   * 由来是那份在仓库外躺了四周的 skill，里面写着
   * `npx clamicro autostart on|off|status` —— 而 autostart 连同整套
   * LaunchAgent 早就删干净了。用户照着敲，得到的是「未知命令」加一屏 usage。
   *
   * 删一个命令时没人会想起去搜文档，所以让测试去搜。命令表从 cli.mjs 的
   * switch 里现取，加了新命令也不用来这儿登记一遍。
   */
  const cli = readFileSync(join(root, 'cli.mjs'), 'utf8')
  const known = new Set([...cli.matchAll(/^\s*case '([\w-]+)':/gm)].map((m) => m[1]))

  await t.test('命令表取到了（正则没被 switch 的写法变化搞失效）', () => {
    // 空集合会让下面每条断言都空转变绿 —— 那正是这个文件在防的那种「绿测试」
    assert.ok(known.size > 10, `只从 cli.mjs 取到 ${known.size} 条命令，正则多半失效了`)
    assert.ok(known.has('status') && known.has('doctor'), '取到的命令表不对')
  })

  for (const f of DOCS.concat('README.zh-CN.md', 'plugins/README.md')) {
    await t.test(`${f} 没有教已经不存在的命令`, () => {
      const used = [...read(f).matchAll(/npx clamicro ([a-z][\w-]*)/g)].map((m) => m[1])
      const dead = [...new Set(used)].filter((c) => !known.has(c))
      assert.deepEqual(dead, [], `${f} 里这些命令 cli.mjs 不认：${dead.join('、')}`)
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
