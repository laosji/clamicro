/**
 * 单条审批的深链钥匙 `?k=`，在审批结束后必须很快失效。
 *
 * ## 承诺与实现对不上
 *
 * README 写的是：a leaked deep link can only decide that one approval,
 * **and expires with it**。
 *
 * 而实现里那把 key 的有效期实际跟着**记录**走——记录要到 24 小时后的
 * sweep 才清掉。也就是说：一条被转发出去的深链（它会进聊天记录、进浏览器
 * 历史、进截图），在那次审批早就结束之后，还能读整整一天的
 * **完整命令原文**（publicApproval 里的 detail 和 cwd）。
 *
 * 决定确实决定不了了（already_settled 会挡住），但「能读」本身就超出了承诺。
 * 而这把钥匙的全部设计前提就是「作用域极小、随那条审批一起消失」——
 * 正因为如此它才敢明文写在 URL 里。
 *
 * ## 为什么留两分钟而不是当场作废
 *
 * 手机上点完批准/拒绝，结果页还要用这个 key 再拉一次来显示结局。
 * 当场失效的话用户点完看到的是错误页，会以为操作没成功。
 *
 * 跑：node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startServer } from './helpers/server.mjs'

let srv
test.before(async () => { srv = await startServer({ port: 8801 }) })
test.after(async () => { await srv?.stop() })

/**
 * 造一条待审批。
 *
 * 走 /api/selftest/approval 而不是 hook 端点：只有它会**连 key 一起返回**。
 * 列表接口 (/api/approvals) 故意不吐 key —— 那是对的设计，这把钥匙的
 * 全部价值就在于「只有收到那条通知的人有」，列表里带上就等于人手一把。
 */
async function makePending() {
  const r = await fetch(`${srv.base}/api/selftest/approval`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${srv.token}` },
  })
  const { id, key } = await r.json()
  return { approval: { id, key } }
}

test('审批还没结束时，?k= 能读', async () => {
  const { approval } = await makePending()
  const r = await fetch(`${srv.base}/api/approvals/${approval.id}?k=${encodeURIComponent(approval.key)}`)
  assert.equal(r.status, 200)
  const body = await r.json()
  assert.ok(body.approval.detail.length > 0, '待审批时本来就该看得到命令原文')
})

test('结束之后短时间内仍能读 —— 结果页要用', async () => {
  const { approval } = await makePending()
  await fetch(`${srv.base}/api/approvals/${approval.id}/decide?k=${encodeURIComponent(approval.key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'deny' }),
  })
  const r = await fetch(`${srv.base}/api/approvals/${approval.id}?k=${encodeURIComponent(approval.key)}`)
  assert.equal(r.status, 200, '刚点完就失效的话，结果页会变成错误页')
  assert.equal((await r.json()).approval.status, 'denied')
})

test('登录令牌不受影响 —— 已配对的设备本来就该能翻历史', async () => {
  const { approval } = await makePending()
  await fetch(`${srv.base}/api/approvals/${approval.id}/decide?k=${encodeURIComponent(approval.key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'deny' }),
  })
  // 这里收紧的只是那把**能被转发出去**的单条钥匙，不是设备的访问权
  const r = await fetch(`${srv.base}/api/approvals/${approval.id}`, { headers: { Authorization: `Bearer ${srv.token}` } })
  assert.equal(r.status, 200)
})

test('钥匙不对一律 403，不管审批是什么状态', async () => {
  const { approval } = await makePending()
  const r = await fetch(`${srv.base}/api/approvals/${approval.id}?k=不是这把钥匙`)
  assert.equal(r.status, 403)
})

/**
 * 这条才是整个修复的目的：**宽限期一过，转发出去的链接就读不到了**。
 *
 * 用环境变量把宽限期压到 0，否则测试得等两分钟。压到 0 之后，
 * 「决定完立刻再读」就等价于「两分钟后再读」——判据是同一条。
 */
test('宽限期过后，?k= 再也读不到命令原文', async () => {
  const s2 = await startServer({ port: 8802, env: { CLAMICRO_SETTLED_KEY_GRACE_MS: '0' } })
  try {
    const r0 = await fetch(`${s2.base}/api/selftest/approval`, {
      method: 'POST', headers: { Authorization: `Bearer ${s2.token}` },
    })
    const { id, key } = await r0.json()

    // 决定之前能读
    assert.equal((await fetch(`${s2.base}/api/approvals/${id}?k=${encodeURIComponent(key)}`)).status, 200)

    await fetch(`${s2.base}/api/approvals/${id}/decide?k=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'deny' }),
    })

    const after = await fetch(`${s2.base}/api/approvals/${id}?k=${encodeURIComponent(key)}`)
    assert.equal(after.status, 403, '审批结束后这把钥匙必须失效 —— README 承诺的是 expires with it')
    assert.equal((await after.json()).error, 'expired')

    // 但登录令牌照样能读：收紧的只是那把能被转发出去的钥匙
    assert.equal((await fetch(`${s2.base}/api/approvals/${id}`, {
      headers: { Authorization: `Bearer ${s2.token}` },
    })).status, 200)
  } finally {
    await s2.stop()
  }
})
