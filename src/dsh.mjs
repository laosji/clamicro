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
export function patchProfile(port, { read = readFileSync, write = writeAtomic } = {}) {
  const rows = insertRows(port)

  if (!existsSync(PATCH_FILE)) {
    mkdirSync(join(PROFILES, 'web'), { recursive: true })
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
