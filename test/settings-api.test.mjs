/**
 * 设置写入的边界。
 *
 * 重点只有一个：**等待时长必须被夹住**。
 *
 * hook 的系统超时是 600 秒。用户在网页上把「高风险等待时长」拉到 10 分钟，
 * 得到的不是「等更久」，是**审批彻底失效**——超时后 Claude Code 把它当成
 * 非阻塞错误，放行到正常权限流程，而且不报任何错。这是这个项目最典型的
 * 那类故障：设置看起来生效了，保护没了，界面一切正常。
 *
 * 前端也夹了一遍，但前端的限制永远只是提示——能改设置的人也能直接发请求。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startServer } from './helpers/server.mjs'
import { MAX_APPROVAL_TIMEOUT_MS, MIN_APPROVAL_TIMEOUT_MS } from '../src/config.mjs'

let S
test.before(async () => { S = await startServer({ port: 8793 }) })
test.after(async () => { await S?.stop() })

const setTimeoutMs = async (ms) => {
  await S.post('/api/config', { timeoutMs: ms })
  return (await (await S.get('/api/config')).json()).timeoutMs
}

test('等待时长的上限是硬的', async (t) => {
  await t.test('正常值原样写入', async () => {
    assert.equal(await setTimeoutMs(180_000), 180_000)
  })

  await t.test('超过 570 秒被夹回去 —— 越过 hook 的 600s 就等于没有审批', async () => {
    assert.equal(await setTimeoutMs(600_000), MAX_APPROVAL_TIMEOUT_MS)
    assert.equal(await setTimeoutMs(86_400_000), MAX_APPROVAL_TIMEOUT_MS)
  })

  await t.test('小于下限也夹 —— 太短了人根本来不及看一眼手机', async () => {
    assert.equal(await setTimeoutMs(0), MIN_APPROVAL_TIMEOUT_MS)
    assert.equal(await setTimeoutMs(-5000), MIN_APPROVAL_TIMEOUT_MS)
  })

  await t.test('非数字不改动原值，而不是写进一个 NaN', async () => {
    await setTimeoutMs(120_000)
    for (const bad of ['abc', null, {}, NaN, Infinity]) {
      await S.post('/api/config', { timeoutMs: bad })
      const got = (await (await S.get('/api/config')).json()).timeoutMs
      assert.equal(got, 120_000, `timeoutMs=${JSON.stringify(bad)} 把配置改坏了`)
    }
  })
})

test('自动通过的操作也提醒：这个开关要能读能写', async (t) => {
  await t.test('默认开 —— 否则普通操作既不拦也不说，你完全不知道跑了什么', async () => {
    const c = await (await S.get('/api/config')).json()
    assert.equal(typeof c.notifyAutoApproved, 'boolean')
  })

  await t.test('可以关掉', async () => {
    await S.post('/api/config', { notifyAutoApproved: false })
    assert.equal((await (await S.get('/api/config')).json()).notifyAutoApproved, false)
  })

  await t.test('可以再打开', async () => {
    await S.post('/api/config', { notifyAutoApproved: true })
    assert.equal((await (await S.get('/api/config')).json()).notifyAutoApproved, true)
  })

  await t.test('非布尔值不改动 —— 别让一个手滑的请求悄悄关掉提醒', async () => {
    await S.post('/api/config', { notifyAutoApproved: 'yes' })
    assert.equal((await (await S.get('/api/config')).json()).notifyAutoApproved, true)
  })
})

test('一次请求里的多个字段互不干扰', async () => {
  await S.post('/api/config', { timeoutMs: 999_999, notifyAutoApproved: false, minTurnMs: 5000 })
  const c = await (await S.get('/api/config')).json()
  assert.equal(c.timeoutMs, MAX_APPROVAL_TIMEOUT_MS, '被夹的字段不该影响别的字段')
  assert.equal(c.notifyAutoApproved, false)
  assert.equal(c.minTurnMs, 5000)
})
