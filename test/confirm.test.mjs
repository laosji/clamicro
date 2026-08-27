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
import { createConfirmer, createUrlShower, escapeAppleScript, describeSource } from '../src/confirm.mjs'

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
    const r = await createConfirmer(spy('button returned:允许, gave up:false'))({ name: 'iPhone' })
    assert.deepEqual(r, { allowed: true, reason: 'allowed' })
  })

  await t.test('按拒绝', async () => {
    const r = await createConfirmer(spy('button returned:拒绝, gave up:false'))({ name: 'iPhone' })
    assert.deepEqual(r, { allowed: false, reason: 'denied' })
  })
})

test('失败一律倒向拒绝', async (t) => {
  // 确认机制失效时应该「没人能配对」，而不是「所有人都能」
  await t.test('超时（gave up）', async () => {
    // 关键：超时的返回里**同时**带着一个空的 button returned。
    // 只看「字符串里有没有『允许』」的实现会把这一条读成同意
    const r = await createConfirmer(spy('button returned:, gave up:true'))({ name: 'iPhone' })
    assert.equal(r.allowed, false)
  })

  await t.test('超时且回显里恰好含「允许」二字', async () => {
    const r = await createConfirmer(spy('button returned:允许, gave up:true'))({ name: 'x' })
    assert.equal(r.allowed, false, 'gave up 必须优先于按钮名')
  })

  await t.test('osascript 抛异常（拿不到图形会话 / 崩了）', async () => {
    const r = await createConfirmer(spy(new Error('no GUI session')))({ name: 'iPhone' })
    assert.equal(r.allowed, false)
  })

  await t.test('返回看不懂的东西', async () => {
    for (const junk of ['', 'wat', null, undefined]) {
      const r = await createConfirmer(spy(junk))({ name: 'x' })
      assert.equal(r.allowed, false, `junk=${junk}`)
    }
  })
})

test('三种「没通过」必须能分开', async (t) => {
  /**
   * 全部返回 false 的时候，等待页只能对所有情况讲同一句
   * 「Mac 上点了『拒绝』，或者等太久自动拒绝了」。
   *
   * 日志里出现过两次 `osascript 退出码 null`（被信号杀死，多半是服务重启把
   * 同进程组的对话框带走了）。那两次上面两件事一件都没发生，手机却告诉用户
   * 有人拒绝了他 —— 于是他去找「谁点的拒绝」，而真正该做的只是再扫一次。
   */
  await t.test('有人点了拒绝 → denied', async () => {
    const r = await createConfirmer(spy('button returned:拒绝, gave up:false'))({ name: 'x' })
    assert.equal(r.reason, 'denied')
  })

  await t.test('没人理 → timeout', async () => {
    const r = await createConfirmer(spy('button returned:, gave up:true'))({ name: 'x' })
    assert.equal(r.reason, 'timeout')
  })

  await t.test('对话框根本没能正常结束 → interrupted', async () => {
    const r = await createConfirmer(spy(new Error('osascript 被信号 SIGTERM 终止')))({ name: 'x' })
    assert.equal(r.reason, 'interrupted', '这一条不该被说成「有人拒绝了你」')
  })

  await t.test('三种都不放行', async () => {
    // 分类是为了把话说清楚，**不是**为了给某一类开口子
    for (const reply of [
      'button returned:拒绝, gave up:false',
      'button returned:, gave up:true',
      new Error('boom'),
    ]) {
      assert.equal((await createConfirmer(spy(reply))({ name: 'x' })).allowed, false)
    }
  })
})

test('没装 qrencode 时把地址弹出来', async (t) => {
  /**
   * qrencode 是 Homebrew 的包，仓库里从没声明过。缺了它，网页配对这条路
   * 原来是彻底的死路：屏幕上什么都没有，而通知和两个前端页面都在说
   * 「屏幕上有二维码」。
   */
  await t.test('地址进了对话框正文', async () => {
    const ask = spy('button returned:知道了, gave up:false')
    const ok = await createUrlShower(ask)('http://MacBook.local:8765/ui/pair/abc123')
    assert.equal(ok, true)
    assert.match(ask.calls[0].script, /MacBook\.local:8765\/ui\/pair\/abc123/)
  })

  await t.test('顺便告诉人缺的是什么', async () => {
    const ask = spy('button returned:知道了, gave up:false')
    await createUrlShower(ask)('http://x/y')
    assert.match(ask.calls[0].script, /brew install qrencode/,
      '不说的话，人只会看到一段地址，永远不知道本该是个二维码')
  })

  await t.test('只有一个按钮 —— 它是通知不是提问', async () => {
    const ask = spy('button returned:知道了, gave up:false')
    await createUrlShower(ask)('http://x/y')
    assert.doesNotMatch(ask.calls[0].script, /拒绝|允许/, '别和授权确认框长得像')
  })

  await t.test('弹不出来也不抛 —— 配对 id 已经生效了', async () => {
    // 抛的话整个 POST /api/pair 跟着 400，而配对其实是成功的：
    // 人还可以去终端跑 clamicro qr
    assert.equal(await createUrlShower(spy(new Error('no GUI')))('http://x/y'), false)
  })

  await t.test('地址里的引号会被转义', async () => {
    const ask = spy('button returned:知道了, gave up:false')
    await createUrlShower(ask)('http://x/"; do shell script "id')
    const body = ask.calls[0].script.match(/display dialog "([\s\S]*?)" with title/)[1]
    assert.ok(!/(^|[^\\])"/.test(body), `正文里有未转义引号: ${body}`)
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
    await createConfirmer(ask)({ name: 'iPhone', ip: '192.168.1.7' })
    assert.match(ask.calls[0].script, /192\.168\.1\.7/)
  })

  await t.test('「允许」高亮，但 Esc 和超时仍然走向拒绝', async () => {
    // 明知的取舍：高亮给主路径（你自己发起的流程），代价是「误按回车」不再
    // 安全。但真正要防的是「你不在场时有人悄悄配对」——那时没人按回车，
    // 超时自动拒绝仍然成立。cancel button 保证 Esc 也是拒绝。
    const ask = spy('button returned:拒绝, gave up:false')
    await createConfirmer(ask)({ name: 'iPhone' })
    const s = ask.calls[0].script
    assert.match(s, /default button "允许"/, '允许应当是高亮的那个')
    assert.match(s, /cancel button "拒绝"/, 'Esc 必须仍然走向拒绝')
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

  /**
   * 截断排在转义**之前**。
   *
   * 反过来的话，转义撑长的字符串被切在 `\"` 这对中间，留下一个孤立的反斜杠
   * ——它会把整段脚本收尾的那个引号吃掉，osascript 语法错误、非 0 退出，
   * confirm 按 interrupted 处理，于是谁都配不上对。方向是 fail-closed，
   * 但那是一次谁也看不懂的故障。notify.mjs 的 escapeOsaString 同理，
   * 那边是真出过事的。
   */
  await t.test('截断不会切在转义序列中间（不留悬空反斜杠）', () => {
    for (let n = 100; n <= 140; n++) {
      for (const ch of ['"', '\\']) {
        const out = escapeAppleScript('x'.repeat(n) + ch.repeat(40))
        // 末尾的反斜杠必须是偶数个：奇数就说明有一个是孤儿
        const trailing = out.length - out.replace(/\\+$/, '').length
        assert.equal(trailing % 2, 0, `n=${n} ch=${ch} 末尾 ${trailing} 个反斜杠: ${out.slice(-8)}`)
      }
    }
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
