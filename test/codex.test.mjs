/**
 * Codex 接入。
 *
 * 跟 DSH 那套是同一类危险：这个项目零依赖，**没有 TOML 解析器**，而
 * ~/.codex/config.toml 是用户自己的文件（真机上那份有 MCP server、插件开关、
 * 模型设置几十行）。写坏了 Codex 起不来，而用户根本不会想到是装 clamicro 弄的。
 *
 * 所以这里钉的都是「不能坏」的那几条：
 *   · 块外的字节一个都不动（尤其是追加到末尾不会把别人的表吞掉）
 *   · 幂等 —— 内容没变就不重写（重写会让 Codex 要求重新信任一次 hooks）
 *   · 只剩半截的哨兵块不猜边界，宁可返回 manual
 *   · 摘除只摘我们那一段
 *   · SessionEnd 的超时不许超过 3 秒（Codex 会截断并在用户终端里骂一句）
 *   · 信任提示必须真的被打印出来 —— 那是唯一必须由人完成的一步
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  hookBlock,
  patchConfig,
  unpatchConfig,
  verifyConfig,
  wireUp,
  CODEX_HOOKS,
  BEGIN,
  END,
} from '../src/codex.mjs'

const RELAY = '/Users/x/.claude/clamicro/app/bin/codex-hook.sh'

/** 假文件系统。任何会写盘的调用都得能换掉——理由见 dsh-install.test.mjs 顶上那段。 */
function fake(initial) {
  const box = { text: initial, writes: 0, backups: [] }
  return {
    box,
    read: () => {
      if (box.text === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return box.text
    },
    write: (_p, data) => { box.text = data; box.writes++ },
    exists: (p) => (p.includes('.bak-') ? false : box.text !== null),
    copy: (from, to) => box.backups.push(to),
  }
}

const USER_CONFIG = [
  'model = "gpt-5.5"',
  '',
  '[mcp_servers.figma]',
  'url = "https://mcp.figma.com/mcp"',
  '',
  '[features]',
  'multi_agent = true',
].join('\n')

test('写进去的是 Codex 认得的形状', () => {
  const block = hookBlock(8765, RELAY)
  for (const [event] of CODEX_HOOKS) assert.ok(block.includes(`[[hooks.${event}]]`), `缺 ${event}`)
  assert.ok(block.includes(`command = "${RELAY} permission-request"`))
  assert.ok(block.startsWith(BEGIN))
  assert.ok(block.trimEnd().endsWith(END))
})

test('审批那条的超时必须比 clamicro 自己的时限长', () => {
  // clamicro 的审批最长能挂 570 秒。hook 超时比它短，就会在用户还在读命令的
  // 时候把请求掐掉，而手机上那条审批还挂着——两边状态从此对不上。
  const [, , timeout] = CODEX_HOOKS.find(([e]) => e === 'PermissionRequest')
  assert.ok(timeout > 570, `PermissionRequest 超时 ${timeout}s，不够长`)
})

test('SessionEnd 不许超过 3 秒', () => {
  // Codex 会把这个事件的超时强行截到 3s，并在**用户自己的终端**里打一行
  // warning。那句警告的起因是我们写进去的数字，不该让用户去看。
  const [, , timeout] = CODEX_HOOKS.find(([e]) => e === 'SessionEnd')
  assert.equal(timeout, 3)
})

test('追加到末尾，用户原有配置一字不动', () => {
  const fs = fake(USER_CONFIG)
  const r = patchConfig(8765, RELAY, fs)
  assert.equal(r.action, 'created')
  assert.ok(fs.box.text.startsWith(USER_CONFIG), '用户原文没有原样保留在前面')
  assert.ok(fs.box.text.includes('[[hooks.PreToolUse]]'))
  assert.equal(fs.box.backups.length, 1, '改别人的配置必须先备份')
})

test('重复安装不写重，也不重写', () => {
  const fs = fake(USER_CONFIG)
  patchConfig(8765, RELAY, fs)
  const writes = fs.box.writes
  const r = patchConfig(8765, RELAY, fs)
  // 内容一样就不能再写一次：Codex 的 hook 信任按内容算，
  // 重写等于让用户再点一次「信任」，而这中间 hooks 是失效的
  assert.equal(r.action, 'already')
  assert.equal(fs.box.writes, writes)
  assert.equal(fs.box.text.split('[[hooks.PreToolUse]]').length - 1, 1)
})

test('换端口是替换旧块，不是再加一块', () => {
  const fs = fake(USER_CONFIG)
  patchConfig(8765, RELAY, fs)
  const r = patchConfig(9000, RELAY, fs)
  assert.equal(r.action, 'patched')
  assert.equal(fs.box.text.split(BEGIN).length - 1, 1, '哨兵块出现了不止一次')
  assert.ok(fs.box.text.includes('9000'))
  assert.ok(!fs.box.text.includes('8765'))
  assert.ok(fs.box.text.includes('[mcp_servers.figma]'), '用户的表被弄丢了')
})

test('只剩半截的哨兵块不猜边界', () => {
  // 有人手工删掉了结尾那行。按「从开头删到文件末尾」处理会把他后面写的
  // 配置一起删掉，所以宁可什么都不做，让人自己收拾。
  const broken = `${USER_CONFIG}\n\n${BEGIN}\n[[hooks.PreToolUse]]\n\n[my_own_stuff]\nkeep = true\n`
  const fs = fake(broken)
  const r = patchConfig(8765, RELAY, fs)
  assert.equal(r.action, 'manual')
  assert.equal(fs.box.writes, 0)
  assert.equal(fs.box.text, broken)
})

test('摘除只摘我们那一段', () => {
  const fs = fake(USER_CONFIG)
  patchConfig(8765, RELAY, fs)
  const r = unpatchConfig(fs)
  assert.equal(r.removed, true)
  assert.ok(!fs.box.text.includes('clamicro'))
  assert.ok(fs.box.text.includes('[mcp_servers.figma]'))
  assert.ok(fs.box.text.includes('multi_agent = true'))
})

test('没接过的配置，摘除是彻底的空操作', () => {
  const fs = fake(USER_CONFIG)
  const r = unpatchConfig(fs)
  assert.equal(r.removed, false)
  assert.equal(fs.box.writes, 0)
  assert.equal(fs.box.text, USER_CONFIG)
})

test('verify 把「没看到信任记录」跟「没装」分开报', () => {
  const fs = fake(USER_CONFIG)
  patchConfig(8765, RELAY, fs)

  // hooks 写好了但 Codex 那边还没信任：present 为真、trusted 为假。
  // 这两个必须分开——它们在界面上该说的话完全不同，而现场看起来一模一样
  //（都是「一条事件都收不到」）。
  const before = verifyConfig(8765, fs)
  assert.equal(before.present, true)
  assert.equal(before.trustSeen, false)
  assert.equal(before.ok, false)
  assert.deepEqual(before.missing, [])

  // Codex 信任之后会自己往 config.toml 里写这一段
  fs.box.text += '\n[hooks.state.user]\ntrusted_hash = "abc"\n'
  const after = verifyConfig(8765, fs)
  assert.equal(after.trustSeen, true)
  assert.equal(after.ok, true)
})

test('verify 认得出端口对不上', () => {
  const fs = fake(USER_CONFIG)
  patchConfig(8765, RELAY, fs)
  fs.box.text += '\n[hooks.state.user]\ntrusted_hash = "abc"\n'
  const v = verifyConfig(9000, fs)
  assert.equal(v.portOk, false)
  assert.equal(v.ok, false)
})

test('安装流程必须把「还要去信任一次」说出来', async () => {
  // 这是整条链路上唯一必须由人完成的动作。漏说一句，用户拿到的就是
  // 「装好了、显示正常、一条事件都不来」——正是这个产品一路在消灭的那种失败。
  const lines = []
  const r = await wireUp({
    port: 8765,
    relayPath: RELAY,
    confirm: async () => true,
    say: (s) => lines.push(s),
    detect: () => true,
    patch: () => ({ action: 'created', backup: null }),
  })
  assert.equal(r.action, 'created')
  const all = lines.join('\n')
  assert.ok(all.includes('信任'), '没提信任')
  assert.ok(all.includes('静默'), '没说清楚不信任时是静默跳过')
})

test('写配置失败不能把整个安装带下水', async () => {
    /**
     * 这个调用在安装流程的最末尾。只读的 config.toml、企业管控的 ~/.codex、
     * 只读同步盘，都会让写盘抛 EACCES。异常冒出去的话，用户看到的是一段
     * Node 堆栈，而 hooks 早写好了、服务早起来了、配对地址早打印了——
     * 他会以为整个安装失败，然后去重跑或者卸载。
     * dsh.mjs 的 wireUp 专门包了一层挡这件事，这里必须一样。
     */
  const lines = []
  const r = await wireUp({
    port: 8765,
    relayPath: RELAY,
    confirm: async () => true,
    say: (s) => lines.push(s),
    detect: () => true,
    patch: () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }) },
  })
  assert.equal(r.action, 'failed')
  assert.match(r.error, /EACCES/)
  assert.match(lines.join('\n'), /没成功/, '失败了要说出来，不能装作没发生')
})

test('不接受就什么都不写', async () => {
  let patched = false
  const r = await wireUp({
    port: 8765,
    relayPath: RELAY,
    confirm: async () => false,
    say: () => {},
    detect: () => true,
    patch: () => { patched = true; return { action: 'created' } },
  })
  assert.equal(r.action, 'declined')
  assert.equal(patched, false)
})

test('没有 Codex 就完全不出声', async () => {
  const lines = []
  const r = await wireUp({
    port: 8765,
    relayPath: RELAY,
    confirm: async () => true,
    say: (s) => lines.push(s),
    detect: () => false,
  })
  assert.equal(r.action, 'no-codex')
  assert.equal(lines.length, 0)
})
