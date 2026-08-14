/**
 * 「当前生效的配置是什么，以及为什么是这个值」。
 *
 * ## 为什么需要它
 *
 * 生效的 25 项里只有个位数写在 config.json 里，**其余全部只存在于源码的
 * DEFAULTS**。`cat config.json` 给出的是一份沉默的谎言：你看到的是「我改过
 * 什么」，而不是「现在按什么在跑」。
 *
 * maxDevices 是活例子——默认 1，配置文件里没有这一项，于是「手机为什么老要
 * 重新扫码」查了半天，答案就是那个看不见的默认值。
 *
 * ## 为什么标来源，而不是只打最终值
 *
 * 「10 秒」和「10 秒 ← 你自己改过」在排查时是两件不同的事：后者说明有人动过手，
 * 前者说明你在跟设计意图较劲。只打最终值只能回答「是多少」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { explainConfig, DERIVED_KEYS } from '../src/config.mjs'
import { readFileSync } from 'node:fs'

const find = (rows, key) => rows.find((r) => r.key === key)

test('四层来源各归各位', async (t) => {
  const cfg = {
    port: 8765,
    hostMode: 'auto',
    approval: { autoApproveMs: 10_000, timeoutMs: 999 },
    lanIp: '192.168.1.42',
  }
  // 盘上只写了这两项
  const disk = { hostMode: 'auto', approval: { timeoutMs: 999 } }
  const rows = explainConfig(cfg, disk)

  await t.test('盘上有 → 配置文件', () => {
    assert.equal(find(rows, 'hostMode').source, '配置文件')
    assert.equal(find(rows, 'approval.timeoutMs').source, '配置文件')
  })

  await t.test('盘上没有、等于默认 → 默认值', () => {
    assert.equal(find(rows, 'approval.autoApproveMs').source, '默认值')
  })

  await t.test('派生字段 → 运行时探测', () => {
    assert.equal(find(rows, 'lanIp').source, '运行时探测')
  })

  await t.test('嵌套的键用点分路径，不丢层级', () => {
    // approval.timeoutMs 和某个顶层 timeoutMs 必须能区分开
    assert.ok(find(rows, 'approval.timeoutMs'))
    assert.equal(find(rows, 'timeoutMs'), undefined)
  })
})

test('CLAMICRO_PORT 覆盖时标成环境变量', () => {
  const old = process.env.CLAMICRO_PORT
  process.env.CLAMICRO_PORT = '9999'
  try {
    // 盘上写着 8765，环境变量赢了。标成「配置文件」会让人跑去改文件，
    // 而改了不生效——那是最耗时的一类排查
    assert.equal(find(explainConfig({ port: 9999 }, { port: 8765 }), 'port').source, '环境变量')
  } finally {
    if (old === undefined) delete process.env.CLAMICRO_PORT
    else process.env.CLAMICRO_PORT = old
  }
})

test('bind 里被探测替换掉的占位符不能标成默认值', () => {
  /**
   * DEFAULTS.bind 是 `['127.0.0.1', null]`，那个 null 是「启动时探测局域网 IP」
   * 的占位符，loadConfig 会换成真实 IP。少了这条判断，它会显示成
   * `[127.0.0.1, 192.168.1.42] 默认值`——一个**不存在于任何默认值里**的数组
   * 被标成默认值。
   *
   * 而 bind 恰恰是这个项目里代价最大的字段：探测结果曾被固化落盘，换网络后
   * EADDRNOTAVAIL，服务只剩回环，而 status 显示一切正常，查了两天。在一个
   * 专门用来止损的诊断命令里把它标错，等于把陷阱又埋一遍。
   */
  const rows = explainConfig({ bind: ['127.0.0.1', '192.168.1.42'] }, {})
  assert.equal(find(rows, 'bind').source, '运行时探测')
})

test('凭证一个字节都不进诊断输出', async (t) => {
  const cfg = {
    token: 'SUPER-SECRET-MASTER',
    devices: [{ id: 'ab12', name: 'iPhone', token: 'SUPER-SECRET-DEVICE' }],
    trustedNetworks: [{ id: 'x', label: '家' }],
    port: 8765,
  }
  const rows = explainConfig(cfg, {})

  await t.test('没有任何一行带凭证键', () => {
    assert.deepEqual(rows.filter((r) => /token|devices|trustedNetworks/.test(r.key)), [])
  })

  await t.test('序列化之后也搜不到明文', () => {
    // 这条命令的输出很可能被人贴进 issue 里
    const dump = JSON.stringify(rows)
    assert.ok(!dump.includes('SUPER-SECRET-MASTER'))
    assert.ok(!dump.includes('SUPER-SECRET-DEVICE'))
  })

  await t.test('正常配置项还在 —— 别把孩子和洗澡水一起倒了', () => {
    assert.ok(find(rows, 'port'))
  })
})

test('persistedPort 是内部记账，不该出现', () => {
  // 它只是「盘上那个端口」，用来防止 CLAMICRO_PORT 的临时覆盖被固化。
  // 列进面向人的配置树既是噪音，又会被标成「运行时探测」——而它不是探测来的
  assert.equal(find(explainConfig({ persistedPort: 8765, port: 9999 }, {}), 'persistedPort'), undefined)
})

test('DERIVED_KEYS 必须和 saveConfig 剥掉的那组一致', () => {
  /**
   * 两处各写一份是有意的（saveConfig 那行解构要保持「一眼看全」，它上面挂着
   * 两天的事故注释）。代价是会漂移：哪天加了新的派生字段却只改一处，
   * 要么它被写进盘里（旧事故重演），要么它在 config 命令里被标成「默认值」。
   */
  const src = readFileSync(new URL('../src/config.mjs', import.meta.url), 'utf8')
  const line = src.match(/export function saveConfig\(config\) \{\s*\n\s*const \{([^}]*)\}/)
  assert.ok(line, '没找到 saveConfig 的解构行，这条测试需要跟着改')
  // `...persist` 是 rest 元素，收的是「剩下的全部」，不是被剥掉的字段
  const stripped = line[1].split(',').map((s) => s.trim()).filter((s) => s && !s.startsWith('...'))
  assert.deepEqual([...stripped].sort(), [...DERIVED_KEYS].sort(),
    'saveConfig 剥掉的字段和 DERIVED_KEYS 对不上了')
})
