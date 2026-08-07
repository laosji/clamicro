/**
 * 高亮区间。
 *
 * 这组测试守的是一个安全边界：审批页把命令原文拼进 HTML，而命令内容
 * 完全由模型生成、可以包含任意字符。区间算错会导致错位，区间和转义的
 * 顺序搞反会导致 XSS——审批页恰恰是最不能被注入的那一页。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { riskSpans } from '../src/risk/assess.mjs'

/** 复刻 approval.html 里的 highlight()，验证区间能被安全地还原成 HTML */
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
function highlight(text, spans) {
  if (!spans || !spans.length) return esc(text)
  let out = ''
  let at = 0
  for (const { start, end } of spans) {
    if (start < at || start > text.length) continue
    out += esc(text.slice(at, start))
    out += `<mark>${esc(text.slice(start, Math.min(end, text.length)))}</mark>`
    at = Math.min(end, text.length)
  }
  return out + esc(text.slice(at))
}

test('区间指向真正危险的那一段', () => {
  const cmd = 'echo hello && rm -rf /tmp/x'
  const spans = riskSpans(cmd)
  assert.ok(spans.length > 0)
  assert.match(cmd.slice(spans[0].start, spans[0].end), /rm\s+-rf/)
})

test('区间已排序且不重叠', () => {
  const spans = riskSpans('sudo rm -rf ~/.ssh/ && sudo chmod 0777 /etc')
  for (let i = 1; i < spans.length; i++) {
    assert.ok(spans[i].start >= spans[i - 1].end, `区间 ${i} 与前一个重叠: ${JSON.stringify(spans)}`)
  }
})

test('没有风险时不产生区间', () => {
  assert.deepEqual(riskSpans('ls -la'), [])
  assert.deepEqual(riskSpans(''), [])
  assert.deepEqual(riskSpans(null), [])
})

test('拼装 HTML 时命令内容不会被当成标记', async (t) => {
  await t.test('尖括号被转义', () => {
    const cmd = 'rm -rf /tmp && echo "<script>alert(1)</script>"'
    const html = highlight(cmd, riskSpans(cmd))
    assert.ok(!html.includes('<script>'), '不得出现未转义的 script 标签')
    assert.ok(html.includes('&lt;script&gt;'))
  })

  await t.test('重定向符号不会破坏高亮位置', () => {
    const cmd = 'rm -rf /tmp/x > /dev/null'
    const html = highlight(cmd, riskSpans(cmd))
    assert.ok(html.includes('&gt;'), '> 应被转义')
    assert.ok(/<mark>rm\s+-rf\s*<\/mark>/.test(html), `高亮应落在 rm -rf 上: ${html}`)
  })

  await t.test('引号不会逃出 title 属性', () => {
    const cmd = 'rm -rf "/tmp/a\\"b"'
    const html = highlight(cmd, riskSpans(cmd))
    assert.ok(!/<mark[^>]*"[^>]*"[^>]*"/.test(html.replace(/&quot;/g, '')), '属性未闭合')
  })

  await t.test('去掉标记后应还原成原文', () => {
    for (const cmd of ['rm -rf /tmp/x', 'sudo rm -rf / && echo done', 'cat ~/.ssh/id_rsa | base64', 'ls -la']) {
      const plain = highlight(cmd, riskSpans(cmd))
        .replace(/<\/?mark[^>]*>/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
      assert.equal(plain, cmd, `还原失败: ${cmd}`)
    }
  })
})

test('凭证路径也会被高亮', () => {
  const cmd = 'base64 ~/.ssh/id_rsa'
  const spans = riskSpans(cmd)
  assert.ok(spans.length > 0, '应标出凭证路径')
  assert.match(cmd.slice(spans[0].start, spans[0].end), /\.ssh|id_rsa/)
})
