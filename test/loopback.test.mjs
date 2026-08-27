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
import { isLoopback, allowedHosts, hostAllowed } from '../src/http/security.mjs'

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

/**
 * Host 白名单本身。一条测试都没有过，而 server.mjs 刚开始在**运行期**重算它。
 *
 * 起因：netwatch 换到另一个已信任网络、拿到新 IP 时会 listenOn(新IP) 并打印
 * 「已恢复局域网监听」。而这个集合原来是启动时算死的 `const`，里面装的还是
 * 旧 IP —— 手机连过来 Host 对不上，hostAllowed 一律 403 bad host。
 * **日志说恢复了，实际连不上**，比不恢复更难查。
 *
 * 所以 rebindLan() 现在拿 `{...config, lanIp: 新值}` 重算它。下面钉的就是
 * 那次重算必须成立的两件事：新地址进得来，旧地址出得去。
 */
test('Host 白名单跟着「此刻暴露在哪」走', async (t) => {
  const cfg = { port: 8765, lanIp: '192.168.1.10', localHost: 'MyMac.local', tailscaleIp: null, tunnelUrl: null }
  const req = (host) => ({ socket: { remoteAddress: '192.168.1.7' }, headers: { host } })

  await t.test('回环和本机名永远在里面', () => {
    const a = allowedHosts(cfg)
    for (const h of ['127.0.0.1', '127.0.0.1:8765', 'localhost:8765', '[::1]']) {
      assert.equal(hostAllowed(req(h), a), true, h)
    }
  })

  await t.test('主机名转小写 —— LocalHostName 常是混合大小写', () => {
    // 曾经只把进来的 Host 转了小写、白名单里存的是原样，结果服务把自己的
    // 主机名拒了
    assert.equal(hostAllowed(req('mymac.local:8765'), allowedHosts(cfg)), true)
  })

  await t.test('换了 lanIp 之后，新地址进得来', () => {
    const a = allowedHosts({ ...cfg, lanIp: '10.0.0.5' })
    assert.equal(hostAllowed(req('10.0.0.5:8765'), a), true)
    assert.equal(hostAllowed(req('10.0.0.5'), a), true)
  })

  await t.test('**旧地址出得去** —— 那上面已经没有监听了', () => {
    // 白名单是一份「现在暴露在哪」的记录。留着一个已经摘掉的地址，
    // 记录就和事实对不上，而这个集合唯一的职责就是描述事实
    const a = allowedHosts({ ...cfg, lanIp: '10.0.0.5' })
    assert.equal(hostAllowed(req('192.168.1.10:8765'), a), false)
  })

  await t.test('全摘掉（lanIp=null）之后只剩回环和本机名', () => {
    const a = allowedHosts({ ...cfg, lanIp: null })
    assert.equal(hostAllowed(req('192.168.1.10:8765'), a), false)
    assert.equal(hostAllowed(req('127.0.0.1:8765'), a), true)
  })

  await t.test('隧道没在跑时那个域名不进白名单', () => {
    assert.equal(hostAllowed(req('abc.trycloudflare.com'), allowedHosts(cfg)), false)
    const up = allowedHosts({ ...cfg, tunnelUrl: 'https://abc.trycloudflare.com' })
    assert.equal(hostAllowed(req('abc.trycloudflare.com'), up), true)
  })
})
