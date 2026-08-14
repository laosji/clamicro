/**
 * 每个页面都必须挡住缩放。
 *
 * 这条被现实推出来过：新加的 onboarding / pair-wait 两页、以及一直没人动过的
 * pair-expired，viewport 里都少了 `user-scalable=no`，pair-expired 连
 * `touch-action:manipulation` 都没有。表现是**双击就把页面放大**，而这个界面
 * 是手势优先的——审批页要左右拖决策条，放大之后拖动会被读成平移画布。
 *
 * 加页面时漏掉这一行不会有任何报错，只有在真机上双击才看得出来。所以钉住它。
 *
 * 两样都要，各挡一半：
 *   · user-scalable=no / maximum-scale=1 —— Android 和桌面浏览器认这个
 *   · touch-action:manipulation —— iOS Safari 从 10 起就忽略上面那个，
 *     双击缩放只能靠它挡（顺带去掉双击等待的 300ms）
 *
 * 捏合缩放在 iOS 上无论如何禁不掉，这是系统行为，不必尝试。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const uiDir = join(root, 'ui')
const pages = readdirSync(uiDir).filter((f) => f.endsWith('.html')).sort()

test('ui/ 下有页面可测', () => {
  assert.ok(pages.length >= 8, `只找到 ${pages.length} 个页面，是不是路径错了`)
})

for (const p of pages) {
  test(`${p} 挡住了缩放`, async (t) => {
    const s = readFileSync(join(uiDir, p), 'utf8')

    await t.test('有 viewport', () => {
      assert.match(s, /<meta name="viewport"/, '缺 viewport，手机上会按桌面宽度渲染')
    })

    await t.test('user-scalable=no', () => {
      const vp = s.match(/<meta name="viewport" content="([^"]*)"/)[1]
      assert.match(vp, /user-scalable=no/, 'Android / 桌面浏览器靠它')
      assert.match(vp, /maximum-scale=1/)
    })

    await t.test('viewport-fit=cover —— 否则刘海机上会留白边', () => {
      const vp = s.match(/<meta name="viewport" content="([^"]*)"/)[1]
      assert.match(vp, /viewport-fit=cover/)
    })

    await t.test('touch-action:manipulation', () => {
      // iOS Safari 忽略 user-scalable=no，双击缩放只能靠这个挡
      assert.match(s, /touch-action:\s*manipulation/, 'iOS 上双击会放大页面')
    })
  })
}
