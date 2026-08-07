/**
 * settings.json 的读写。
 *
 * **这是整个项目里唯一能毁坏用户既有配置的地方。** 服务端出错最多是收不到
 * 通知；这里出错是把别人辛苦配的 hooks 吃掉，而且是静默的——等你发现时
 * 早就覆盖好几轮了。
 *
 * 历史事故：最早用 `jq '.[0] * .[1]'` 深合并。jq 对对象递归、对数组**整体
 * 替换**，于是用户已有的同名事件配置被无声吃掉。现在逐事件手工追加，
 * 这个文件就是防它复发的。
 *
 * 必须在导入之前改 HOME：SETTINGS_FILE 在模块加载时就由 homedir() 算好了。
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const HOME = mkdtempSync(join(tmpdir(), 'clamicro-settings-'))
process.env.HOME = HOME
mkdirSync(join(HOME, '.claude'), { recursive: true })

const FILE = join(HOME, '.claude', 'settings.json')
const { install, uninstall, HOOK_MAP } = await import('../src/settings.mjs')

const PATHS = {
  port: 8765,
  statusLinePath: '/Users/x/.claude/clamicro/app/bin/statusline.sh',
  sessionStartPath: '/Users/x/.claude/clamicro/app/bin/session-start.sh',
}

const write = (o) => writeFileSync(FILE, JSON.stringify(o, null, 2) + '\n')
const read = () => JSON.parse(readFileSync(FILE, 'utf8'))
const clearBackups = () => {
  for (const f of readdirSync(join(HOME, '.claude'))) {
    if (f.includes('.bak-')) rmSync(join(HOME, '.claude', f))
  }
}

beforeEach(clearBackups)
test.after(() => rmSync(HOME, { recursive: true, force: true }))

// ---------------------------------------------------------------------------
test('装到空配置上', () => {
  write({})
  install(PATHS)
  const s = read()
  for (const [event] of HOOK_MAP) {
    assert.ok(Array.isArray(s.hooks[event]), `${event} 应被装上`)
  }
  assert.ok(Array.isArray(s.hooks.SessionStart))
  assert.equal(s.statusLine.command, PATHS.statusLinePath)
})

test('绝不吃掉用户已有的 hook', async (t) => {
  const userHook = {
    matcher: 'Bash',
    hooks: [{ type: 'command', command: '/Users/x/my-audit-script.sh', timeout: 5 }],
  }
  write({
    hooks: { PreToolUse: [userHook], Stop: [{ hooks: [{ type: 'command', command: '/x/notify.sh' }] }] },
    model: 'opus',
    env: { FOO: 'bar' },
  })
  install(PATHS)
  const s = read()

  await t.test('用户的 PreToolUse 原样还在', () => {
    assert.deepEqual(s.hooks.PreToolUse[0], userHook)
  })
  await t.test('我们的追加在后面，不是替换', () => {
    assert.equal(s.hooks.PreToolUse.length, 2)
    assert.match(s.hooks.PreToolUse[1].hooks[0].url, /pre-tool-use/)
  })
  await t.test('用户的 Stop hook 也在', () => {
    assert.equal(s.hooks.Stop[0].hooks[0].command, '/x/notify.sh')
  })
  await t.test('settings 里其他键不受影响', () => {
    assert.equal(s.model, 'opus')
    assert.deepEqual(s.env, { FOO: 'bar' })
  })
})

test('重复安装是更新而不是叠加', () => {
  write({})
  install(PATHS)
  install(PATHS)
  install(PATHS)
  const s = read()
  for (const [event] of HOOK_MAP) {
    const mine = s.hooks[event].filter((g) => g.hooks?.some((h) => h.type === 'http'))
    assert.equal(mine.length, 1, `${event} 装了 ${mine.length} 份`)
  }
  const ss = s.hooks.SessionStart.filter((g) => g.hooks?.some((h) => h.command?.endsWith('session-start.sh')))
  assert.equal(ss.length, 1, 'SessionStart 装了多份')
})

test('换端口时更新 URL 而不是新增一条', () => {
  write({})
  install(PATHS)
  install({ ...PATHS, port: 9999 })
  const s = read()
  const urls = s.hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => h.url)).filter(Boolean)
  assert.equal(urls.length, 1)
  assert.match(urls[0], /:9999\//)
})

test('装 → 卸往返，逐字节复原', async (t) => {
  await t.test('空配置', () => {
    write({})
    const before = readFileSync(FILE, 'utf8')
    install(PATHS)
    uninstall(PATHS)
    assert.equal(readFileSync(FILE, 'utf8'), before)
  })

  await t.test('带用户自有配置', () => {
    write({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/x/audit.sh', timeout: 5 }] }],
        SessionStart: [{ hooks: [{ type: 'command', command: '/x/greet.sh' }] }],
      },
      statusLine: { type: 'command', command: '/x/my-statusline.sh' },
      model: 'opus',
    })
    const before = readFileSync(FILE, 'utf8')
    install(PATHS)
    uninstall(PATHS)
    assert.equal(readFileSync(FILE, 'utf8'), before, '用户配置必须原样回来')
  })
})

test('statusLine 只有一个槽位，不抢用户的', async (t) => {
  await t.test('用户已有别的 → 不覆盖，报 conflict', () => {
    write({ statusLine: { type: 'command', command: '/x/my-statusline.sh' } })
    const { changes } = install(PATHS)
    assert.equal(read().statusLine.command, '/x/my-statusline.sh')
    assert.ok(changes.some((c) => c.kind === 'conflict' && c.event === 'statusLine'))
  })

  await t.test('用户的 statusLine 不会被卸载误删', () => {
    write({ statusLine: { type: 'command', command: '/x/my-statusline.sh' } })
    install(PATHS)
    uninstall(PATHS)
    assert.equal(read().statusLine.command, '/x/my-statusline.sh')
  })

  await t.test('是我们的就更新路径（安装位置变过）', () => {
    write({ statusLine: { type: 'command', command: '/old/clamicro/bin/statusline.sh' } })
    install(PATHS)
    assert.equal(read().statusLine.command, PATHS.statusLinePath)
  })
})

test('遗留形态的识别', async (t) => {
  await t.test('早期把 SessionStart 装成了 http hook —— 要摘掉，否则触发两次', () => {
    write({
      hooks: {
        SessionStart: [{ matcher: '*', hooks: [{ type: 'http', url: 'http://127.0.0.1:8765/hooks/session-start', timeout: 3 }] }],
      },
    })
    install(PATHS)
    const all = read().hooks.SessionStart.flatMap((g) => g.hooks)
    assert.equal(all.filter((h) => h.type === 'http').length, 0, '遗留的 http 条目该被摘掉')
    assert.equal(all.filter((h) => h.command?.endsWith('session-start.sh')).length, 1)
  })

  await t.test('改名前叫 cc-monitor，卸载时也要认得', () => {
    write({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/Users/x/.claude/cc-monitor/bin/session-start.sh' }] }] },
      statusLine: { type: 'command', command: '/Users/x/.claude/cc-monitor/bin/statusline.sh' },
    })
    uninstall(PATHS)
    const s = read()
    assert.ok(!s.hooks?.SessionStart, '旧名字的 hook 也该被摘掉')
    assert.ok(!s.statusLine)
  })
})

test('异常输入不炸也不吞数据', async (t) => {
  await t.test('某个事件已有非数组配置 → 跳过并报告，不改动', () => {
    write({ hooks: { PreToolUse: { weird: true } } })
    const { changes } = install(PATHS)
    assert.deepEqual(read().hooks.PreToolUse, { weird: true }, '不认识的形状不许动')
    assert.ok(changes.some((c) => c.kind === 'skip' && c.event === 'PreToolUse'))
  })

  await t.test('settings.json 不是合法 JSON → 明确报错，不覆盖', () => {
    writeFileSync(FILE, '{ not json')
    assert.throws(() => install(PATHS), /不是合法 JSON/)
    assert.equal(readFileSync(FILE, 'utf8'), '{ not json', '出错时绝不能写入')
  })

  await t.test('卸载一个没装过的配置是无操作', () => {
    write({ model: 'opus' })
    const before = readFileSync(FILE, 'utf8')
    uninstall(PATHS)
    assert.equal(readFileSync(FILE, 'utf8'), before)
  })
})

test('每次写入前都备份', async (t) => {
  await t.test('install 备份', () => {
    write({ model: 'opus' })
    clearBackups()
    const { backupPath } = install(PATHS)
    assert.ok(backupPath && existsSync(backupPath))
    assert.match(readFileSync(backupPath, 'utf8'), /opus/)
  })
  await t.test('uninstall 备份', () => {
    clearBackups()
    const { backupPath } = uninstall(PATHS)
    assert.ok(backupPath && existsSync(backupPath))
  })
  await t.test('dryRun 不写盘也不备份', () => {
    write({ model: 'opus' })
    clearBackups()
    const before = readFileSync(FILE, 'utf8')
    const { backupPath } = install({ ...PATHS, dryRun: true })
    assert.equal(backupPath, null)
    assert.equal(readFileSync(FILE, 'utf8'), before)
  })
})

test('卸载只摘自己的，同组里用户的 hook 留下', () => {
  // 用户和我们的 hook 挤在同一个分组里 —— 最容易连坐的形状
  write({
    hooks: {
      PreToolUse: [
        {
          matcher: '*',
          hooks: [
            { type: 'command', command: '/x/user.sh' },
            { type: 'http', url: 'http://127.0.0.1:8765/hooks/pre-tool-use', timeout: 3 },
          ],
        },
      ],
    },
  })
  uninstall(PATHS)
  const s = read()
  assert.equal(s.hooks.PreToolUse.length, 1)
  assert.deepEqual(s.hooks.PreToolUse[0].hooks, [{ type: 'command', command: '/x/user.sh' }])
})
