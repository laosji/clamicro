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
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
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

const PAGE = new URL('../docs/index.html', import.meta.url)
const html = readFileSync(PAGE, 'utf8')

/** 页面上怎么写这个时长。和 index.html 里的文案一一对应。 */
function human(ms) {
  const s = ms / 1000
  return s < 60 ? `${s}s` : `${s / 60} min`
}

/** 取出 <td data-pin="名字">文字</td> 里的文字 */
function pinned(name) {
  const m = html.match(new RegExp(`data-pin="${name}"[^>]*>([^<]+)<`))
  assert.ok(m, `docs/index.html 里找不到 data-pin="${name}" 的格子——是被删了还是改名了？`)
  return m[1].trim()
}

test('官网写的「普通操作等多久」= config 的 autoApproveMs', () => {
  const want = human(defaults().approval.autoApproveMs)
  assert.equal(
    pinned('autoApprove'), want,
    `官网说普通操作等 ${pinned('autoApprove')}，代码默认是 ${want}。改了默认值要同步改 docs/index.html。`,
  )
})

test('官网写的「高危等多久」= config 的 timeoutMs', () => {
  const want = human(defaults().approval.timeoutMs)
  assert.equal(
    pinned('highRiskTimeout'), want,
    `官网说高危等 ${pinned('highRiskTimeout')}，代码默认是 ${want}。改了默认值要同步改 docs/index.html。`,
  )
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
  assert.equal(
    pinned('version'), `v${pkg.version}`,
    `官网徽章写着 ${pinned('version')}，包是 ${pkg.version}。\n` +
    '修：node scripts/sync-plugin-versions.mjs',
  )
})

test('官网写的 Node 版本 = package.json 的 engines', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const floor = pkg.engines.node.replace(/[^\d.]/g, '').split('.')[0]
  assert.ok(
    html.includes(`Node ${floor}+`),
    `官网上没有「Node ${floor}+」。package.json 的 engines 是 ${pkg.engines.node}，两边要对上。`,
  )
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
test('官网不加载任何第三方资源', () => {
  const loaders = [...html.matchAll(/<(?:script|link|img)\b[^>]*\b(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => /^(https?:)?\/\//.test(u))

  assert.deepEqual(
    loaders, [],
    `页面在加载外部资源：${loaders.join('、')}。零依赖是这个产品的卖点，官网自己要先做到。`,
  )
})
