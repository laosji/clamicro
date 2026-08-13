/**
 * 文档里写的默认值必须和代码一致。
 *
 * 这条被现实推出来过两次：默认等待时长从 570 秒改成 180 秒之后，中文指南
 * 还写着「约 9 分半」，英文指南写着「~9.5 min」——两处都在**发布前的最后
 * 一轮检查**才被抓到，而它们已经在仓库里躺了很久。
 *
 * 文档说错默认值的后果不是「不好看」：用户据此判断「离开电脑多久任务才会
 * 失败」，差了三倍。而这种错永远不会让任何测试变红，除非专门写一条。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')
const src = read('src/config.mjs')
const num = (key) => Number(String(src.match(new RegExp(`${key}:\\s*([0-9_]+)`))[1]).replace(/_/g, ''))

const DOCS = ['README.md', 'docs/guide.md', 'docs/guide.zh-CN.md']

test('文档不得残留旧的超时值', async (t) => {
  const timeoutMin = num('timeoutMs') / 60_000

  await t.test('代码默认值就是 3 分钟', () => {
    assert.equal(timeoutMin, 3, '默认值改了的话，下面几条断言和文档都要跟着改')
  })

  for (const f of DOCS) {
    await t.test(`${f} 不再说 9 分半`, () => {
      const s = read(f)
      // 570 秒是**硬上限**，文档里提它是对的；「9 分半 / 9.5 min」是把上限
      // 当成默认值在说，那是错的
      assert.doesNotMatch(s, /9\.5\s*min|9 分半|9分半/,
        '这是旧的 570s 默认值，现在默认是 3 分钟')
    })
  }
})

test('文档不得残留旧的自动通过时长', async (t) => {
  const autoSec = num('autoApproveMs') / 1000
  await t.test('代码默认值是 10 秒', () => {
    assert.equal(autoSec, 10)
  })
  for (const f of DOCS) {
    await t.test(`${f} 说的也是 10 秒`, () => {
      const s = read(f)
      // 只在文档确实提到「自动通过」时才校验，避免误伤
      if (!/自动通过|auto-approve|auto-pass/i.test(s)) return
      assert.match(s, /10\s*(seconds?\b|s\b|秒)/, `${f} 提到了自动通过却没写 10 秒`)
    })
  }
})

test('README 必须写明风险识别不是沙箱', () => {
  // 正则挡不住 base64 解码后管道执行、变量间接引用、curl | sh。
  // 不写清楚的话，「普通」这个标签会被读成「安全」
  const s = read('README.md')
  assert.match(s, /not a sandbox/i, 'README 要明说风险识别只是提示')
  assert.match(s, /base64/i, '要给出具体的绕过例子，不能只说一句抽象的话')
})

test('文档不得声称自动通过的操作「不推送」', async (t) => {
  // notifyAutoApproved 默认是 true —— 它们**会**推送。文档曾经写反，而这正是
  // 「我明明手动批了却提示已自动通过」那个困惑的来源：人收到通知、点进去、
  // 划一下，而那条早在 10 秒时就自己过了。
  const src = readFileSync(join(root, 'src/config.mjs'), 'utf8')
  const on = /notifyAutoApproved:\s*true/.test(src)
  await t.test('代码里默认开着', () => assert.equal(on, true))
  for (const f of DOCS) {
    await t.test(`${f} 没说反`, () => {
      assert.doesNotMatch(readFileSync(join(root, f), 'utf8'),
        /deliberately don't notify|不会推送|故意不推送/,
        '默认是会推送的')
    })
  }
})
