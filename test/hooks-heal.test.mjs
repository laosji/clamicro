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
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
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

// ---------------------------------------------------------------------------
/**
 * 2026-08 架构审查：自愈死循环 + 假成功。
 *
 * 触发条件：用户把某个 hook 事件手写成了**非数组**（对象、字符串）。
 * install 对这种只能 skip，于是 verifyHooks 永远报它 missing，
 * 而自愈是 5 分钟一轮——每轮都 backup + writeFileSync：
 *
 *   · 一天 288 个 settings.json.bak-*，无上限
 *   · 每轮推一条「hooks 已修复」通知，而一个字节都没修好
 *
 * 「说自己修好了但其实没修」比「没修」危险：后者你会去查，前者不会。
 */
test('修不好的条目不会造成反复写盘', async (t) => {
  writeFileSync(SETTINGS_FILE, JSON.stringify({ hooks: { PreToolUse: { 手写成了: '对象' } } }, null, 2))

  const first = install({ port: 8765, ...paths })
  await t.test('第一轮确实要写（其它事件是真的补上了）', () => {
    assert.notEqual(first.unchanged, true)
  })

  await t.test('之后每一轮都不再写盘、不再备份', () => {
    for (let i = 0; i < 3; i++) {
      const r = install({ port: 8765, ...paths })
      assert.equal(r.unchanged, true, `第 ${i + 2} 轮仍在写盘 —— 备份会无限堆积`)
      assert.equal(r.backupPath, null, '没有改动就不该产生备份文件')
    }
  })

  await t.test('那一项确实修不好，且 install 如实报 skip', () => {
    const r = install({ port: 8765, ...paths })
    const skipped = r.changes.filter((c) => c.kind === 'skip').map((c) => c.event)
    assert.ok(skipped.includes('PreToolUse'), 'install 必须如实说它没改这一项')
    // 修不好就是修不好 —— verifyHooks 不能因为跑过 install 就改口
    assert.ok(verifyHooks({ port: 8765, ...paths }).missing.includes('PreToolUse'))
  })

  await t.test('用户手工改回数组后，自愈就能补上了', () => {
    const s = settings()
    s.hooks.PreToolUse = []
    save(s)
    install({ port: 8765, ...paths })
    assert.equal(verifyHooks({ port: 8765, ...paths }).ok, true)
  })
})

// ---------------------------------------------------------------------------
/**
 * 卸载在**从没装过**的机器上跑。
 *
 * 这是很常见的误用（「我好像装过？先卸一下试试」），而原来这条路会：
 *   · ~/.claude 不存在时抛 ENOENT 裸栈
 *   · 目录存在时**凭空写出一个 settings.json**
 *
 * 「卸载」的正确下界是「什么都没变」，不是「建一个空的」。
 */
test('没有 settings.json 时卸载不创建任何东西', async (t) => {
  const gone = join(HOME, '.claude', 'settings.json')
  rmSync(gone, { force: true })

  await t.test('如实报告「本来就没有」', () => {
    const r = uninstall({ ...paths })
    assert.equal(r.absent, true)
    assert.deepEqual(r.removed, [])
    assert.equal(r.backupPath, null)
  })

  await t.test('绝不凭空创建 settings.json', () => {
    uninstall({ ...paths })
    assert.equal(existsSync(gone), false, '卸载不该产生一个新文件')
  })

  // 收拾干净，别影响同文件里后面的用例
  fresh()
})
