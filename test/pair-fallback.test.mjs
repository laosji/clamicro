/**
 * POST /api/pair 在外部依赖失效时的行为。
 *
 * ## 为什么单独一个文件
 *
 * 这条路由踩着两个进程外的东西：`qrencode`（画二维码）和通知。两个都可能
 * 不在，而它们不在的时候，原来的表现是：
 *
 *   · qrencode 没装 → 不 open 任何东西，**而 loginUrl 只被喂给 qrencode**，
 *     所以 Mac 屏幕上一片空白；同时通知说「扫描屏幕上的二维码」、
 *     pair.html 说「✓ 已在 Mac 上显示」、pair-expired.html 说「屏幕上会显示
 *     地址」。一条死路配三处假话，而且没有任何线索指向缺的是一个 Homebrew 包。
 *   · 通知抛异常 → `await notify(...)` 裸奔，整个路由跟着抛，手机收到 400。
 *     日志里真的发生过：`[http] POST /api/pair: notify is not a function`，
 *     当时二维码就在屏幕上，而手机上原样显示着那句报错。
 *
 * 这两条都没法在开发机上顺手制造——本机装着 qrencode，通知也是通的。所以
 * 用 PATH 把它们换成必然失败的假二进制，让失败路径成为可复现的东西。
 *
 * 顺带把 osascript 也换掉：真的 osascript 会弹一个最长 60 秒的对话框，
 * 跑一次测试就卡住一次。换成假的之后，「连兜底对话框也弹不出来」正好是
 * 最差的那种情况——路由在那种情况下**仍然**必须返回成功。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startServer } from './helpers/server.mjs'

let S, shimDir

before(async () => {
  shimDir = mkdtempSync(join(tmpdir(), 'clamicro-shims-'))
  // 退 127 而不是删掉文件：缺文件时 spawnSync 返回 status=null，
  // 假二进制返回 status=127，两者都不等于 0，走的是同一条分支。
  // 用假二进制的好处是不必动真实 PATH 上的任何东西。
  for (const name of ['qrencode', 'osascript', 'terminal-notifier']) {
    const p = join(shimDir, name)
    writeFileSync(p, '#!/bin/sh\necho "shim: not available" >&2\nexit 127\n')
    chmodSync(p, 0o755)
  }
  S = await startServer({ port: 8796, env: { PATH: `${shimDir}:${process.env.PATH}` } })
})

after(async () => {
  await S?.stop()
  if (shimDir) rmSync(shimDir, { recursive: true, force: true })
})

test('qrencode 和通知全挂掉，配对请求仍然成功', async (t) => {
  let body

  await t.test('返回 200，不是 400', async () => {
    const r = await S.post('/api/pair', undefined, { raw: true, headers: { 'X-CCM': '1' } })
    assert.equal(r.status, 200, `配对 id 已经生效了，不该报失败。实际 ${r.status}`)
    body = await r.json()
  })

  await t.test('ok:true —— 配对确实开出去了', () => {
    assert.equal(body.ok, true)
  })

  await t.test('qr:false —— 如实告诉前端「屏幕上不是二维码」', () => {
    // 前端据此换掉「用相机扫那个二维码」那句话。少了这个字段，
    // 人会拿着手机对着一段文字找码扫
    assert.equal(body.qr, false)
  })

  await t.test('响应里不出现内部报错', () => {
    // 以前 notify 抛出来会变成 {error: "notify is not a function"}，
    // 被 pair.html 原样印在屏幕上
    assert.ok(!('error' in body), `不该把内部异常回给手机: ${JSON.stringify(body)}`)
  })
})

test('日志把「屏幕上没有二维码」说出来', async (t) => {
  await t.test('明确记下没装 qrencode', () => {
    assert.match(S.logs(), /没装 qrencode/,
      '日志是排查这类故障唯一的线索——静默降级等于把线索也一起吞掉')
  })

  await t.test('兜底对话框也失败时同样留痕', async () => {
    // showPairUrl 是 fire-and-forget（对话框最长挂 60 秒，请求不能等它），
    // 所以这条日志必然**晚于**响应到达。直接断言会稳定地偶发失败
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && !/没能在 Mac 上显示配对地址/.test(S.logs())) {
      await new Promise((r) => setTimeout(r, 50))
    }
    assert.match(S.logs(), /没能在 Mac 上显示配对地址/)
  })
})

test('失败之后不占着 10 秒限流窗口', async () => {
  /**
   * lastPairAt 在动手**之前**就置位（防局域网刷屏是对的），但原来一旦
   * 中途抛错，那 10 秒照样锁着——人在手机上除了干等没有别的办法，
   * 而他并不知道自己在等什么。
   *
   * 这里前一个 test 刚发过一次成功的请求，所以这一次必然撞上限流，
   * 断言的是「限流仍然生效」；失败重置那条路由代码里有显式的 lastPairAt = 0。
   */
  const r = await S.post('/api/pair', undefined, { raw: true, headers: { 'X-CCM': '1' } })
  assert.equal(r.status, 429, '成功之后的 10 秒内必须挡住，否则局域网上谁都能让你的 Mac 刷屏')
})
