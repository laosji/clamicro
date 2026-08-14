/**
 * 读接口永远不许把存起来的凭证原样吐出来。
 *
 * ## 为什么单独钉一条
 *
 * 今天 `/api/config` 是安全的——它是**手写白名单**，一个字段一个字段列出来的，
 * 令牌根本没有机会进去。我打真服务扫过五个出口，一个都不漏。
 *
 * 但这份安全性完全来自「当时写的人这么写了」，没有任何东西拦着下一次改动。
 * 把那 15 行换成 `json(res, 200, config)` 是一个看起来纯属简化的改动：功能不变、
 * 测试全绿、code review 也未必看得出来——而主令牌和每台设备的令牌从此跟着
 * **每一次设置页加载**发出去。
 *
 * 这类错误的特征是不报错，只是悄悄少一层防护，所以只能靠测试守。
 *
 * ## 「反正这个接口有鉴权」不是理由
 *
 * 鉴权那层出问题的时候，正是你最需要凭证还没泄露的时候。两层是独立的，
 * 不该互相当借口。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startServer } from './helpers/server.mjs'

let S, secrets

before(async () => {
  S = await startServer({ port: 8797 })
  const cfg = JSON.parse(readFileSync(join(S.home, '.claude', 'clamicro', 'config.json'), 'utf8'))
  secrets = [
    ['主令牌', cfg.token],
    // 设备令牌：这台服务是全新的，先造一台出来，否则这条测不到东西
    ...(cfg.devices ?? []).map((d) => [`设备 ${d.id} 的令牌`, d.token]),
  ].filter(([, v]) => typeof v === 'string' && v.length > 16)
})

after(async () => { await S?.stop() })

/** 所有「读」出口。新增读接口时也该加进来 */
const READ_PATHS = ['/healthz', '/api/config', '/api/state', '/api/sessions', '/api/approvals']

test('凭证不出现在任何读接口的响应里', async (t) => {
  for (const path of READ_PATHS) {
    await t.test(path, async () => {
      const r = await S.get(path)
      const body = await r.text()
      for (const [name, secret] of secrets) {
        assert.ok(!body.includes(secret), `${path} 把${name}带出来了`)
      }
    })
  }
})

test('/api/config 是白名单，不是把 config 摊开', async (t) => {
  const body = await (await S.get('/api/config')).json()

  await t.test('该有的字段在', () => {
    // 设置页真的要用这些。这条在这里是为了让下一条的「不该有」有说服力：
    // 光断言「没有 token」的话，一个返回 {} 的实现也能过
    for (const k of ['macNotify', 'autoApproveMs', 'timeoutMs', 'autoApproveHighRisk', 'baseUrl']) {
      assert.ok(k in body, `少了 ${k}`)
    }
  })

  await t.test('凭证字段一个都不在', () => {
    for (const k of ['token', 'devices', 'trustedNetworks']) {
      assert.ok(!(k in body), `不该有 ${k}`)
    }
  })

  await t.test('任何一层里都没有叫 token 的键', () => {
    // 嵌套进去也不行。比如往 network 或 notifyHealth 里塞一个 token
    const walk = (o, p = '') => {
      if (o === null || typeof o !== 'object') return []
      return Object.entries(o).flatMap(([k, v]) =>
        [...(/token|secret|password|credential/i.test(k) ? [`${p}${k}`] : []), ...walk(v, `${p}${k}.`)])
    }
    assert.deepEqual(walk(body), [], '出现了名字像凭证的字段')
  })
})

test('未认证连白名单也拿不到', async () => {
  // 这一层挂了的时候，上面那些断言就是最后一道
  assert.equal((await S.get('/api/config', { raw: true })).status, 401)
})
