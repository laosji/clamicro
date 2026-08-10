/**
 * 默认值不能被固化进盘。
 *
 * 这条是对着一个已经造成实际后果的 bug 补的：
 *
 * 老的 `saveConfig` 把**整个合并后的配置**写盘。于是用户从没设过的每一个默认值，
 * 都会被 `trust`、配对、换令牌这些日常操作顺手固化进 config.json——实测一个正常
 * 使用了几天的配置里有 27 个键，其中大半用户根本没碰过。
 *
 * 后果是**改 DEFAULTS 对所有已有安装完全无效**。实测：把高危等待从 570s 改成
 * 180s、把 notifyAutoApproved 从 false 改成 true，发布之后没有任何一个老用户
 * 拿到，而 README 已经照着新默认写了——文档和实际行为对不上，而且看不出来。
 *
 * 这和 `bind` 那个查了两天的 bug 是同一个病：**把派生值当成用户意图存下来**。
 * 那次存的是「启动时探测的结果」，这次存的是「当时的默认值」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const HOME = mkdtempSync(join(tmpdir(), 'clamicro-defaults-'))
process.env.HOME = HOME
mkdirSync(join(HOME, '.claude', 'clamicro'), { recursive: true })

const { loadConfig, saveConfig, CONFIG_FILE } = await import('../src/config.mjs')

test.after(() => rmSync(HOME, { recursive: true, force: true }))

const silence = () => {
  const log = console.log
  console.log = () => {}
  return () => { console.log = log }
}
const write = (o) => writeFileSync(CONFIG_FILE, JSON.stringify(o))
const disk = () => JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
const roundTrip = () => {
  const un = silence()
  const c = loadConfig()
  saveConfig(c)
  un()
  return c
}

test('全默认的配置，盘上只留非默认的东西', async (t) => {
  write({})
  roundTrip()
  const d = disk()

  await t.test('token 留着——它不是默认项，是生成出来的状态', () => {
    assert.equal(typeof d.token, 'string')
  })

  await t.test('用户没碰过的默认值一个都不写', () => {
    for (const k of ['hostMode', 'port', 'maxDevices', 'checkUpdates', 'notify', 'approval', 'bind']) {
      assert.equal(k in d, false, `${k} 不该落盘——它等于默认值`)
    }
  })

  await t.test('键数应该很少。27 个键就是这个 bug 的现场', () => {
    assert.ok(Object.keys(d).length <= 3, `实际写了 ${Object.keys(d).length} 个键: ${Object.keys(d)}`)
  })
})

test('用户真正改过的值必须留住', async (t) => {
  write({ hostMode: 'hostname', notify: { macNotify: false }, approval: { autoApproveMs: 0 } })
  roundTrip()
  const d = disk()

  await t.test('非默认值原样保留', () => {
    assert.equal(d.hostMode, 'hostname')
    assert.equal(d.notify.macNotify, false)
    assert.equal(d.approval.autoApproveMs, 0)
  })

  await t.test('同一段里等于默认的兄弟键仍然不写', () => {
    // notify 段里只有 macNotify 是用户改的，onStop / quotaWarnPct 等不该跟着落盘
    assert.deepEqual(Object.keys(d.notify), ['macNotify'])
  })

  await t.test('再读一遍，值没变', () => {
    const un = silence()
    const c = loadConfig()
    un()
    assert.equal(c.hostMode, 'hostname')
    assert.equal(c.notify.macNotify, false)
    assert.equal(c.approval.autoApproveMs, 0)
  })
})

test('不在 DEFAULTS 里的状态一律保留', () => {
  write({
    devices: [{ id: 'a1', name: 'iPhone', token: 'x'.repeat(43) }],
    trustedNetworks: { abc: { label: '网关 1.2.3.4', gateway: '1.2.3.4' } },
    ignoreCwds: ['/tmp/x'],
  })
  roundTrip()
  const d = disk()
  assert.equal(d.devices.length, 1, '配对设备不能被当成默认值抹掉')
  assert.equal(Object.keys(d.trustedNetworks).length, 1, '已信任网络不能丢')
  assert.deepEqual(d.ignoreCwds, ['/tmp/x'])
})

test('改了 DEFAULTS，老配置要能跟上', async (t) => {
  await t.test('2.5.0 之前固化的 timeoutMs=570000 被解冻', () => {
    // 570 秒在 2.5.0 之前**没有任何设置入口**（不在设置页、API 也不收），
    // 所以盘上出现它只可能是旧默认值被固化，不可能是用户的选择
    write({ approval: { timeoutMs: 570_000 } })
    const un = silence()
    const c = loadConfig()
    un()
    assert.equal(c.approval.timeoutMs, 180_000, '应该拿到新默认值')
  })

  await t.test('解冻之后不再落盘', () => {
    write({ approval: { timeoutMs: 570_000 } })
    roundTrip()
    assert.equal(disk().approval?.timeoutMs, undefined)
  })

  await t.test('固化的 notifyAutoApproved=false 同样解冻', () => {
    write({ notify: { notifyAutoApproved: false } })
    const un = silence()
    const c = loadConfig()
    un()
    assert.equal(c.notify.notifyAutoApproved, true)
  })

  await t.test('手改成别的值时尊重用户，不动它', () => {
    // 只认「等于那个旧默认值」这一种情况。300 秒是人挑的，必须留着
    write({ approval: { timeoutMs: 300_000 } })
    const un = silence()
    const c = loadConfig()
    un()
    assert.equal(c.approval.timeoutMs, 300_000)
  })
})
