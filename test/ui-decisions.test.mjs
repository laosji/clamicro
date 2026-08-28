/**
 * 钉住 `docs/architecture.zh-CN.md` §6.5「界面：每一屏现在是什么形状」。
 *
 * ## 为什么这份文档需要测试
 *
 * 因为**同一个 UI 决定被做过两遍以上**，而那正是 §6.5 存在的理由：
 *
 *   · 「发消息」搬过两次：独立 tab → 时间线下方（f0e6d80）→ 常驻底栏（e70f327）
 *   · skill 计数两步落地：先加上（38a3824），紧接着改成只在空闲显示（9c1c3d8）
 *   · 「让发消息更好找」先做了一颗跳转胶囊，随后整个废掉换成常驻输入框
 *
 * 而这个仓库已经学过一次：**注释拦不住任何东西**（见 ui-shared.test.mjs 开头
 * 那段——两张共享表全靠「改一处要同步另一处」的注释维持一致，然后漂了）。
 * 一份没人检查的设计文档会漂得更快，因为它离代码更远。
 *
 * 所以这里只钉**机械可查的那部分**：三格导航、否决过的说法有没有回来、
 * 文档本身还在不在。判断题（「这个形状对不对」）钉不了，也不该在这里钉。
 *
 * ## 只扫代码，不扫注释
 *
 * 「否决过的」那张表里每一条，代码里多半都有一段注释解释当初为什么否决——
 * 那正是我们希望留下的东西。第一版没剥注释就会被**修复说明**绊倒：
 * ui/agents.js 里写着「不能写『取消中』」，而那句话本身含「取消中」三个字。
 *
 * 一条会因为「你把原因写下来」而变红的测试是坏测试：它逼着人为了让测试过
 * 而删掉解释。ui-shared.test.mjs 里为同一件事栽过一次，这里直接继承那个做法。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

const DOC = 'docs/architecture.zh-CN.md'
const UI = ['ui/home.html', 'ui/session.html', 'ui/approval.html', 'ui/settings.html',
  'ui/agents.js', 'ui/view.js', 'ui/sched.js', 'ui/swipe.js']

/** 剥掉块注释、行注释和 HTML 注释——留下真正会显示给人看的东西 */
const codeOnly = (src) => src
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(?<!:)\/\/[^\n]*/g, ' ')

test('§6.5 这一节还在', () => {
  const doc = read(DOC)
  assert.match(doc, /^## 6\.5 界面：每一屏现在是什么形状$/m,
    `${DOC} 里找不到 §6.5——它是改 UI 之前该读的那一节，删了就等于回到「没人知道现在是什么形状」`)
  for (const h of ['三格导航', '否决过的（别再做回去）', '改 UI 时问自己的三个问题']) {
    assert.ok(doc.includes(h), `§6.5 少了「${h}」小节`)
  }
})

test('导航还是三格，和文档说的一致', () => {
  // 四格试过一次（加历史 tab 时短暂到过四格），手机底部四格偏挤，
  // 把「发消息」并进会话页之后回到三格。再想加第四格，先改 §6.5
  const tabs = [...read('ui/home.html').matchAll(/data-tab="(\w+)"/g)].map((m) => m[1])
  assert.deepEqual([...new Set(tabs)].sort(), ['hist', 'home', 'sess'],
    '导航格数变了。文档 §6.5 说的是三格：首页 / 会话 / 历史——改之前先改文档')
})

/**
 * 「否决过的」那张表：每一条都是**用一次返工换来的**，别再做回去。
 *
 * 左边是不该再出现在界面上的说法，右边是它为什么被换掉。
 * 真要改回去也行——但要连着 §6.5 那张表一起改，而不是悄悄改回来。
 */
const REJECTED = [
  ['加入队列', '从内部机制反推出来的词——得先知道有个队列才知道自己在干嘛。现在叫「发送」'],
  ['取消本轮', '它拦的是下一次工具调用，一个不调工具的回合它碰不到。现在叫「取消下一步」'],
  ['取消中', '那三个字承诺「正在停」，而实际是「已排好，等下一次工具调用」。现在叫「将阻止下一步」'],
  ['发给哪个会话', '发消息独立 tab 的第一步——把你刚有的上下文丢掉再让你重建。已并进会话页'],
]

test('否决过的说法没有回到界面上', async (t) => {
  for (const [word, why] of REJECTED) {
    await t.test(`「${word}」`, () => {
      const back = UI.filter((f) => codeOnly(read(f)).includes(word))
      assert.deepEqual(back, [],
        `${back.join('、')} 里又出现了「${word}」。\n当初否决的理由：${why}\n` +
        `真要改回去就连 ${DOC} §6.5「否决过的」一起改——别悄悄改回来`)
    })
  }
})

test('当前在用的说法还在（否则上面那条会空转通过）', async (t) => {
  // 只钉「否决的不许回来」是不够的：把两边都删光，那条测试一样是绿的。
  // 得同时确认替代品还活着，这条断言才有意义
  const live = [
    ['取消下一步', 'ui/session.html'],
    ['将阻止下一步', 'ui/agents.js'],
    ['发送', 'ui/session.html'],
  ]
  for (const [word, file] of live) {
    await t.test(`${file} 里还有「${word}」`, () => {
      assert.ok(codeOnly(read(file)).includes(word),
        `${file} 里找不到「${word}」——是不是又换说法了？换可以，把 §6.5 一起改`)
    })
  }
})

test('会话页那四条不能动的约束', async (t) => {
  const src = read('ui/session.html')
  const code = codeOnly(src)

  await t.test('送达提示行任何时候都不能省', () => {
    // 聊天的形状自带「按下去对面就收到了」这个承诺，而注入的唯一时机是
    // Stop hook。这一行是唯一拆得掉那个承诺的东西
    assert.match(code, /id="hint"/, '底栏的送达提示行没了')
    assert.match(code, /不会立刻送达/, '送达提示不再说「不会立刻送达」')
    assert.match(code, /会话已经停了|空闲/, '空闲时那一档更响的提示没了')
  })

  await t.test('不支持注入的后端整格不画', () => {
    assert.match(code, /cap\?\.inbox/, '输入框不再按 cap.inbox 决定画不画')
  })

  await t.test('输入框写死在 HTML 里，不由 render 重建', () => {
    // 重建会在用户打字时抢走焦点、把光标弹回句首、在手机上收起键盘
    assert.match(src, /<textarea id="draft"/,
      'textarea 不在 HTML 里了——是不是又改回每次 render 重新生成？那会打断正在打字的人')
  })

  await t.test('断线时不禁用控件', () => {
    // 判据可能是错的：SSE 会被代理 / 移动网络 / 系统休眠单独掐掉，
    // 而普通 HTTP 照样通。按可能错的信号锁人是更糟的选择
    assert.doesNotMatch(code, /offlineSince[^\n]*disabled|disabled[^\n]*offlineSince/,
      '看起来把断线和禁用绑在一起了——§6.5 那四条约束的最后一条说的正是别这么做')
  })
})
