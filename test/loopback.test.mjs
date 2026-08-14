/**
 * 「只接受本机」这道闸的判据。
 *
 * hooks / statusline / pair-new 三组端点**没有 token**，保护完全靠来源判定。
 * 最初只看 remoteAddress——那个判据在开着 Cloudflare 隧道时是假的：
 *
 *   公网 → cloudflared → 从 127.0.0.1 转发进来 → remoteAddress 就是 127.0.0.1
 *
 * 而隧道域名启动时必须进 Host 白名单（否则隧道根本不能用），于是两道检查
 * 一起放行。后果不是「多暴露一点」，是整个信任模型失效：拿到隧道 URL 的人
 * 能 POST /api/pair/new 造一张配对券，换到设备 cookie，从此以合法设备的身份
 * 批准任何操作。
 *
 * 这些用例钉的是**判据本身**，不是某条路由——判据一松，三组端点一起失守。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isLoopback } from '../src/http/security.mjs'

const req = (remoteAddress, host, headers = {}) => ({
  socket: { remoteAddress },
  headers: { ...(host === null ? {} : { host }), ...headers },
})

test('本机直连放行', async (t) => {
  await t.test('hook 实际用的地址', () => {
    // settings.json 里九个 hook 全是 http://127.0.0.1:8765/hooks/…
    assert.equal(isLoopback(req('127.0.0.1', '127.0.0.1:8765')), true)
  })
  await t.test('localhost 写法', () => {
    assert.equal(isLoopback(req('127.0.0.1', 'localhost:8765')), true)
  })
  await t.test('IPv6 回环，端口剥掉不能连方括号一起剥', () => {
    assert.equal(isLoopback(req('::1', '[::1]:8765')), true)
    assert.equal(isLoopback(req('::ffff:127.0.0.1', '127.0.0.1')), true)
  })
  await t.test('没有 Host 头', () => {
    // HTTP/1.0 无 Host，只可能来自本机脚本；hostAllowed 也是同样处理
    assert.equal(isLoopback(req('127.0.0.1', null)), true)
  })
})

test('隧道转发进来的一律不算本机', async (t) => {
  await t.test('remoteAddress 是回环，但 Host 是隧道域名', () => {
    // 这是整条修复的核心：光看 remoteAddress 时这一例会被判成本机
    assert.equal(isLoopback(req('127.0.0.1', 'brave-fox-1234.trycloudflare.com')), false)
  })
  await t.test('带端口的隧道域名', () => {
    assert.equal(isLoopback(req('127.0.0.1', 'x.trycloudflare.com:443')), false)
  })
  await t.test('任意反代域名', () => {
    assert.equal(isLoopback(req('127.0.0.1', 'clamicro.example.com')), false)
  })
})

test('带转发头的一律不算本机', async (t) => {
  // 就算 Host 被伪造成回环，这些头也说明它经过了代理。真正的本机直连不会有
  for (const h of ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
                   'cf-connecting-ip', 'cf-ray', 'forwarded']) {
    await t.test(h, () => {
      assert.equal(isLoopback(req('127.0.0.1', '127.0.0.1:8765', { [h]: '1.2.3.4' })), false)
    })
  }
})

test('非回环来源', async (t) => {
  await t.test('同一 Wi-Fi 上的别人', () => {
    // 服务同时绑局域网网卡，所以这一条不是理论问题
    assert.equal(isLoopback(req('192.168.1.7', '192.168.1.42:8765')), false)
  })
  await t.test('拿不到来源地址时按不可信处理', () => {
    assert.equal(isLoopback({ socket: {}, headers: {} }), false)
    assert.equal(isLoopback({ headers: {} }), false)
  })
})
