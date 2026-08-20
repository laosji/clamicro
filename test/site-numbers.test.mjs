/**
 * 官网上的数字必须和代码里的默认值一致。
 *
 * 为什么需要这个测试：`docs/index.html` 是同一批事实的**第三份副本**。
 * README.md 一份、README.zh-CN.md 一份、官网再一份——改一次默认值要记得
 * 改三处，而这个项目已经证明过记不住（`plugins/README.md` 曾经把「随不随
 * npm 包发布」写成了正好相反的意思，跟着三个版本一起发了出去）。
 *
 * `src/limits.mjs` 顶上那段注释讲的是同一件事：同一个外部事实被三处各自
 * 写了一遍，哪天要改就得同时找到三处，漏一处的后果是静默出错。那次的解法
 * 是把事实收进一个模块。这里收不了——HTML 是给人看的静态页——所以退而求
 * 其次：**允许重复，但让机器盯着**。
 *
 * 官网上的其他内容一律不在这里断言。规矩是「官网不复述 README 已有的内容」，
 * 只有这几个数字是例外（它们是理解产品行为的最小必要信息），所以只钉它们。
 *
 * 页面里用 data-pin="..." 标出来，是为了让改 HTML 的人一眼看到这几个格子
 * 是被钉住的，而不是等 CI 红了才知道。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * 拿「纯默认值」的办法和 config-defaults.test.mjs 一样：把 HOME 指到空目录，
 * loadConfig() 读不到任何用户配置，返回的就是 DEFAULTS 合并出来的结果。
 *
 * 不直接 import DEFAULTS 是因为它没导出，而为了一个测试去改 src 的导出面
 * 不值得——loadConfig() 是公开 API，走它更接近「用户实际拿到的默认」。
 */
const HOME = mkdtempSync(join(tmpdir(), 'clamicro-site-'))
process.env.HOME = HOME
mkdirSync(join(HOME, '.claude', 'clamicro'), { recursive: true })

const { loadConfig } = await import('../src/config.mjs')

test.after(() => rmSync(HOME, { recursive: true, force: true }))

/** loadConfig 会打印几行，测试里不需要 */
function defaults() {
  const log = console.log
  console.log = () => {}
  try { return loadConfig() } finally { console.log = log }
}

/**
 * **两版都要查。** 中英双版意味着同一批数字有两份副本，而只钉英文版的话，
 * 中文版可以安静地漂到天荒地老——那正是这个仓库刚修过一轮的病。
 *
 * 加第三版语言时在这里加一行就行；忘了加，下面每条断言都会漏掉它，
 * 所以这个数组本身也被 `两版都在册` 那条钉住。
 */
const PAGES = [
  ['docs/index.html', readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8')],
  ['docs/zh/index.html', readFileSync(new URL('../docs/zh/index.html', import.meta.url), 'utf8')],
]

/** 页面上怎么写这个时长。和 index.html 里的文案一一对应。 */
function human(ms) {
  const s = ms / 1000
  return s < 60 ? `${s}s` : `${s / 60} min`
}

/** 取出某一版页面里 <td data-pin="名字">文字</td> 的文字 */
function pinned(html, name, where) {
  const m = html.match(new RegExp(`data-pin="${name}"[^>]*>([^<]+)<`))
  assert.ok(m, `${where} 里找不到 data-pin="${name}" 的格子——是被删了还是改名了？`)
  return m[1].trim()
}

test('官网写的「普通操作等多久」= config 的 autoApproveMs', () => {
  const want = human(defaults().approval.autoApproveMs)
  for (const [where, html] of PAGES) {
    assert.equal(
      pinned(html, 'autoApprove', where), want,
      `${where} 说普通操作等 ${pinned(html, 'autoApprove', where)}，代码默认是 ${want}。改了默认值两版都要改。`,
    )
  }
})

test('官网写的「高危等多久」= config 的 timeoutMs', () => {
  const want = human(defaults().approval.timeoutMs)
  for (const [where, html] of PAGES) {
    assert.equal(
      pinned(html, 'highRiskTimeout', where), want,
      `${where} 说高危等 ${pinned(html, 'highRiskTimeout', where)}，代码默认是 ${want}。改了默认值两版都要改。`,
    )
  }
})

/**
 * 徽章是「这项目还活着吗」的唯一信号，写错比不写更糟：一个停在 2.14 的号
 * 会让人以为项目荒废了，而实际上那两天发了六个版本。
 *
 * 修的办法不是手改页面，是 `node scripts/sync-plugin-versions.mjs`——
 * 和插件版本号走同一条路。
 */
test('官网 Hero 的版本徽章 = package.json 的 version', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  for (const [where, html] of PAGES) {
    assert.equal(
      pinned(html, 'version', where), `v${pkg.version}`,
      `${where} 徽章写着 ${pinned(html, 'version', where)}，包是 ${pkg.version}。\n` +
      '修：node scripts/sync-plugin-versions.mjs',
    )
  }
})

test('官网写的 Node 版本 = package.json 的 engines', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const floor = pkg.engines.node.replace(/[^\d.]/g, '').split('.')[0]
  for (const [where, html] of PAGES) {
    assert.ok(
      html.includes(`Node ${floor}+`),
      `${where} 上没有「Node ${floor}+」。package.json 的 engines 是 ${pkg.engines.node}，两边要对上。`,
    )
  }
})

/**
 * 页面不许往外发请求。
 *
 * 这个产品的全部主张是「控制面不出局域网、不联网、不上报」。一个替它宣传的
 * 页面如果自己去拉 CDN 的字体和统计脚本，那句话当场就不成立了——而且这种事
 * 通常不是有意加的，是某次「顺手加个字体」带进来的。
 *
 * 例外：README 和 npm 的链接、og:image 指向 GitHub 的图。那些是 <a href> 和
 * 元数据，不是页面加载时发出去的请求。
 */
/**
 * `<link>` 里只有一部分 rel 会真的发请求。hreflang 的 alternate 和 canonical
 * 是给爬虫看的元数据，指向本站自己的绝对地址，不构成任何加载。
 *
 * 名单是**豁免**而不是**筛选**：写死「哪些不发请求」，其余一律照查。反过来写
 * （只查 stylesheet/preload/icon…）的话，哪天有人加个没见过的 rel，测试会安静
 * 地放过去——这个项目对「安静地放过去」有明确态度。
 *
 * `<source srcset>` 也在册：加 WebP 的 <picture> 之后，一个指向 CDN 的 source
 * 会绕过只查 img/script/link 的旧写法，而它是实打实要发请求的。
 */
const NON_FETCHING_REL = ['alternate', 'canonical']

test('官网不加载任何第三方资源', () => {
  for (const [where, html] of PAGES) {
    const loaders = [...html.matchAll(/<(script|link|img|source)\b([^>]*)\b(?:src|href|srcset)="([^"]+)"/g)]
      .filter(([, tag, attrs]) => {
        if (tag !== 'link') return true
        const rel = (attrs.match(/\brel="([^"]*)"/) || [])[1] || ''
        return !NON_FETCHING_REL.includes(rel.trim().toLowerCase())
      })
      .map((m) => m[3])
      .filter((u) => /^(https?:)?\/\//.test(u))

    assert.deepEqual(
      loaders, [],
      `${where} 在加载外部资源：${loaders.join('、')}。零依赖是这个产品的卖点，官网自己要先做到。`,
    )
  }
})

/**
 * 上面每条断言都在 PAGES 上循环，所以**漏登记一版**是唯一能绕过全部检查的方式：
 * 新加的语言版本不在册，它想写什么数字都行，测试全绿。
 *
 * 所以这里反过来查文件系统：docs/ 下每一个 index.html 都必须在 PAGES 里。
 */
test('每一版页面都在 PAGES 里登记了', () => {
  const docs = new URL('../docs/', import.meta.url)
  const found = []
  const walk = (dir, prefix) => {
    for (const e of readdirSync(new URL(dir, docs), { withFileTypes: true })) {
      if (e.isDirectory()) walk(`${e.name}/`, `${prefix}${e.name}/`)
      else if (e.name === 'index.html') found.push(`docs/${prefix}${e.name}`)
    }
  }
  walk('', '')

  const registered = PAGES.map(([where]) => where)
  assert.deepEqual(
    found.sort(), registered.sort(),
    '有页面没在 PAGES 里登记——没登记的那版不受任何断言约束，数字可以随便漂。\n' +
    `文件系统里有：${found.join('、')}\nPAGES 里写了：${registered.join('、')}`,
  )
})
