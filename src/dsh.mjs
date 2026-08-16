/**
 * 把 clamicro 的两个 DSH 插件接进本机的 DeepSeek Harness。
 *
 * 为什么这段代码存在：clamicro 声称支持多模型，UI 也按多模型做了，但让 DSH
 * 真正能工作的那块（桥接插件）原来不在 npm 包里——用户得自己克隆仓库、手拷
 * 目录、手改 YAML。那不是「一个产品」，那是「一个产品 + 一份施工说明」。
 *
 * 两个插件：
 *   · clamicro-dsh-bridge —— **必需**。没有它，DSH 的事件一条都到不了 clamicro。
 *   · dsh-pet-cat         —— 可选。网页上的入口，点一下开手机看板/配对二维码。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeAtomic } from './atomic.mjs'

export const DSH_HOME = join(homedir(), '.dsh')
export const PROFILES = join(DSH_HOME, 'profiles')
export const MODULES = join(PROFILES, 'node_modules')
export const PATCH_FILE = join(PROFILES, 'web', 'cordis.patch.yml')

/** 插件名 → 补丁层里的 id。id 和名字都要唯一，摘除时按 name 匹配。 */
export const PLUGINS = [
  { dir: 'dsh-bridge', name: 'clamicro-dsh-bridge', id: 'clamicro-bridge', required: true },
  { dir: 'dsh-pet-cat', name: 'dsh-pet-cat', id: 'pet-cat', required: false },
]

/**
 * 这台机器上有没有 DSH。
 *
 * 判据是 `~/.dsh/profiles` 而不是 `~/.dsh`：后者可能只是个空壳（装过又删、
 * 或者别的工具建的）。profiles 存在才说明 DSH 真的跑起来过。
 */
export function hasDsh() {
  try { return statSync(PROFILES).isDirectory() } catch { return false }
}

/** 插件源目录（包内的 plugins/）。传 HERE 进来，避免这个模块自己去猜安装路径。 */
export function sourceDir(here, dir) {
  return join(here, 'plugins', dir)
}

/**
 * 只拷插件 package.json 里 files 声明的东西（lib/ + README），不拷 dev/。
 *
 * 一定要**按目录逐层建**再拷文件：这里踩过一次坑——`cp a b ~/dir/` 把
 * client.js 放到了包根目录而不是 lib/，DSH 于是一直在发旧 bundle，
 * 而文件时间戳看起来是新的，查了很久。
 */
function copyTree(from, to) {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.name === 'dev' || entry.name === 'node_modules') continue
    const src = join(from, entry.name)
    const dst = join(to, entry.name)
    if (entry.isDirectory()) copyTree(src, dst)
    else writeAtomic(dst, readFileSync(src))
  }
}

/** 补丁层里要插的那几行。缩进跟 DSH 自己生成的格式一致。 */
function insertRows(port) {
  return [
    '    - id: pet-cat',
    '      name: dsh-pet-cat',
    '    - id: clamicro-bridge',
    '      name: clamicro-dsh-bridge',
    '      config:',
    `        origin: 'http://127.0.0.1:${port}'`,
    '        approve: true',
    "        askTools: ['bash']",
  ]
}

const FRESH_PATCH = (port) => [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# a top-level YAML array of loader patch entries (id-targeted config',
  '# overrides, disables, and insert lists; `!!js` expressions allowed).',
  '- insert:',
  ...insertRows(port),
  '',
].join('\n')

/**
 * 往补丁层里加我们那几行。
 *
 * **这里没有 YAML 解析器**（这个项目零依赖），所以一切按行做，而且极度保守：
 *   · 文件不存在  → 写一份全新的，内容我们完全知道
 *   · 已经有我们的名字 → 什么都不做（幂等，重复安装不会写重）
 *   · 有 `- insert:` → 在它下一行插入我们的行
 *   · 有文件但没有 `- insert:` → **不猜**，返回 manual，让调用方把行打出来给人自己贴
 *
 * 最后一条是关键：改不认识的 YAML 比不改危险得多。写坏了 DSH 整个 profile
 * 都起不来，而用户根本不会想到是装 clamicro 弄的。
 */
export function patchProfile(port, {
  read = readFileSync,
  write = writeAtomic,
  exists = existsSync,
  mkdir = (d) => mkdirSync(d, { recursive: true }),
} = {}) {
  const rows = insertRows(port)

  /**
   * exists 和 mkdir 也要能注入。
   *
   * 原来这两个是直连真实文件系统的，只有 read/write 可换——于是在一台没有
   * ~/.dsh 的机器上跑这套测试，会**真的创建** ~/.dsh/profiles/web。
   * 这和 removePlugins 的 rmSync 打到真实文件系统是同一个错，上次只修了那一半。
   */
  if (!exists(PATCH_FILE)) {
    mkdir(join(PROFILES, 'web'))
    write(PATCH_FILE, FRESH_PATCH(port))
    return { action: 'created' }
  }

  const text = read(PATCH_FILE, 'utf8')
  if (PLUGINS.every((p) => text.includes(p.name))) return { action: 'already' }

  const lines = text.split('\n')
  const at = lines.findIndex((l) => /^\s*-\s*insert:\s*$/.test(l))
  if (at === -1) return { action: 'manual', rows }

  // 只插我们还没有的那两块，避免一个装过一个没装时写重
  const add = []
  if (!text.includes('dsh-pet-cat')) add.push(...rows.slice(0, 2))
  if (!text.includes('clamicro-dsh-bridge')) add.push(...rows.slice(2))

  lines.splice(at + 1, 0, ...add)
  const next = lines.join('\n')

  // 写之前自检：插完还得像原来那个形状，否则宁可让人自己来
  if (!/^\s*-\s*insert:/m.test(next) || !next.includes('clamicro-dsh-bridge')) {
    return { action: 'manual', rows }
  }
  write(PATCH_FILE, next)
  return { action: 'patched', backup: null }
}

/**
 * 装插件文件。返回装了哪些。
 *
 * 源目录不见了要**炸**，不能静默跳过。
 *
 * 静默跳过的后果是：一个文件都没拷，补丁层却照样写上了，界面还报告
 * 「✓ 已接上」——然后 DSH 下次启动去加载一个根本不存在的模块。这就是
 * 这个项目一路在消灭的那种失败：出了事，界面显示一切正常。
 */
export function installPlugins(here) {
  const done = []
  for (const p of PLUGINS) {
    const from = sourceDir(here, p.dir)
    if (!existsSync(from)) {
      if (p.required) throw new Error(`找不到插件源目录 ${from}（这份安装可能不完整）`)
      continue
    }
    copyTree(from, join(MODULES, p.name))
    done.push(p.name)
  }
  return done
}

/**
 * 安装器里那段「问一句、装、改补丁层」的完整流程。
 *
 * 从 install.mjs 里抽出来，是为了**能被断言**。它出过一个真 bug：打印待粘贴
 * 的行时多加了两个空格前缀，屏幕上是 6 空格、文件里要的是 4 空格，照抄正好
 * 破坏那个 `- insert:` 块——而这条路径的全部意义就是「不敢自动改，给你抄本」。
 *
 * 那个 bug 单测 insertRows 抓不到（行本身是对的），只有断言**实际打印出来的
 * 内容**才能抓到。留在 install.mjs 里就只能靠人肉跑一遍安装才看得见。
 *
 * 依赖全部从参数进来（confirm / say / 各个文件操作），所以测试不碰真实环境。
 *
 * @param confirm  (问题, optIn) => Promise<boolean>。optIn=true 表示 --yes 也不替用户答应
 * @param ui       文字装饰。默认全是恒等函数，测试里就能拿到干净的字符串
 */
export async function wireUp({
  here,
  port,
  confirm,
  say,
  ui = {},
  detect = hasDsh,
  install = installPlugins,
  patch = patchProfile,
} = {}) {
  const t = { b: (s) => s, dim: (s) => s, g: (s) => s, y: (s) => s, ...ui }
  if (!detect()) return { action: 'no-dsh' }

  say('')
  say(`  ${t.b('检测到 DeepSeek Harness')} ${t.dim('~/.dsh')}`)
  say(`  ${t.dim('接上之后，DSH 的操作也会走手机审批，首页按模型分开显示。')}`)

  // optIn=true：这会写另一个产品的配置，`--yes` 不该把它捎带过去
  if (!await confirm(`  要现在接上吗？${t.dim('（会写 ~/.dsh/profiles）')}`, true)) {
    say(`  ${t.dim('跳过。以后想接：重跑 npx clamicro install')}`)
    return { action: 'declined' }
  }

  try {
    const done = install(here)
    const r = patch(port)
    if (done.length) say(`  ${t.g('✓')} 插件已装：${done.join('、')}`)

    if (r.action === 'manual') {
      say(`  ${t.y('⚠')} ${PATCH_FILE} 的格式不认识，没敢动。请手动把下面几行加进 ${t.b('- insert:')} 下面：`)
      say('')
      /**
       * **不要给这几行加任何前缀。**
       *
       * YAML 里缩进就是结构。原来写的是 say(`  ${line}`)，屏幕上就成了 6 个
       * 空格而文件里要 4 个，抄下去正好破坏那个块。test/dsh-wire.test.mjs
       * 逐字符钉着这件事。
       */
      for (const line of r.rows) say(line)
      say('')
    } else if (r.action === 'already') {
      say(`  ${t.dim('补丁层里已经有了，没重复写')}`)
    } else {
      say(`  ${t.g('✓')} 补丁层已更新 ${t.dim(PATCH_FILE)}`)
      say(`  ${t.dim('重启 DSH（dsh web）后生效')}`)
    }
    return { action: r.action, installed: done }
  } catch (e) {
    // 接 DSH 失败不该让整个安装失败：Claude Code 那条链路已经装好了
    say(`  ${t.y('⚠ 接 DSH 没成功：')}${e.message}`)
    say(`  ${t.dim('Claude Code 那边不受影响。手动接法见 plugins/README.md')}`)
    return { action: 'failed', error: e.message }
  }
}

/**
 * 摘除：删插件目录 + 把补丁层里我们那几行拿掉。
 *
 * 卸载的正确下界是「什么都没变」。所以只删**我们放进去的**东西，
 * 补丁层里用户自己加的行一律原样保留。
 */
export function removePlugins({
  read = readFileSync,
  write = writeAtomic,
  rm = (d) => rmSync(d, { recursive: true, force: true }),
  exists = existsSync,
} = {}) {
  const removed = []
  for (const p of PLUGINS) {
    const dir = join(MODULES, p.name)
    if (exists(dir)) { rm(dir); removed.push(p.name) }
  }

  let patch = null
  if (exists(PATCH_FILE)) {
    const lines = read(PATCH_FILE, 'utf8').split('\n')
    const kept = []
    let skipping = false
    for (const line of lines) {
      // 我们那几行都挂在 `- id: <我们的 id>` 下面，遇到下一个同级 `- id:` 就停
      if (/^\s*-\s+id:\s*(pet-cat|clamicro-bridge)\s*$/.test(line)) { skipping = true; continue }
      if (skipping) {
        if (/^\s*-\s+id:\s*/.test(line) || /^\S/.test(line)) skipping = false
        else continue
      }
      kept.push(line)
    }
    if (kept.length !== lines.length) {
      write(PATCH_FILE, kept.join('\n'))
      patch = PATCH_FILE
    }
  }
  return { removed, patch }
}
