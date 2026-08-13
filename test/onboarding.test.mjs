/**
 * 新手引导的路由边界。
 *
 * 三屏是三个独立路由（不是同一屏的分步显示），这样中途切走 App 再回来能从
 * 中断的那一步继续。进度记在 localStorage，首页在渲染之前据此把人送回来。
 *
 * 这里只测服务端能测的部分：**谁能看到这几屏**，以及路径边界。三屏内部的
 * 流转靠 localStorage，那是浏览器的事。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startServer } from './helpers/server.mjs'

let S
// 端口要跟别的测试文件错开：node --test 默认按文件并行跑，撞端口的表现是
// 另一个文件的服务起不来、它那一整组用例全红——而报错指向的是那边，
// 很难联想到是这里加了个新文件
before(async () => { S = await startServer({ port: 8795 }) })
after(async () => { await S?.stop() })

test('引导页要求已登录', async (t) => {
  for (const n of [1, 2, 3]) {
    await t.test(`/ui/onboarding/${n} 带令牌可进`, async () => {
      assert.equal((await S.get(`/ui/onboarding/${n}`)).status, 200)
    })
  }

  await t.test('未登录一律回配对页，不泄露引导内容', async () => {
    // 这几屏讲的是「你现在能做什么」，对还没配对的人毫无意义；第三屏还会
    // 真的创建一条审批。不该让没配对的人看到，更不该让他触发
    const r = await S.get('/ui/onboarding/2', { raw: true })
    assert.equal(r.status, 401)
    const body = await r.text()
    assert.match(body, /需要配对/)
    assert.doesNotMatch(body, /你可以在手机上/, '未登录不该看到引导正文')
  })
})

test('步骤号只认 1-3', async (t) => {
  // 松开成 \d+ 的话，/ui/onboarding/999 会返回一个三屏全隐藏的空白页——
  // 那种「200 但什么都没有」最难排查
  for (const bad of ['0', '4', '9', '99', 'x', '1x', '-1']) {
    await t.test(`/ui/onboarding/${bad} → 404`, async () => {
      assert.equal((await S.get(`/ui/onboarding/${bad}`)).status, 404)
    })
  }
})

test('首页在渲染之前就把没引导过的人送走', async (t) => {
  const body = await (await S.get('/ui')).text()

  await t.test('重定向脚本在 <head> 里', () => {
    // 放到 body 里的话首页会先闪一帧再跳走
    const i = body.indexOf('ccm-onboarded')
    assert.ok(i > 0 && i < body.indexOf('</head>'), '重定向必须在 head 内，越早越好')
  })

  await t.test('用 replace 而不是 assign', () => {
    // assign 会留下历史记录，用户在引导里按返回会掉回一个空首页
    assert.match(body, /location\.replace\('\/ui\/onboarding\//)
  })

  await t.test('localStorage 抛异常时不拦截', () => {
    // 隐私模式下 localStorage 可能直接抛。引导没做成是小事，进不去首页是大事
    const i = body.indexOf('ccm-onboarded')
    const chunk = body.slice(i - 400, i + 400)
    assert.match(chunk, /try\s*\{/, '必须包在 try 里')
  })
})
