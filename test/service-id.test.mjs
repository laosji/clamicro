/**
 * 「端口上那个是不是我们的服务」。
 *
 * ## 为什么单独钉
 *
 * `stop` 和安装流程都会 kill 掉端口上的监听者。原来拿到 PID 就直接杀，
 * 不校验身份——而 8765 不是保留端口。被别的程序占着时，
 * `npx clamicro stop` 会**杀掉一个无辜进程**，还照样打印「✓ 已停止」。
 * 安装流程更糟：它自动跑，用户没有机会喊停。
 *
 * ## 升级那条路更要钉
 *
 * 第一版判据只认 `service: 'clamicro'` 这个新字段，结果**新版 CLI 停不掉
 * 旧版服务**（旧版没有这个字段），升级当场卡死。实测撞到的。
 * 所以必须有旧版兼容那条分支，而它一旦被谁「顺手简化」掉，
 * 下一次升级又会卡住——这种问题只在升级时出现，日常测试碰不到。
 *
 * 跑：node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { isOurService } from '../src/service-id.mjs'

/** 起一个假的 /healthz，返回指定 body */
async function withServer(body, fn) {
  const srv = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  try {
    await fn(srv.address().port)
  } finally {
    await new Promise((r) => srv.close(r))
  }
}

test('认得出自己', async () => {
  await withServer({ ok: true, stale: false, service: 'clamicro' }, async (port) => {
    assert.equal(await isOurService(port, []), true)
  })
})

test('不是自己的一律不认', async (t) => {
  await t.test('别的服务恰好也回 ok', async () => {
    await withServer({ ok: true }, async (port) => {
      assert.equal(await isOurService(port, []), false)
    })
  })

  await t.test('service 字段是别人的名字', async () => {
    await withServer({ ok: true, stale: false, service: '别的工具' }, async (port) => {
      assert.equal(await isOurService(port, []), false)
    })
  })

  await t.test('压根不响应 HTTP', async () => {
    // 没有任何东西在监听的端口
    assert.equal(await isOurService(1, []), false)
  })
})

test('旧版兼容：没有 service 字段时靠命令行确认', async (t) => {
  await t.test('healthz 形状对，但 PID 的命令行不像我们的 → 不认', async () => {
    await withServer({ ok: true, stale: false }, async (port) => {
      // 传一个真实存在但显然不是我们的 PID（当前测试进程自己）
      assert.equal(await isOurService(port, [process.pid]), false)
    })
  })

  await t.test('没有 stale 字段就直接不认，不再去看命令行', async () => {
    await withServer({ ok: true }, async (port) => {
      assert.equal(await isOurService(port, [process.pid]), false)
    })
  })

  await t.test('不传 PID 时旧版分支不会误判成 true', async () => {
    // 升级路径要靠 PID 才判得出来；没有 PID 就是「拿不准」，
    // 而拿不准一律不杀
    await withServer({ ok: true, stale: false }, async (port) => {
      assert.equal(await isOurService(port, []), false)
    })
  })
})
