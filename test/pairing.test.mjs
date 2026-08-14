/**
 * 配对：一次性、限时的二维码，换发每设备独立令牌。
 *
 * 守的是三条**安全性质**，不是接口形状：
 *   · 一次性 —— 用过的配对 id 不能再用（谁先扫谁得，抢跑是可见的失败）
 *   · 限时   —— 60 秒后作废（事后翻到截图里的码一律无效，这是最主要的收益）
 *   · 独立   —— 每设备一个令牌，吊销一台不影响其他
 *
 * 换掉的旧设计里二维码内嵌永久令牌，见过它的人永久有权，且你不会知道。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PairingStore, addDevice, removeDevice } from '../src/auth/pairing.mjs'

test('一次性：扫过就作废', () => {
  const p = new PairingStore()
  const { id } = p.begin()
  assert.equal(p.redeem(id), true)
  assert.equal(p.redeem(id), false, '同一个 id 不得复用——否则截图里的码永远能用')
  assert.equal(p.size, 0)
})

test('限时：60 秒后作废', async (t) => {
  const p = new PairingStore()
  const t0 = 1_000_000
  const { id, ttlMs } = p.begin(t0)
  await t.test('TTL 是 60 秒', () => assert.equal(ttlMs, 60_000))
  await t.test('59 秒时还能用', () => assert.equal(p.redeem(id, t0 + 59_000), true))
  await t.test('过期后作废', () => {
    const q = new PairingStore()
    const { id: id2 } = q.begin(t0)
    assert.equal(q.redeem(id2, t0 + 61_000), false)
  })
  await t.test('过期记录被清理，不占内存', () => {
    const q = new PairingStore()
    q.begin(t0); q.begin(t0)
    assert.equal(q.size, 2)
    q.sweep(t0 + 61_000)
    assert.equal(q.size, 0)
  })
})

test('过期的 id 也算被消费——不给重试的机会', () => {
  const p = new PairingStore()
  const t0 = 1_000_000
  const { id } = p.begin(t0)
  assert.equal(p.redeem(id, t0 + 61_000), false)
  assert.equal(p.size, 0, '兑换过就删，无论过没过期')
})

test('不存在的 id', () => {
  assert.equal(new PairingStore().redeem('nosuchid'), false)
})

test('配对 id 短到能进二维码，且不重复', () => {
  const p = new PairingStore()
  const ids = new Set()
  for (let i = 0; i < 100; i++) {
    const { id } = p.begin()
    assert.ok(id.length <= 16, `太长进不了码: ${id.length}`)
    ids.add(id)
  }
  assert.equal(ids.size, 100)
})

test('设备令牌簿', async (t) => {
  await t.test('每台设备令牌不同——否则吊销一台等于吊销全部', () => {
    const cfg = { maxDevices: 5 }
    const a = addDevice(cfg, { name: 'iPhone' })
    const b = addDevice(cfg, { name: 'iPad' })
    assert.notEqual(a.token, b.token)
    assert.ok(a.token.length >= 43, '32 字节 base64url')
    assert.equal(cfg.devices.length, 2)
  })

  await t.test('按 id 前缀单独吊销，不误伤其他', () => {
    const cfg = { maxDevices: 5 }
    const a = addDevice(cfg, { name: 'iPhone' })
    addDevice(cfg, { name: 'iPad' })
    const r = removeDevice(cfg, a.id)
    assert.equal(r.changed, true)
    assert.equal(cfg.devices.length, 1)
    assert.equal(cfg.devices[0].name, 'iPad')
  })

  await t.test('吊销不存在的设备是无操作', () => {
    const cfg = { maxDevices: 5 }
    addDevice(cfg, { name: 'iPhone' })
    assert.equal(removeDevice(cfg, 'zzzz').changed, false)
    assert.equal(cfg.devices.length, 1)
  })

  await t.test('设备名有兜底，不会出现 undefined', () => {
    assert.equal(addDevice({}, {}).name, '未命名设备')
  })
})

test('设备上限：默认 2，顶掉最旧的', async (t) => {
  /**
   * 这里从 1 改成 2 是**修一个真实故障**，不是放宽策略。
   *
   * 默认 1 的时候，手机和「Mac 上用局域网地址打开的浏览器」会互相顶——
   * 回环免配对，局域网地址不免。于是每次在 Mac 上开一次局域网页面，
   * 手机就掉一次线，表现为「Claude 重启后手机又要扫码」，而原因和重启无关。
   *
   * 让 1 曾经说得通的理由（多一台必然顶掉你 → 异常看得见）已经由
   * confirm.mjs 的 Mac 授权确认承担：每次配对都得有人点「允许」。
   */
  await t.test('手机 + 一台别的，谁都不掉线', () => {
    const cfg = {}
    addDevice(cfg, { name: 'iPhone' })
    const second = addDevice(cfg, { name: 'Mac' })
    assert.equal(cfg.devices.length, 2, '默认 maxDevices=2')
    assert.deepEqual(second.evicted, [], '这一步不该顶掉任何人——就是它在造成「手机总要重扫」')
    assert.deepEqual(cfg.devices.map((d) => d.name), ['iPhone', 'Mac'])
  })

  await t.test('第三台才开始顶，并报告被顶掉的是谁', () => {
    const cfg = {}
    addDevice(cfg, { name: 'iPhone' })
    addDevice(cfg, { name: 'Mac' })
    const third = addDevice(cfg, { name: '别人的手机' })
    assert.equal(cfg.devices.length, 2)
    assert.equal(third.evicted.length, 1)
    assert.equal(third.evicted[0].name, 'iPhone', '必须说出顶掉了谁——调用方要据此发 HUD 和通知')
  })

  await t.test('顶替而不是拒绝：合法用户永远进得来', () => {
    // 拒绝的话，抢先配对的人反而把你锁在外面
    const cfg = { maxDevices: 1 }
    addDevice(cfg, { name: '攻击者' })
    const mine = addDevice(cfg, { name: 'iPhone' })
    assert.equal(cfg.devices[0].id, mine.id, '后来的总能进')
    assert.equal(cfg.devices.length, 1)
  })

  await t.test('显式配 3 就能再多一台', () => {
    const cfg = { maxDevices: 3 }
    addDevice(cfg, { name: 'iPhone' })
    addDevice(cfg, { name: 'iPad' })
    const c = addDevice(cfg, { name: 'Mac' })
    assert.equal(cfg.devices.length, 3)
    assert.deepEqual(c.evicted, [])
    const d = addDevice(cfg, { name: '第四台' })
    assert.equal(cfg.devices.length, 3)
    assert.equal(d.evicted[0].name, 'iPhone', '顶掉最旧的')
  })

  await t.test('上限最小是 1，配 0 或负数不至于让所有人都进不来', () => {
    const cfg = { maxDevices: 0 }
    addDevice(cfg, { name: 'iPhone' })
    assert.equal(cfg.devices.length, 1)
  })
})
