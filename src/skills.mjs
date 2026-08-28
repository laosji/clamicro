import { readdirSync, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 这台机器上有多少个 skill。
 *
 * ## 为什么这个函数返回的是**两个数**，不是一个
 *
 * 「已安装」在盘上根本不是一个数。实测这台机器：
 *
 *   ~/.claude/skills/*                      4   ← 你自己装的
 *   已启用插件带的                          30   ← 得先看 enabledPlugins
 *   plugins/cache/** 里全部 SKILL.md       48   ← 含没启用的插件
 *   plugins/marketplaces/** 里的           31   ← **商店目录，压根没装**
 *   盘上 SKILL.md 总数                     83   ← 上面这些一锅烩，纯属胡说
 *
 * 五个数都能从盘上算出来，只有前两个是真的。
 *
 * （第一个数是 4 不是 5：`ls ~/.claude/skills` 有 5 个目录，其中一个没有
 * SKILL.md——它不是 skill。**判据得是那个文件在不在，不是目录数**。）而合成一个总数之后，屏幕上就
 * 再也分不出「你自己的那 5 个还在不在」和「插件那 30 个还在不在」——那是
 * 两件独立会坏的事。
 *
 * ## 为什么每一档要能返回 null
 *
 * **`0` 和「数不出来」必须分得开。** 插件那一档要穿
 * `plugins/cache/<市场>/<插件>/<版本>/**\/skills/`，那是 Claude Code 的内部
 * 布局，没有版本承诺——跟 codex 的 rollout 一个性质。哪天它改了目录形状，
 * 这里会数到 0，而屏幕上「插件 0」和「你的插件真的一个 skill 都没带」长得
 * 一模一样。
 *
 * 这是这个仓库反复踩的同一类坑：**故障被显示成「正常但没有内容」**
 * （agentsSeen 那段注释、QUOTA.NONE 那段注释说的都是这件事）。所以认不出
 * 布局就回 null，让界面说「数不出来」，而不是替它编一个 0。
 *
 * ## 项目级 skill 不在这里
 *
 * `<cwd>/.claude/skills/` 是**跟着会话走**的，不属于「这台机器」。把它加进
 * 一个全局数字，那个数字就会随着你打开哪个项目而变，而它旁边没有任何东西
 * 解释为什么。要显示的话该显示在会话页上，那里才有 cwd。
 *
 * 所以这个函数的两个字段都带**限定词**（你的 / 插件），不叫「全部」——
 * 一个不声称涵盖全部的数字，漏掉一档不算撒谎。
 */

/** 一个目录下有几个直接子目录带 SKILL.md。不递归——skill 就是一层。 */
function countSkillDirs(dir) {
  /**
   * **「目录不存在」和「读不动」是两回事。**
   *
   * 这两种原来都回 null——注释里甚至把它们并列写着，却给了同一个值。
   * 后果是：任何一个**还没装过 skill 的人**（`~/.claude/skills` 压根不存在，
   * 那是全新安装的常态）首页上会永远挂着一句「你的 skill 数不出来」。
   * 那读起来像故障，而事实只是「你还没装过」。
   *
   *   目录不存在   → 你一个都没装 → **0**，正常
   *   存在但读不动 → 真的数不出来 → null，界面照实说
   *
   * 这正是这个文件顶上那条「0 和数不出来必须分得开」，而我写的时候把它并了。
   * 分得开的方向也要对：**把「没装」说成「数不出来」，和把「数不出来」说成
   * 「0」一样是撒谎**，只是方向相反。
   */
  if (!existsSync(dir)) return 0
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return null // 存在却读不动（权限）：这才是真的数不出来
  }
  let n = 0
  for (const e of entries) {
    if (e.isDirectory() && existsSync(join(dir, e.name, 'SKILL.md'))) n++
  }
  return n
}

/**
 * 一个插件带的 skill 目录。**只认插件根目录下的 `skills/`，不递归。**
 *
 * 第一版是往下找三层、凡是叫 `skills` 的目录都算。实测当场多数出 7 个：
 * vercel 0.45.1 底下有**两个** skills 目录——
 *
 *   <版本>/skills/          30 个  ai-gateway、ai-sdk、deploy…  ← 真正对外的
 *   <版本>/.claude/skills/   7 个  release、plugin-audit、benchmark-*
 *                                  ← **插件仓库自己开发用的**，不对外
 *
 * 后面那 7 个在 Claude Code 的 skill 列表里一个都不出现（对得上：那一列
 * 全是 `vercel:xxx`，没有 release / plugin-audit）。递归找等于把别人的
 * 开发脚手架算进你的可用 skill 数——**这正是「多数一档」的典型样子**，
 * 而多数出来的那一档在界面上和真的没有任何区别。
 *
 * 约定从哪来：`.claude-plugin/plugin.json` 显式列了 commands 和 agents，
 * **偏偏没有 skills** —— 说明 skill 是按约定从插件根的 `skills/` 捡的。
 * 所以判据也用那份清单：清单不在，就说明这个目录不是我们以为的形状，
 * 回 null 让界面说「数不出来」，不猜。
 */
function pluginSkillCount(root) {
  // 清单在，才说明这个版本目录确实是一个插件根
  if (!existsSync(join(root, '.claude-plugin', 'plugin.json'))) return null
  return countSkillDirs(join(root, 'skills')) ?? 0
}

/** 版本目录里挑最新的一个。数字段逐段比，比不出来就按名字倒序取第一个。 */
function newestVersion(dirs) {
  if (!dirs.length) return null
  const key = (s) => s.split(/[.-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : -1))
  return dirs.slice().sort((a, b) => {
    const x = key(a), y = key(b)
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (y[i] ?? -1) - (x[i] ?? -1)
      if (d) return d
    }
    return b.localeCompare(a)
  })[0]
}

/**
 * 已启用的插件一共带了多少 skill。
 *
 * **只数 enabledPlugins 里为真的那些。** plugins/cache 里躺着的是下载过的
 * 全部插件（实测 48 个 skill），而真正启用的可能只有一个（实测 1 个）。
 * 数 cache 目录 = 把你没开的东西算进来，那个数字对不上你实际能用的。
 */
function countPluginSkills(home) {
  const settings = join(home, '.claude', 'settings.json')
  let enabled
  try {
    const raw = JSON.parse(readFileSync(settings, 'utf8'))
    enabled = Object.entries(raw?.enabledPlugins ?? {}).filter(([, on]) => on).map(([k]) => k)
  } catch {
    // settings.json 不在（没装过）或读不动 —— 前者是真的 0 个启用的插件，
    // 后者是数不出来。分不开就按数不出来算：宁可说「不知道」也不编一个 0
    if (!existsSync(settings)) return { count: 0, plugins: [] }
    return { count: null, plugins: [] }
  }

  let total = 0
  const named = []
  for (const key of enabled) {
    // 形如 `vercel@claude-plugins-official`
    const at = key.lastIndexOf('@')
    if (at <= 0) continue // 认不得的写法：当没看见（同 codex rollout 的规矩）
    const name = key.slice(0, at)
    const market = key.slice(at + 1)
    const base = join(home, '.claude', 'plugins', 'cache', market, name)
    let versions
    try {
      versions = readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    } catch {
      continue // 启用了但 cache 里没有：多半还没下载完，跳过这一个
    }
    const v = newestVersion(versions)
    if (!v) continue
    // 同一个插件的多个版本目录只算最新那个，否则升级过的插件会被数两遍
    const n = pluginSkillCount(join(base, v))
    if (n === null) {
      // 目录形状不是我们认得的那种。**整个这一档回 null**，不是跳过这一个:
      // 跳过会让总数少掉一截而看不出来，那就又变成「故障显示成正常」了
      return { count: null, plugins: [] }
    }
    if (n) named.push(name)
    total += n
  }
  return { count: total, plugins: named }
}

/**
 * 探测结果缓存多久。
 *
 * detectAgents() 那边是**永久**缓存，理由写着「装新后端属于要重启服务的
 * 操作」。skill 不是：往 ~/.claude/skills 丢一个目录立刻就能用，不重启。
 * 照抄永久缓存的话，你新加一个 skill，手机上那个数字**再也不会变**，
 * 而且没有任何迹象说明它是旧的。
 *
 * 30 秒：够挡住页面刷新带来的重复扫盘，又短到「加完 skill 拉一下就看见」。
 */
const TTL_MS = 30_000
let cache = null

/**
 * @returns {{user:number|null, plugin:number|null, plugins:string[]}}
 *   两个计数各自可能是 null —— null 是「数不出来」，不是 0。见文件头。
 */
export function countSkills({ home = homedir(), now = Date.now() } = {}) {
  if (cache && cache.home === home && now - cache.at < TTL_MS) return cache.value
  const value = {
    user: countSkillDirs(join(home, '.claude', 'skills')),
    ...(() => {
      const { count, plugins } = countPluginSkills(home)
      return { plugin: count, plugins }
    })(),
  }
  cache = { home, at: now, value }
  return value
}

/** 测试用：把缓存清掉，好让同一进程里的多个用例互不干扰。 */
export function resetSkillCache() {
  cache = null
}
