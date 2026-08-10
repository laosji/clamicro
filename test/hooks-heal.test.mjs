/**
 * hooks 自愈。
 *
 * `~/.claude/settings.json` 是**共享文件**：别的工具往里写、用户手改、恢复
 * 备份整个覆盖——我们的条目随时可能消失。而消失之后的表现是
 * **服务照常运行、status 一切正常、就是再也收不到任何东西**，
 * 这是 NOTES 里记的第 2 号复发故障。
 *
 * 这里测两件事，第二件比第一件更重要：
 *   1. 缺了能查出来
 *   2. **「被覆盖」和「你故意卸载」要分得开**——不分的话，卸载完只要服务
 *      还活着，五分钟后 hooks 又自己回来了，那比不自愈更糟。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const HOME = mkdtempSync(join(tmpdir(), 'clamicro-heal-'))
process.env.HOME = HOME
const BIN = join(HOME, '.claude', 'clamicro', 'app', 'bin')
mkdirSync(BIN, { recursive: true })

const { install, uninstall, verifyHooks, HOOK_MAP, SETTINGS_FILE } = await import('../src/settings.mjs')

test.after(() => rmSync(HOME, { recursive: true, force: true }))

const paths = { statusLinePath: join(BIN, 'statusline.sh'), sessionStartPath: join(BIN, 'session-start.sh') }
const fresh = () => {
  writeFileSync(SETTINGS_FILE, '{}')
  install({ port: 8765, ...paths })
}
const settings = () => JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
const save = (o) => writeFileSync(SETTINGS_FILE, JSON.stringify(o, null, 2))

/** 服务里那条判据：还剩至少一条我们的 hook = 被覆盖；一条不剩 = 卸载 */
const looksUninstalled = (v) => v.missing.length >= HOOK_MAP.length + 1

test('装好之后是完整的', () => {
  fresh()
  const v = verifyHooks({ port: 8765 })
  assert.equal(v.ok, true, `装完就报缺失: ${v.missing}`)
  assert.equal(v.statusLine, 'ours')
})

test('部分条目被覆盖 → 查得出来，且不该被当成卸载', async (t) => {
  fresh()
  const j = settings()
  delete j.hooks.Stop
  delete j.hooks.PreToolUse
  save(j)
  const v = verifyHooks({ port: 8765 })

  await t.test('准确列出缺了哪几个', () => {
    assert.equal(v.ok, false)
    assert.deepEqual(v.missing.sort(), ['PreToolUse', 'Stop'])
  })
  await t.test('不满足「卸载」判据', () => {
    assert.equal(looksUninstalled(v), false, '部分缺失被误判成卸载的话就不会自愈')
  })
  await t.test('重装一次即补回', () => {
    install({ port: 8765, ...paths })
    assert.equal(verifyHooks({ port: 8765 }).ok, true)
  })
})

test('SessionStart 单独丢失也要查得出来', () => {
  // 它最要命：没了就连「打开 Claude Code 自动拉起服务」都不发生，
  // 而那本来是唯一会定期跑到的检查点
  fresh()
  const j = settings()
  delete j.hooks.SessionStart
  save(j)
  assert.deepEqual(verifyHooks({ port: 8765 }).missing, ['SessionStart'])
})

test('真的卸载 → 判为卸载，绝不自动补回', async (t) => {
  fresh()
  uninstall({ statusLinePath: paths.statusLinePath })
  const v = verifyHooks({ port: 8765 })

  await t.test('全部缺失', () => {
    assert.equal(v.missing.length, HOOK_MAP.length + 1)
  })
  await t.test('满足「卸载」判据', () => {
    assert.equal(looksUninstalled(v), true,
      '卸载完只要服务还活着 hooks 就自己回来，比不自愈更糟')
  })
})

test('用户自己的 hook 不会被误认成我们的', () => {
  fresh()
  const j = settings()
  j.hooks.Stop = [{ matcher: '*', hooks: [{ type: 'command', command: '/usr/local/bin/my-own-thing.sh' }] }]
  save(j)
  const v = verifyHooks({ port: 8765 })
  assert.ok(v.missing.includes('Stop'), '别人的 hook 占着这个事件，不代表我们的还在')
})

test('statusLine 被别的工具占用时如实报告，不当成缺失去抢', () => {
  fresh()
  const j = settings()
  j.statusLine = { type: 'command', command: '/opt/other-tool/line.sh' }
  save(j)
  assert.equal(verifyHooks({ port: 8765 }).statusLine, 'other')
})
