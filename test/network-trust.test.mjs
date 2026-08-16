/**
 * 网络信任判定。
 *
 * ## 为什么这件事值得测
 *
 * 服务绑到局域网 = 同网段的人都能碰到它，而 HTTP 是明文的。信任机制是
 * 「换到陌生网络就只绑回环」这条承诺的**唯一**执行者：它判错一次，
 * token 就摊在一个你没确认过的网络上，而且你不会收到任何提示。
 *
 * ## 2026-08 架构审查查出的碰撞
 *
 * 原来的指纹是 sha256(网关IP | 网关MAC | 网段 | SSID)。在一种很现实的
 * 组合下它会碰撞：
 *
 *   · 网段 192.168.1.0/24 —— 遍地都是
 *   · 网关 192.168.1.1 —— 同上
 *   · 网关 MAC 00:00:5e:00:01:xx —— VRRP 虚拟 MAC，企业网里**并不唯一**
 *   · SSID 拿不到 —— 新版 macOS 要定位权限；走有线时根本没有
 *
 * 四个字段全都一样 → 指纹相同 → A 公司信任过之后，**B 公司的网络被
 * 当成已信任**，服务照常绑局域网。信任机制被它自己的指纹算法绕过去了。
 *
 * 修法是把 DHCP 侧的三个信号也算进去（服务器身份、搜索域、DNS 列表），
 * 它们不需要任何权限，且在不同组织之间几乎不会全部相同。
 *
 * 跑：node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTrusted, trust } from '../src/network.mjs'

/** 造一个指纹对象。真的 fingerprint() 要读系统，这里只测判定逻辑 */
const fp = (id, legacyId = null, extra = {}) => ({
  id, legacyId, gateway: '192.168.1.1', subnet: '192.168.1', label: '测试网络', ...extra,
})

test('陌生网络一律不信任', async (t) => {
  await t.test('空信任表', () => {
    assert.equal(isTrusted({ trustedNetworks: {} }, fp('aaa')), false)
  })
  await t.test('信任表里是别的网络', () => {
    assert.equal(isTrusted({ trustedNetworks: { bbb: { label: '别的' } } }, fp('aaa')), false)
  })
  await t.test('没联网（id 为 null）时不能算信任', () => {
    // 这条很重要：id 为 null 时若走进「查表」逻辑，undefined 键可能命中意外的值
    assert.equal(isTrusted({ trustedNetworks: { null: { label: 'x' } } }, fp(null)), false)
  })
  await t.test('压根没有 trustedNetworks 字段也不能崩', () => {
    assert.equal(isTrusted({}, fp('aaa')), false)
  })
})

test('升级兼容：指纹算法变强，老用户不该集体掉线', async (t) => {
  await t.test('命中旧指纹也认', () => {
    const cfg = { trustedNetworks: { OLD: { label: '公司', gateway: '192.168.1.1', addedAt: 1 } } }
    assert.equal(isTrusted(cfg, fp('NEW', 'OLD')), true)
  })

  await t.test('只认精确的旧哈希，不做模糊比对', () => {
    // 兼容旧 id 不能变成一条「gateway/subnet 一样就放行」的后门 ——
    // 那正是这次要修掉的弱判定
    const cfg = { trustedNetworks: { SOMETHING_ELSE: { label: '别的', gateway: '192.168.1.1' } } }
    assert.equal(isTrusted(cfg, fp('NEW', 'OLD')), false)
  })

  await t.test('没有 legacyId 时只看新 id', () => {
    const cfg = { trustedNetworks: { OLD: { label: '公司' } } }
    assert.equal(isTrusted(cfg, fp('NEW', null)), false)
  })

  await t.test('是纯函数，不许改调用方的配置', () => {
    // 早先这里会「顺手迁移」：改了内存又不落盘，每个一次性 CLI 进程都白做一遍，
    // 而一个叫 isTrusted 的谓词去改配置本身就是意外行为
    const cfg = { trustedNetworks: { OLD: { label: '公司' } } }
    const snapshot = JSON.stringify(cfg)
    isTrusted(cfg, fp('NEW', 'OLD'))
    assert.equal(JSON.stringify(cfg), snapshot, 'isTrusted 不该有副作用')
  })
})

test('trust() 写入的条目能被 isTrusted 认出来', () => {
  const cfg = {}
  const f = fp('xyz', null, { label: '家里' })
  trust(cfg, f)
  assert.equal(isTrusted(cfg, f), true)
  assert.equal(cfg.trustedNetworks.xyz.label, '家里')
})
