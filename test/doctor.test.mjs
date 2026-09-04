/**
 * doctor 的两件事：**诊断对不对**，和**报告里有没有不该有的东西**。
 *
 * 第二件比第一件要紧。这份输出的整个用途就是让人原样粘到公开的 issue 里，
 * 一旦漏了令牌或家目录路径，泄漏发生在**用户以为自己在求助**的那一刻，
 * 而且是我们劝他这么做的。所以脱敏这一组用例是钉子，不是覆盖率。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { collect, diagnose, render, maskIp, tildify } from '../src/doctor.mjs'

/** 一台一切正常的机器。各条用例只改自己关心的那一项。 */
const OK = {
  pkgVersion: '2.18.0',
  runtimeVersion: '2.18.0',
  config: {
    port: 8765,
    lanIp: '192.168.1.23',
    devices: [{ id: 'a' }],
    trustedNetworks: { abc: {} },
    token: 'super-secret-token-value-123456',
  },
  appDir: `${homedir()}/.claude/clamicro/app`,
  settingsFile: `${homedir()}/.claude/settings.json`,
  verifyHooks: () => ({ ok: true, missing: [], statusLine: 'ours' }),
  fingerprint: () => ({ id: 'fp1', gateway: '192.168.1.1', mac: 'aa:bb', ssid: '我家的 Wi-Fi', subnet: '192.168.1', weak: false }),
  isTrusted: () => true,
  weakNote: () => null,
  hasDsh: () => false,
  isDshWired: () => false,
  hasCodex: () => false,
  verifyCodex: () => ({}),
  probe: {
    node: () => '22.0.0',
    os: () => '15.0',
    curl: () => true,
    qrencode: () => true,
    listeners: () => ['123'],
    boundAddrs: () => ['127.0.0.1', '192.168.1.23'],
    history: () => ({ approvals: 3, events: 40, lastAt: 1 }),
    settingsExists: () => true,
  },
}

const facts = (over = {}) => collect({
  ...OK,
  ...over,
  config: { ...OK.config, ...(over.config ?? {}) },
  probe: { ...OK.probe, ...(over.probe ?? {}) },
})

test('主机位抹掉，回环原样留着', async (t) => {
  await t.test('普通局域网地址只留网段', () => {
    assert.equal(maskIp('192.168.1.23'), '192.168.1.x')
    assert.equal(maskIp('10.0.0.7'), '10.0.0.x')
  })

  // 抹成 127.0.0.x 的话，「只绑了回环」这条最要紧的判断在报告上就读不出来，
  // 而那正是「手机连不上」最常见的原因
  await t.test('回环和通配一个字都不动', () => {
    for (const a of ['127.0.0.1', '::1', '0.0.0.0', '*']) assert.equal(maskIp(a), a)
  })
})

test('家目录压成 ~', () => {
  assert.equal(tildify(`${homedir()}/.claude/x`), '~/.claude/x')
})

test('报告里不该出现的东西，一样都不出现', async (t) => {
  const out = render(await facts())

  await t.test('没有令牌', () => {
    assert.doesNotMatch(out, /super-secret-token-value-123456/)
  })
  await t.test('没有 SSID', () => {
    // fingerprint 的 label 就是 SSID，顺手带出去是最容易犯的那个错
    assert.doesNotMatch(out, /我家的 Wi-Fi/)
  })
  await t.test('没有家目录真实路径', () => {
    assert.doesNotMatch(out, new RegExp(homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })
  await t.test('没有完整的局域网地址', () => {
    assert.doesNotMatch(out, /192\.168\.1\.23/)
    assert.match(out, /192\.168\.1\.x/, '网段要留着，它能判「只绑了回环吗」')
  })
})

test('七步漏斗只报第一个断掉的地方', async (t) => {
  await t.test('全通时不给结论', async () => {
    assert.equal(diagnose(await facts()), null)
  })

  const cases = [
    ['Node 太低', { probe: { node: () => '16.0.0' } }, 1],
    ['hooks 缺项', { verifyHooks: () => ({ ok: false, missing: ['Stop'], statusLine: 'ours' }) }, 2],
    ['没有局域网地址', { config: { lanIp: null } }, 3],
    ['网络没信任', { isTrusted: () => false }, 3],
    ['服务没跑', { probe: { listeners: () => [] } }, 4],
    ['只绑回环', { probe: { boundAddrs: () => ['127.0.0.1'] } }, 4],
    ['没有设备', { config: { devices: [] } }, 5],
    ['一条事件都没有', { probe: { history: () => ({ approvals: 0, events: 0, lastAt: null }) } }, 7],
  ]
  for (const [name, over, step] of cases) {
    await t.test(`${name} → 第 ${step} 步`, async () => {
      assert.equal(diagnose(await facts(over))?.step, step)
    })
  }

  // 上游断了的时候，下游那几项必然也是坏的（没信任 → 只绑回环 → 没设备 →
  // 没事件）。四条一起报等于让人从四个方向去猜同一个原因
  await t.test('上游断了就不报下游', async () => {
    const d = diagnose(await facts({
      isTrusted: () => false,
      probe: { listeners: () => [], boundAddrs: () => [], history: () => ({ approvals: 0, events: 0, lastAt: null }) },
      config: { devices: [] },
    }))
    assert.equal(d.step, 3, '最上游那一条才是要修的')
  })
})

test('Codex 写进去了但没被信任，要单独说', async () => {
  const d = diagnose(await facts({
    hasCodex: () => true,
    verifyCodex: () => ({ present: true, missing: [], portOk: true, trustSeen: false }),
  }))
  // 这个状态下每一项检查都正常，唯独一条事件都不会来 —— 不专门说，
  // 现场就是「哪儿都没错，但它不工作」
  assert.equal(d.step, 7)
  assert.match(d.what, /信任/)
})

test('没装过也要跑得出来，不能抛', async () => {
  // 「我是不是没装好」正是最需要这条命令的时刻。这时 config 是空的、
  // 服务没跑、探测什么都拿不到 —— 它必须仍然给出一份报告
  const f = await collect({
    pkgVersion: '2.18.0',
    probe: {
      node: () => '22.0.0',
      os: () => { throw new Error('sw_vers 不在') },
      curl: () => { throw new Error('nope') },
      qrencode: () => { throw new Error('nope') },
      listeners: () => { throw new Error('lsof 不在') },
      boundAddrs: () => [],
      history: () => { throw new Error('读不到') },
      settingsExists: () => false,
    },
  })
  const out = render(f)
  assert.match(out, /### clamicro doctor/)
  assert.equal(diagnose(f).step, 2, '没有 settings.json 就是卡在第 2 步')
})
