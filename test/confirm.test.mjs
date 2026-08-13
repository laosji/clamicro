/**
 * 配对时的 Mac 授权确认。
 *
 * 这道闸解决的是：在它之前，**谁扫到一张有效配对码，谁就拿到设备令牌**。
 * 一次性 + 60 秒能限制窗口，但挡不住码在那 60 秒里被屏幕共享、投屏、旁边的
 * 镜头看到——开着公网隧道时更是任何拿到隧道 URL 的人都能试。
 *
 * 这里测的是**判据和失败方向**，不测 osascript 到底渲染成什么样（那测不了）。
 * 注入一个假的 ask 就能覆盖真正容易错的地方：超时怎么读、异常往哪倒、
 * 以及那段会被执行的 AppleScript 里的字符串拼接。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConfirmer, escapeAppleScript, describeSource } from '../src/confirm.mjs'

/** 记下被问的那段脚本，同时决定回什么 */
const spy = (reply) => {
  const calls = []
  const fn = async (script, timeoutMs) => {
    calls.push({ script, timeoutMs })
    if (reply instanceof Error) throw reply
    return reply
  }
  fn.calls = calls
  return fn
}

test('只有明确按了「允许」才算通过', async (t) => {
  await t.test('按允许', async () => {
    const ok = await createConfirmer(spy('button returned:允许, gave up:false'))({ name: 'iPhone' })
    assert.equal(ok, true)
  })

  await t.test('按拒绝', async () => {
    const ok = await createConfirmer(spy('button returned:拒绝, gave up:false'))({ name: 'iPhone' })
    assert.equal(ok, false)
  })
})

test('失败一律倒向拒绝', async (t) => {
  // 确认机制失效时应该「没人能配对」，而不是「所有人都能」
  await t.test('超时（gave up）', async () => {
    // 关键：超时的返回里**同时**带着一个空的 button returned。
    // 只看「字符串里有没有『允许』」的实现会把这一条读成同意
    const ok = await createConfirmer(spy('button returned:, gave up:true'))({ name: 'iPhone' })
    assert.equal(ok, false)
  })

  await t.test('超时且回显里恰好含「允许」二字', async () => {
    const ok = await createConfirmer(spy('button returned:允许, gave up:true'))({ name: 'x' })
    assert.equal(ok, false, 'gave up 必须优先于按钮名')
  })

  await t.test('osascript 抛异常（拿不到图形会话 / 崩了）', async () => {
    const ok = await createConfirmer(spy(new Error('no GUI session')))({ name: 'iPhone' })
    assert.equal(ok, false)
  })

  await t.test('返回看不懂的东西', async () => {
    for (const junk of ['', 'wat', null, undefined]) {
      assert.equal(await createConfirmer(spy(junk))({ name: 'x' }), false, `junk=${junk}`)
    }
  })
})

test('对话框里必须带上「它从哪来」', async (t) => {
  // 设备名是对方自己写的，时间点可能是巧合；来源是唯一我们观测到的事实，
  // 也是人做判断的唯一依据
  await t.test('隧道要说得最重，并且用警告图标', async () => {
    const ask = spy('button returned:拒绝, gave up:false')
    await createConfirmer(ask)({ name: 'iPhone', tunnel: true })
    const s = ask.calls[0].script
    assert.match(s, /公网隧道/)
    assert.match(s, /with icon caution/)
  })

  await t.test('局域网带上来源 IP', async () => {
    const ask = spy('button returned:拒绝, gave up:false')
    await createConfirmer(ask)({ name: 'iPhone', ip: '192.168.0.7' })
    assert.match(ask.calls[0].script, /192\.168\.0\.7/)
  })

  await t.test('默认按钮是拒绝——回车和 Esc 都走向拒绝', async () => {
    const ask = spy('button returned:拒绝, gave up:false')
    await createConfirmer(ask)({ name: 'iPhone' })
    assert.match(ask.calls[0].script, /default button "拒绝"/)
  })

  await t.test('脚本里带 giving up，osascript 不会永远挂着', async () => {
    const ask = spy('button returned:拒绝, gave up:false')
    await createConfirmer(ask)({ name: 'iPhone' }, 30_000)
    assert.match(ask.calls[0].script, /giving up after 30\b/)
  })
})

test('设备名是 User-Agent，必须当成敌意输入', async (t) => {
  // 它会被拼进一段**会被执行**的 AppleScript。不转义的话，一个构造过的 UA
  // 就能在你的 Mac 上执行任意 AppleScript——比拿到设备令牌严重得多
  await t.test('引号被转义，闭不掉字符串', () => {
    const out = escapeAppleScript('iPhone" & (do shell script "whoami") & "')
    assert.ok(!/(^|[^\\])"/.test(out), `有未转义的引号: ${out}`)
  })

  await t.test('反斜杠先于引号处理，不会反转义回去', () => {
    // 顺序错了的话 a\" 会变成 a\\" —— 反斜杠自己被转义，引号反而逃出来
    assert.equal(escapeAppleScript('a\\"b'), 'a\\\\\\"b')
  })

  await t.test('控制字符换成空格，伪造不出多行对话框', () => {
    assert.equal(escapeAppleScript('a\nb\tc'), 'a b c ')
  })

  await t.test('长度截断，撑不爆对话框', () => {
    assert.ok(escapeAppleScript('x'.repeat(500)).length <= 120)
  })

  await t.test('非字符串不炸', () => {
    for (const v of [null, undefined, 123, {}]) assert.equal(typeof escapeAppleScript(v), 'string')
  })

  await t.test('注入尝试最终落进脚本里也是无害的字面量', async () => {
    const ask = spy('button returned:拒绝, gave up:false')
    await createConfirmer(ask)({ name: '"; do shell script "id"; "' })
    const s = ask.calls[0].script
    // 脚本里不该出现一个能闭合 display dialog 那个字符串的裸引号
    const body = s.slice(s.indexOf('display dialog "') + 16, s.indexOf('" with title'))
    assert.ok(!/(^|[^\\])"/.test(body), `正文里有未转义引号: ${body}`)
  })
})

test('describeSource 的三档', async (t) => {
  await t.test('隧道优先于其它', () => {
    // 同时是回环（cloudflared 就是从 127.0.0.1 转发进来的）时，必须报隧道
    assert.equal(describeSource({ tunnel: true, loopback: true }).risky, true)
    assert.match(describeSource({ tunnel: true, loopback: true }).text, /公网/)
  })
  await t.test('本机', () => {
    assert.match(describeSource({ loopback: true }).text, /本机/)
  })
  await t.test('局域网缺 IP 时也要有话说', () => {
    assert.match(describeSource({}).text, /未知地址/)
  })
})
