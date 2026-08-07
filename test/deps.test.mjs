/**
 * 路由工厂的依赖检查。
 *
 * 对应今天的一个 bug：删 Bark 时把 pageRoutes({ …, push, … }) 的 push 直接
 * 删掉、忘了换成 notify，于是解构出 undefined。JS 不在那一刻报错，要等用户
 * 点「在 Mac 上显示二维码」才抛「notify is not a function」——服务日志一声不响。
 *
 * 同类错误今天犯了两次（另一次是 store.applyHook 解构出的 notify 遮蔽了通知
 * 函数）。所以把它挪到启动时：缺依赖 = 服务起不来，日志第一行写明缺哪个。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { requireDeps } from '../src/routes/deps.mjs'
import { pageRoutes } from '../src/routes/pages.mjs'
import { hookRoutes } from '../src/routes/hooks.mjs'
import { apiRoutes } from '../src/routes/api.mjs'

test('requireDeps 报出缺的是哪一个', () => {
  assert.throws(
    () => requireDeps('someRoutes', { a: 1 }, ['a', 'b', 'c']),
    /someRoutes 缺少依赖: b, c/,
  )
})

test('齐全时放行', () => {
  assert.doesNotThrow(() => requireDeps('x', { a: 1, b: false, c: 0 }, ['a', 'b', 'c']))
})

test('三个路由工厂都在装配时检查依赖', async (t) => {
  // 就是这个 bug 的形状：漏传一个，必须当场炸，而不是等用户点按钮
  await t.test('pageRoutes 漏 notify', () => {
    assert.throws(
      () => pageRoutes({ config: {}, approvals: {}, auth: {}, publicApproval: () => {}, HERE: '/x' }),
      /pageRoutes 缺少依赖: notify/,
    )
  })
  await t.test('hookRoutes 漏 notify', () => {
    assert.throws(
      () => hookRoutes({ config: {}, store: {}, approvals: {}, control: {}, inbox: {}, history: {}, notifyApproval: () => {} }),
      /hookRoutes 缺少依赖: notify/,
    )
  })
  await t.test('apiRoutes 漏 network', () => {
    assert.throws(
      () => apiRoutes({
        config: {}, store: {}, approvals: {}, control: {}, inbox: {}, notify: () => {},
        saveConfig: () => {}, auth: {}, publicApproval: () => {}, notifyApproval: () => {},
        sseClients: new Set(), HERE: '/x',
      }),
      /apiRoutes 缺少依赖: network/,
    )
  })
})
