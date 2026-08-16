/**
 * 把两个 DSH 插件的版本号对齐到 clamicro 自己的版本。
 *
 * 它们随 clamicro 一起发布、不单独发 npm、也不单独打 tag，所以各自维护一个
 * 版本号只会制造假信息：包里写着 0.2.0，而它实际上是 2.15.0 那次发出去的东西。
 * 排查问题的人拿着 0.2.0 去找变更记录，什么也找不到。
 *
 * 用法：node scripts/sync-plugin-versions.mjs
 * 发版前跑一次；test/plugin-versions.test.mjs 会盯着漂没漂。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

export const PLUGIN_PKGS = [
  'plugins/dsh-bridge/package.json',
  'plugins/dsh-pet-cat/package.json',
]

export const rootVersion = () =>
  JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version

/**
 * 只换 version 那一行，**不整体 JSON.stringify** —— 那会重排键、改缩进，
 * 还会把 dsh-bridge 里那个当注释用的 `_comment` 挪位置。
 *
 * 抽成纯函数是为了能被测试直接调用：测这件事不该需要碰任何文件。
 * （这一课是刚踩出来的：上一版测试自己调 sync() 并写盘，于是断言
 * 「文件没被改」永远成立，还顺手把我埋的变异给修好了。）
 */
export function bumpVersionText(raw, version) {
  const next = raw.replace(
    /("version"\s*:\s*)"[^"]*"/,
    (_m, head) => `${head}${JSON.stringify(version)}`,
  )
  if (JSON.parse(next).version !== version) throw new Error('version 替换失败')
  return next
}

export function sync({ write = true } = {}) {
  const want = rootVersion()
  const changed = []
  for (const rel of PLUGIN_PKGS) {
    const path = join(root, rel)
    const raw = readFileSync(path, 'utf8')
    const pkg = JSON.parse(raw)
    if (pkg.version === want) continue
    changed.push({ rel, from: pkg.version, to: want })
    if (!write) continue
    writeFileSync(path, bumpVersionText(raw, want))
  }
  return { want, changed }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { want, changed } = sync()
  if (!changed.length) console.log(`已经都是 ${want}，无需改动`)
  for (const c of changed) console.log(`${c.rel}: ${c.from} → ${c.to}`)
}
