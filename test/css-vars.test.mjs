/**
 * 每个 var(--x) 都得在同一个文件里定义过。
 *
 * 这条是被一个真 bug 推出来的：home.html 的断线卡用了 `var(--accent)`
 * 画重连按钮的底色和「试试另一个地址」的链接色，而 --accent 只在
 * pair.html / onboarding.html 的 :root 里定义过，home.html 里从来没有。
 *
 * CSS 对未定义变量的处理是**静默的**，而且两处的降级方式还不一样：
 *   · background:var(--accent) → 整条声明作废 → 按钮没有底色，
 *     变成一段看不出是按钮的粗体字
 *   · color:var(--accent)      → 回退到 inherit → 链接继承了周围的
 *     灰色，看起来就是普通文字，没人会去点
 *
 * 于是断线态里**唯一的动作**和**唯一的自救出路**同时失效，控制台一声不吭。
 * 这正是最不该出问题的一屏：人已经连不上了，界面还把出路藏起来。
 *
 * 顺带钉住了第二个同类的：settings.html 定义了 --ok/--warn/--accent
 * 却没有 --no，而 `.card.danger.on`（危险开关**被打开**）的红边框、红底、
 * 红勾选框全靠 var(--no)。三条声明一起作废的结果是：开着和关着长得
 * 一模一样。一个安全相关的开关，界面分不出它有没有生效。
 *
 * 校验范围按**引用关系**算，不是一刀切的同文件：
 *   · html —— 自己用的变量必须自己定义（每页各带一份 :root 是这个项目
 *     的现状：零依赖、无构建步骤、样式内联在各自的 html 里）
 *   · 被 <link> 引入的 .css —— 它本来就没有自己的 :root，靠宿主页面提供。
 *     所以要求**每一个**引入它的页面都定义了它用到的变量：漏掉一个，
 *     那一页上的这些声明就静默失效。
 *
 * 盲区（知道，没堵）：只看「这个文件里有没有定义过」，不区分浅色 :root 和
 * `@media (prefers-color-scheme:dark)` 那一份。所以「只在深色块里定义、
 * 浅色漏了」这种半边失效抓不到。要堵得按块解析 CSS，为一个至今没发生过的
 * 变体引入一个真正的解析器不划算——上面那两个真 bug 都是**两边都没定义**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const uiDir = join(root, 'ui')

/** 浏览器自带的、不需要作者定义的变量前缀 */
const BUILTIN = /^--(webkit|moz|ms)-/

const read = (f) => readFileSync(join(uiDir, f), 'utf8')

/** 本文件里定义过的变量。任何选择器块都算——有些状态色挂在 .console.is-wait 这类类上 */
function definedIn(src) {
  return new Set([...src.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]))
}

/** 本文件里用到、且**没写兜底值**的变量。带兜底的放行：那是显式声明过「拿不到也有得用」 */
function usedIn(src) {
  const used = new Set()
  for (const [, name, fallback] of src.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g)) {
    if (!fallback && !BUILTIN.test(name)) used.add(name)
  }
  return used
}

const htmlFiles = readdirSync(uiDir).filter((f) => f.endsWith('.html'))
const cssFiles = readdirSync(uiDir).filter((f) => f.endsWith('.css'))

const fail = (missing, where, how) => assert.deepEqual(
  [...missing], [],
  `${where} 用了未定义的 CSS 变量：${[...missing].join(', ')}\n` +
  '未定义的 var() 不会报错，只会让那条声明静默失效（或回退到 inherit）——\n' + how,
)

for (const file of htmlFiles) {
  test(`${file} 里的 CSS 变量都定义过`, () => {
    const src = read(file)
    const defined = definedIn(src)
    fail(
      [...usedIn(src)].filter((v) => !defined.has(v)),
      file,
      '要么在本文件的 :root 里补上定义，要么写 var(--x, 兜底值)。',
    )
  })
}

for (const css of cssFiles) {
  const hosts = htmlFiles.filter((h) => read(h).includes(css))
  test(`${css} 用到的变量在每个引入它的页面里都有`, () => {
    assert.ok(hosts.length, `${css} 没有任何页面引入——是不是已经没人用了？`)
    const need = usedIn(read(css))
    for (const host of hosts) {
      const defined = definedIn(read(host))
      fail(
        [...need].filter((v) => !defined.has(v)),
        `${css}（在 ${host} 里）`,
        `${css} 没有自己的 :root，靠宿主页面提供——在 ${host} 的 :root 里补上定义。`,
      )
    }
  })
}
