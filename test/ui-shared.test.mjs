/**
 * 页面间共用的那几张表，必须**只有一份**。
 *
 * 抽 ui/agents.js 之前的状态：`AGENT_LOGOS`（一段 3KB 的内联 SVG）在
 * home.html 和 approval.html 各一份，`STATE_LABEL` 在 home.html 和
 * session.html 各一份。两处都靠注释维持一致——「改一处要同步另一处」、
 * 「和 home.html 各一份，改时同步」。
 *
 * 注释拦不住任何东西。而漂了之后的表现不是报错：**同一个会话在两个页面上
 * 叫不同的名字**，或者某个后端在首页有 logo、在审批页没有。没有任何一条
 * 现有测试会因此变红，因为两份各自都是合法的 JS。
 *
 * 所以钉住三件事：只定义一次、用了就得引、引了就能跑。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

import { AGENTS } from '../src/agents.mjs'
import { STATE } from '../src/state.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

/** 会引用共享表的页面。settings/pair 那些不涉及会话状态，不在此列。 */
const PAGES = ['ui/home.html', 'ui/session.html', 'ui/approval.html']

/** 共享定义住在哪 */
const SHARED = 'ui/agents.js'

test('共享的对照表只在 ui/agents.js 里定义一次', async (t) => {
  const shared = read(SHARED)
  for (const name of ['AGENT_LOGOS', 'STATE_LABEL', 'SUBSTATE_LABEL']) {
    await t.test(`${name} 在 ${SHARED} 里`, () => {
      assert.match(shared, new RegExp(`const ${name}\\s*=`), `${SHARED} 应该定义 ${name}`)
    })
    for (const page of PAGES) {
      await t.test(`${page} 不再自带一份 ${name}`, () => {
        assert.doesNotMatch(read(page), new RegExp(`const ${name}\\s*=`),
          `${page} 又抄了一份 ${name}——改成用 /ui/agents.js 里的那份`)
      })
    }
  }
})

test('用到共享函数的页面都引了 /ui/agents.js', async (t) => {
  for (const page of PAGES) {
    const s = read(page)
    const uses = /\b(agentLogo|stateLabel|subStateLabel)\s*\(/.test(s)
    await t.test(`${page}`, () => {
      // 这条测试的价值全在这里：漏了 script 标签的表现是页面**整段脚本报错**
      // （ReferenceError），而不是少一个图标——首页会直接白屏
      assert.equal(uses, true, `${page} 应该用到共享函数，是不是改结构了？`)
      assert.match(s, /<script src="\/ui\/agents\.js"><\/script>/,
        `${page} 用了共享函数却没引 /ui/agents.js`)
    })
  }
})

test('服务端真的会把 /ui/agents.js 发出去', () => {
  // 引了但服务端不认这个路径的话，同样是整段脚本报错。见 src/routes/pages.mjs
  // 那条静态资源正则——它是白名单，加文件必须同时加进去。
  const pages = read('src/routes/pages.mjs')
  const m = pages.match(/const asset = path\.match\((\/.*?\/)\)/)
  assert.ok(m, '没找到静态资源那条正则，是不是改写法了？')
  const re = new RegExp(m[1].slice(1, -1))
  assert.ok(re.test('/ui/agents.js'), 'pages.mjs 的白名单没放行 /ui/agents.js')
  assert.ok(re.test('/ui/swipe.js'), '顺带确认原有的没被改坏')
})

test('agents.js 的两张表覆盖了代码里真实存在的枚举', async (t) => {
  const shared = read(SHARED)
  const ctx = vm.createContext({})
  // 顶层 `const` 不会挂到全局对象上（它在脚本自己的词法作用域里），所以在
  // 同一段脚本末尾把要看的东西显式交出来——比改成 var 更不打扰真实代码
  const win = vm.runInContext(
    `${shared}\n;({ AGENT_LOGOS, STATE_LABEL, stateLabel })`,
    ctx,
  )

  /**
   * 已知没有 logo 的后端。
   *
   * 现在是**空的**——codex 曾经在这里，理由是「仓库里没有 OpenAI 的矢量素材，
   * 而凭记忆手写一段 SVG path 的失败方式是渲染出一团乱线」。素材后来拿到了
   * （chatgpt.com 的 favicon，内联进 ui/agents.js），所以那一行删了。
   *
   * 集合留着而不是把整条断言改掉：下一个后端接进来时，它要么带 logo，
   * 要么在这里留下一行看得见的缺口，两条路都比「断言悄悄放行」强。
   */
  const NO_LOGO = new Set([])

  await t.test('每个后端都有 logo（已知缺口除外）', () => {
    for (const key of Object.keys(AGENTS)) {
      if (NO_LOGO.has(key)) continue
      assert.ok(win.AGENT_LOGOS[key],
        `${key} 没有 logo。缺了不会报错，只是名字前面空一块——但那正是`
        + `「这条是谁跑的」最该一眼看出来的地方`)
    }
  })

  await t.test('白名单本身不许长草', () => {
    // 给一个已经补上 logo 的后端留着豁免，等于把这条断言对它永久关掉
    for (const key of NO_LOGO) {
      assert.ok(AGENTS[key], `NO_LOGO 里的 ${key} 已经不是一个后端了，删掉这一行`)
      assert.ok(!win.AGENT_LOGOS[key], `${key} 已经有 logo 了，把它从 NO_LOGO 里删掉`)
    }
  })

  await t.test('每一档状态都有中文名', () => {
    for (const state of Object.values(STATE)) {
      assert.ok(win.STATE_LABEL[state],
        `状态 ${state} 没有中文名。stateLabel 会原样回退成英文，`
        + `界面上就会冒出一个跟别处风格不一样的词`)
    }
  })

  await t.test('已请求取消，在它落地之前也要说出来', () => {
    // 取消从点下到生效之间隔着一个拦截点。这一段不说话的话，界面看起来
    // 就是「点了没反应」——而它其实已经生效了，只是还没到时候
    const run = { state: 'Running', control: 'cancelled' }
    assert.equal(win.stateLabel('Running', run), '取消中')
    assert.equal(win.stateLabel('Paused', { state: 'Paused', control: 'cancelled' }), '取消中')

    // 但回合自己跑完之后不许再说：标记还留着（留给下一个拦截点），
    // 而那一轮已经没人取消得了了
    assert.equal(win.stateLabel('Done', { state: 'Done', control: 'cancelled' }), '已完成')
    assert.equal(win.stateLabel('Idle', { state: 'Idle', control: 'cancelled' }), '空闲')
  })

  await t.test('Waiting Input 和 Idle 不是同一句话', () => {
    // 拆这一档的全部意义就在于这两个词不一样：一个「不用管」，一个「在等你」
    assert.notEqual(win.STATE_LABEL['Waiting Input'], win.STATE_LABEL['Idle'])
  })

  await t.test('Paused 在没真停住时说的是另一个词', () => {
    // pause 点下去状态就翻成 Paused，可 agent 还在跑手头这一步，
    // 要等下一个 PreToolUse 才真停住（src/control.mjs）。中间这段
    // 时间说「已暂停」是假的——held 是服务端给的那半个信号。
    assert.equal(win.stateLabel('Paused', { held: true }), '已暂停')
    assert.notEqual(win.stateLabel('Paused', { held: false }), '已暂停')
    // 不传会话时退回单纯查表，别让调用方被迫编一个假的 held
    assert.equal(win.stateLabel('Paused'), '已暂停')
  })
})

/**
 * 渲染 `sub_state` / `state` 的地方**必须过那张表**，不能直接 esc 原值。
 *
 * 抓到的实例：home.html 的主控台写 `esc(s0.sub_state)`，于是屏幕上是
 * `Editing`，而正下方的会话卡片写着「编辑中」——**同一个会话、同一屏、
 * 两种叫法**。这个文件开头那段讲的就是这类事故，可它只钉了「表定义在一处」，
 * 没钉「用到的地方都去查表」，于是漏了这一处。
 *
 * 加 'Using Skill' 那一档时才被看见：英文夹在中文里太扎眼，而
 * Editing / Thinking 长得像专有名词，错了好久没人当回事。
 */
test('渲染状态名的地方都查表，不直接输出原值', async (t) => {
  for (const page of PAGES) {
    const src = read(page)
    await t.test(page, () => {
      /*
       * 找 `esc(<任意>.sub_state)` 和 `esc(<任意>.state)` 这种裸输出。
       * 查表的写法是 esc(subStateLabel(x)) / esc(stateLabel(x, y))，
       * 括号里第一个 token 不会是 `.state` 结尾的表达式。
       *
       * className 那类用法不算——`esc(s.state).replace(...)` 出来的是 CSS
       * 类名，本来就该用英文原值。所以只在**没有紧跟 .replace** 时报错。
       */
      /*
       * 先把注释剥掉再扫。第一版没剥，结果被**修复这个 bug 时写的注释**绊倒
       * ——那段注释里引用了旧代码 `esc(s0.sub_state)` 当反面教材。
       * 一条会因为「你把原因写下来」而变红的测试是坏测试：它逼着人为了让
       * 测试过而删掉解释。
       *
       * `(?<!:)` 是为了别把字符串里的 `http://` 当成行注释开头。
       */
      const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(?<!:)\/\/[^\n]*/g, ' ')
      const bare = [...code.matchAll(/esc\(\s*([\w.?[\]]*\.(?:sub_state|state))\s*\)(\s*\.replace)?/g)]
        .filter((m) => !m[2])
        .map((m) => m[1])
      assert.deepEqual(bare, [],
        `${page} 直接输出了 ${bare.join(', ')} —— 该用 stateLabel() / subStateLabel()，` +
        `否则同一个状态在这一页和别处会有两种叫法`)
    })
  }
})
