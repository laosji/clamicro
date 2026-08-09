/**
 * 版本提示。
 *
 * 这是这个工具唯一一次主动对外的网络请求，所以它的失败行为比成功行为更重要：
 * **没网、超时、registry 挂了，都不能让 `clamicro status` 变慢、报错或者不能用。**
 * 一个局域网工具在飞机上照样该跑得起来。
 *
 * 测试一律注入假 fetch——真发请求的测试会因为别人的网络而红，那种测试
 * 迟早会被人加 skip。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isNewer, checkUpdate } from '../src/update.mjs'

const ok = (version) => async () => ({ ok: true, json: async () => ({ version }) })

test('版本比较', async (t) => {
  await t.test('大的算新', () => {
    assert.equal(isNewer('2.3.0', '2.0.1'), true)
    assert.equal(isNewer('2.0.1', '2.3.0'), false)
  })
  await t.test('逐位比较，不是字符串比较', () => {
    // '10' < '9' 是字符串比较的经典坑
    assert.equal(isNewer('2.10.0', '2.9.0'), true)
    assert.equal(isNewer('10.0.0', '9.9.9'), true)
  })
  await t.test('相同不算新', () => {
    assert.equal(isNewer('2.3.0', '2.3.0'), false)
  })
  await t.test('patch 位也算', () => {
    assert.equal(isNewer('2.3.1', '2.3.0'), true)
  })
  await t.test('预发布版不推给人', () => {
    // registry 上的 latest 理论上不会是 beta，但真出现时不该把人往那儿引
    assert.equal(isNewer('2.4.0-beta.1', '2.3.0'), false)
  })
  await t.test('解析不了的一律当作不新——宁可不提示，不能乱提示', () => {
    for (const bad of ['', null, undefined, 'latest', 'v2', {}]) {
      assert.equal(isNewer(bad, '2.3.0'), false, `a=${JSON.stringify(bad)}`)
      assert.equal(isNewer('2.3.0', bad), false, `b=${JSON.stringify(bad)}`)
    }
  })
})

test('查询', async (t) => {
  await t.test('有新版时返回版本号', async () => {
    const r = await checkUpdate('2.0.1', { fetchImpl: ok('2.3.0') })
    assert.deepEqual(r, { latest: '2.3.0' })
  })

  await t.test('已经是最新时返回 null', async () => {
    assert.equal(await checkUpdate('2.3.0', { fetchImpl: ok('2.3.0') }), null)
  })

  await t.test('本地比 registry 还新（刚发完还没同步）也返回 null', async () => {
    assert.equal(await checkUpdate('2.3.0', { fetchImpl: ok('2.0.1') }), null)
  })
})

test('失败一律静默——没网不是错误', async (t) => {
  const cases = [
    ['网络抛异常', async () => { throw new Error('ENOTFOUND') }],
    ['超时', async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }) }],
    ['registry 返回 500', async () => ({ ok: false, json: async () => ({}) })],
    ['返回的不是 JSON', async () => ({ ok: true, json: async () => { throw new Error('bad json') } })],
    ['JSON 里没有 version', async () => ({ ok: true, json: async () => ({}) })],
    ['version 不是字符串', async () => ({ ok: true, json: async () => ({ version: 230 }) })],
  ]
  for (const [name, fetchImpl] of cases) {
    await t.test(name, async () => {
      let r
      await assert.doesNotReject(async () => { r = await checkUpdate('2.0.1', { fetchImpl }) })
      assert.equal(r, null)
    })
  }
})

test('缓存：一天最多查一次', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'clamicro-up-'))
  const cacheFile = join(dir, 'update-check.json')
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  let calls = 0
  const counting = (v) => async () => { calls++; return { ok: true, json: async () => ({ version: v }) } }
  const T0 = 1_700_000_000_000

  await t.test('第一次真的查，并写下缓存', async () => {
    const r = await checkUpdate('2.0.1', { cacheFile, now: T0, fetchImpl: counting('2.3.0') })
    assert.deepEqual(r, { latest: '2.3.0' })
    assert.equal(calls, 1)
    assert.ok(existsSync(cacheFile))
  })

  await t.test('一天之内不再查', async () => {
    const r = await checkUpdate('2.0.1', { cacheFile, now: T0 + 60_000, fetchImpl: counting('2.3.0') })
    assert.equal(calls, 1, '命中缓存却又发了请求')
    assert.deepEqual(r, { latest: '2.3.0' })
  })

  await t.test('缓存里的版本也要跟当前版本重新比——升级后不能还提示', async () => {
    // 用户按提示升到 2.3.0 了，缓存还在，这时不能继续喊「有新版 2.3.0」
    const r = await checkUpdate('2.3.0', { cacheFile, now: T0 + 60_000, fetchImpl: counting('2.3.0') })
    assert.equal(r, null)
  })

  await t.test('超过一天重新查', async () => {
    await checkUpdate('2.0.1', { cacheFile, now: T0 + 25 * 3600_000, fetchImpl: counting('2.4.0') })
    assert.equal(calls, 2)
  })

  await t.test('缓存文件 0600 —— 没有秘密，但也没理由给别人读', () => {
    assert.equal(statSync(cacheFile).mode & 0o777, 0o600)
  })

  await t.test('缓存坏了就重查，不抛', async () => {
    writeFileSync(cacheFile, '这不是 JSON')
    const before = calls
    const r = await checkUpdate('2.0.1', { cacheFile, now: T0 + 50 * 3600_000, fetchImpl: counting('2.5.0') })
    assert.equal(calls, before + 1)
    assert.deepEqual(r, { latest: '2.5.0' })
  })

  await t.test('缓存写不进去也不影响返回结果', async () => {
    const r = await checkUpdate('2.0.1', {
      cacheFile: join(dir, '不存在的目录', 'x.json'),
      now: T0,
      fetchImpl: counting('2.6.0'),
    })
    assert.deepEqual(r, { latest: '2.6.0' })
  })

  await t.test('查询失败时不写缓存——否则一次断网会静默一整天', async () => {
    rmSync(cacheFile, { force: true })
    await checkUpdate('2.0.1', { cacheFile, now: T0, fetchImpl: async () => { throw new Error('offline') } })
    assert.equal(existsSync(cacheFile), false)
  })
})

test('请求只发给 registry.npmjs.org，且带超时', async () => {
  // 这是整个工具唯一的对外请求，目标和超时都不该被悄悄改掉
  let seenUrl = null
  let seenSignal
  await checkUpdate('2.0.1', {
    fetchImpl: async (url, opts) => {
      seenUrl = url
      seenSignal = opts?.signal
      return { ok: true, json: async () => ({ version: '2.3.0' }) }
    },
  })
  assert.match(seenUrl, /^https:\/\/registry\.npmjs\.org\//)
  assert.ok(seenSignal, '必须带 AbortSignal，否则没网时 status 会挂很久')
})
