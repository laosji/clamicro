/**
 * 「这台机器上有多少个 skill」。
 *
 * 这个数字的全部难点不是怎么数，是**数哪个**。实测同一台机器上，五种数法
 * 给出 4 / 30 / 48 / 31 / 83，而只有前两个是真的：
 *
 *   plugins/marketplaces/** 里那 31 个是**商店目录**，压根没装
 *   plugins/cache/** 里那 48 个含没启用的插件
 *
 * 所以这些用例钉的不是「算得对不对」，是**「有没有把不该算的算进来」**，
 * 以及「数不出来时会不会伪装成 0」——后者是这个仓库反复踩的那一类坑。
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { countSkills, resetSkillCache } from '../src/skills.mjs'

let HOME
beforeEach(() => {
  resetSkillCache()
  HOME = mkdtempSync(join(tmpdir(), 'clamicro-skills-'))
})

const write = (p, body = '') => {
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}
/** 一个用户级 skill */
const userSkill = (name) => write(join(HOME, '.claude', 'skills', name, 'SKILL.md'), '# ' + name)
/** 一个插件版本目录，root 下带 .claude-plugin/plugin.json 才算插件根 */
const plugin = (market, name, version, { skills = [], devSkills = [], manifest = true } = {}) => {
  const root = join(HOME, '.claude', 'plugins', 'cache', market, name, version)
  if (manifest) write(join(root, '.claude-plugin', 'plugin.json'), '{"name":"' + name + '"}')
  else mkdirSync(root, { recursive: true })
  for (const s of skills) write(join(root, 'skills', s, 'SKILL.md'))
  for (const s of devSkills) write(join(root, '.claude', 'skills', s, 'SKILL.md'))
}
const settings = (obj) => write(join(HOME, '.claude', 'settings.json'), JSON.stringify(obj))
const count = () => countSkills({ home: HOME })

// ---------------------------------------------------------------------------
test('用户级：判据是 SKILL.md 在不在，不是目录数', async (t) => {
  await t.test('三个 skill 就是 3', () => {
    for (const n of ['poster', 'ones', 'morning']) userSkill(n)
    assert.equal(count().user, 3)
  })

  /**
   * 真机上撞到的：`ls ~/.claude/skills` 有 5 个目录，其中一个没有 SKILL.md。
   * 按目录数报 5 就多报了一个——而那个目录在界面上和真 skill 长得一样。
   */
  await t.test('有目录但没有 SKILL.md 的不算', () => {
    userSkill('poster')
    mkdirSync(join(HOME, '.claude', 'skills', '半成品'), { recursive: true })
    assert.equal(count().user, 1)
  })

  /**
   * **「目录不存在」和「读不动」是两回事，而这两个都不是同一个答案。**
   *
   * 这条断言原来写的是「目录不存在 → null」。而 `~/.claude/skills` 不存在
   * 正是**全新安装的常态**——于是任何一个还没装过 skill 的人，首页上会永远
   * 挂着一句「你的 skill 数不出来」。那读起来像故障，事实只是「你还没装过」。
   *
   * 把「没装」说成「数不出来」，和把「数不出来」说成「0」一样是撒谎，
   * 只是方向相反。
   */
  await t.test('目录不存在 → 0（你一个都没装），不是「数不出来」', () => {
    assert.equal(count().user, 0)
  })

  await t.test('目录存在但是空的 → 也是 0', () => {
    mkdirSync(join(HOME, '.claude', 'skills'), { recursive: true })
    assert.equal(count().user, 0)
  })
})

test('插件级：只数「启用了的」，且只数插件根的 skills/', async (t) => {
  await t.test('没启用任何插件 → 0（而不是把 cache 里躺着的算进来）', () => {
    settings({ enabledPlugins: {} })
    plugin('mkt', 'vercel', '1.0.0', { skills: ['a', 'b', 'c'] })
    assert.equal(count().plugin, 0)
  })

  await t.test('启用了才算', () => {
    settings({ enabledPlugins: { 'vercel@mkt': true } })
    plugin('mkt', 'vercel', '1.0.0', { skills: ['a', 'b', 'c'] })
    const r = count()
    assert.equal(r.plugin, 3)
    assert.deepEqual(r.plugins, ['vercel'])
  })

  await t.test('值为 false 的不算', () => {
    settings({ enabledPlugins: { 'vercel@mkt': false } })
    plugin('mkt', 'vercel', '1.0.0', { skills: ['a', 'b'] })
    assert.equal(count().plugin, 0)
  })

  /**
   * 真机上多数出来的那 7 个。vercel 0.45.1 底下有**两个** skills 目录：
   *   <版本>/skills/          对外的
   *   <版本>/.claude/skills/  插件仓库自己开发用的（release、plugin-audit…）
   * 后者在 Claude Code 的 skill 列表里一个都不出现。递归找 `skills` 目录
   * 会把别人的开发脚手架算进你的可用 skill 数。
   */
  await t.test('插件仓库自带的 .claude/skills（开发用）不能算进来', () => {
    settings({ enabledPlugins: { 'vercel@mkt': true } })
    plugin('mkt', 'vercel', '1.0.0', {
      skills: ['deploy', 'env'],
      devSkills: ['release', 'plugin-audit', 'benchmark-e2e'],
    })
    assert.equal(count().plugin, 2, '把插件自己的开发 skill 也数进来了')
  })

  await t.test('同一插件多个版本只算最新的，不是相加', () => {
    settings({ enabledPlugins: { 'vercel@mkt': true } })
    plugin('mkt', 'vercel', '0.9.0', { skills: ['old1', 'old2'] })
    plugin('mkt', 'vercel', '0.45.1', { skills: ['a', 'b', 'c'] })
    plugin('mkt', 'vercel', '0.10.0', { skills: ['x'] })
    // 按数字段比，不是字符串比——字符串比会让 0.9.0 赢过 0.45.1
    assert.equal(count().plugin, 3)
  })

  await t.test('插件名里带 @ 也能切对（按最后一个 @ 分）', () => {
    settings({ enabledPlugins: { '@scope/thing@mkt': true } })
    plugin('mkt', '@scope/thing', '1.0.0', { skills: ['a'] })
    assert.equal(count().plugin, 1)
  })
})

/**
 * 这一组是这个模块存在的真正理由。
 *
 * 插件那一档要穿 `plugins/cache/<市场>/<插件>/<版本>/` —— Claude Code 的
 * 内部布局，**没有版本承诺**，跟 codex 的 rollout 一个性质。它哪天变了，
 * 这里必须说「数不出来」，而不是报一个 0：屏幕上「插件 0」和「你的插件真的
 * 没带 skill」长得一模一样，而这两件事该做的处置完全相反。
 */
test('数不出来时不许伪装成 0', async (t) => {
  await t.test('版本目录不是插件根（没有 plugin.json）→ null', () => {
    settings({ enabledPlugins: { 'vercel@mkt': true } })
    plugin('mkt', 'vercel', '1.0.0', { skills: ['a', 'b'], manifest: false })
    assert.equal(count().plugin, null, '布局对不上时应该说不知道，而不是给个数')
  })

  await t.test('settings.json 是坏的 → null', () => {
    write(join(HOME, '.claude', 'settings.json'), '{ 半截')
    assert.equal(count().plugin, null)
  })

  await t.test('settings.json 压根不存在 → 0（那是真的没启用任何插件）', () => {
    // 和上一条的区别是实打实的：没装过 Claude Code 插件 vs 配置文件读坏了
    assert.equal(count().plugin, 0)
  })

  await t.test('启用了但还没下载完 → 跳过它，不拖垮整档', () => {
    settings({ enabledPlugins: { 'vercel@mkt': true, 'other@mkt': true } })
    plugin('mkt', 'vercel', '1.0.0', { skills: ['a'] })
    // other 在 cache 里没有目录
    assert.equal(count().plugin, 1)
  })
})

test('缓存', async (t) => {
  /**
   * detectAgents() 那边是永久缓存（「装新后端要重启服务」）。skill 不是：
   * 往 ~/.claude/skills 丢个目录立刻就能用。照抄永久缓存的话，新加的 skill
   * 在手机上**再也不会出现**，而且看不出那个数字是旧的。
   */
  await t.test('30 秒内不重复扫盘', () => {
    userSkill('a')
    assert.equal(countSkills({ home: HOME, now: 1000 }).user, 1)
    userSkill('b')
    assert.equal(countSkills({ home: HOME, now: 1000 + 29_000 }).user, 1, '缓存内不该重扫')
  })
  await t.test('过了就重新数 —— 新加的 skill 要能出现', () => {
    userSkill('a')
    assert.equal(countSkills({ home: HOME, now: 1000 }).user, 1)
    userSkill('b')
    assert.equal(countSkills({ home: HOME, now: 1000 + 31_000 }).user, 2)
  })
})

test('不含凭证', () => {
  settings({ enabledPlugins: { 'vercel@mkt': true }, token: 'sk-should-never-appear' })
  plugin('mkt', 'vercel', '1.0.0', { skills: ['a'] })
  userSkill('poster')
  // 这个结构要进 /api/config，而那个响应是手写白名单的（见 api-secrets 测试）。
  // 两个整数加一串插件名，不该夹带任何来自 settings.json 的别的东西
  assert.doesNotMatch(JSON.stringify(count()), /sk-|token/i)
})

process.on('exit', () => {
  try { rmSync(HOME, { recursive: true, force: true }) } catch { /* 已经没了 */ }
})
