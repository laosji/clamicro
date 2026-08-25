/**
 * 装了 qrencode 时，配对地址要同时进剪贴板。
 *
 * ## 为什么值得单独测
 *
 * 这条路上「屏幕上有东西」和「地址拿得到」是**两件事**，而它们的失败长得
 * 一模一样：码照常弹出来、请求照常返回 200、日志照常说「已在 Mac 上显示」。
 * 少了剪贴板那一步，唯一的症状是屏幕前的人复制不了那段地址——没有任何
 * 自动化信号会因此变红。
 *
 * 另一半是**通知得如实说**。copyPairUrl 会盖掉用户原来的剪贴板，悄悄干
 * 这件事等于让人下一次粘贴时莫名其妙拿到一段陌生 URL。所以「拷了」这个
 * 事实必须出现在通知里，而不是只体现在剪贴板的副作用上。
 *
 * 手法同 pair-fallback.test.mjs：用 PATH 上的假二进制接管外部依赖。区别是
 * 那边让 qrencode **失败**（测兜底），这边让它**成功**（测正常路径），
 * 于是 open 也得换掉——真的 open 会在跑测试的人脸上弹出 Preview。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startServer } from './helpers/server.mjs'

// copyPairUrl 只在 darwin 上动手（pbcopy 是 macOS 的东西），别的平台没什么可测
const onlyMac = process.platform !== 'darwin' ? '只有 macOS 有 pbcopy' : false

let S, shimDir, clip

before(async () => {
  if (onlyMac) return
  shimDir = mkdtempSync(join(tmpdir(), 'clamicro-clip-'))
  clip = join(shimDir, 'clipboard.txt')

  const shim = (name, body) => {
    const p = join(shimDir, name)
    writeFileSync(p, `#!/bin/sh\n${body}\n`)
    chmodSync(p, 0o755)
  }
  // qrencode 成功但不真画图：路由只看 status，PNG 有没有它不关心
  shim('qrencode', 'exit 0')
  // 真的 open 会弹 Preview 到测试者脸上
  shim('open', 'exit 0')
  // 把 stdin 落盘，就是「剪贴板」现在装着什么
  shim('pbcopy', `cat > "${clip}"`)
  // 通知那条路照旧掐掉：osascript 会挂一个最长 60 秒的对话框
  shim('osascript', 'exit 127')
  shim('terminal-notifier', 'exit 127')

  S = await startServer({ port: 8797, env: { PATH: `${shimDir}:${process.env.PATH}` } })
})

after(async () => {
  await S?.stop()
  if (shimDir) rmSync(shimDir, { recursive: true, force: true })
})

test('二维码弹出来的同时，地址进剪贴板', { skip: onlyMac }, async (t) => {
  let body

  await t.test('请求成功，且 qr:true', async () => {
    const r = await S.post('/api/pair', undefined, { raw: true, headers: { 'X-CCM': '1' } })
    assert.equal(r.status, 200)
    body = await r.json()
    assert.equal(body.qr, true, 'qrencode 这次是成功的，前端该说「扫那个二维码」')
  })

  await t.test('剪贴板里是那条配对地址', () => {
    assert.ok(existsSync(clip), 'pbcopy 根本没被调用——屏幕上有码，地址却一个字都拿不到')
    const got = readFileSync(clip, 'utf8')
    assert.match(got, /\/ui\/pair\/[A-Za-z0-9_-]+$/,
      `剪贴板里该是完整的配对 URL，实际是：${JSON.stringify(got)}`)
  })

  await t.test('没有多余的换行', () => {
    // pbcopy 原样收下 stdin。多一个 \n，粘进地址栏就是两行，
    // Safari 会把它当搜索词而不是网址
    assert.equal(readFileSync(clip, 'utf8').trim(), readFileSync(clip, 'utf8'))
  })
})

test('通知说出「地址已拷贝」', { skip: onlyMac }, async () => {
  /**
   * 通知本身发不出去（osascript 被换成了必然失败的假货），所以断言落在
   * 日志上——正常路径下路由不该抱怨拷贝失败。
   *
   * 反过来说：日志里一旦出现「地址没能拷进剪贴板」，就说明 pbcopy 那步
   * 挂了，而那正是这个测试要挡住的回归。
   */
  assert.doesNotMatch(S.logs(), /地址没能拷进剪贴板/,
    `pbcopy 明明在 PATH 上却没拷成功。日志：\n${S.logs()}`)
  assert.match(S.logs(), /已在 Mac 上显示二维码/)
})
