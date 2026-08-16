/**
 * 终端里的猫和网页上的猫必须是同一只。
 *
 * src/cat-art.mjs 是从 plugins/dsh-pet-cat/dev/art.mjs **生成**的拷贝，
 * 存在的唯一理由是 plugins/ 不随 clamicro 的 npm 包发布（它是给 DSH 装的
 * 插件，单独发），所以运行时 import 不到源头。
 *
 * 拷贝就会漂。改了 art.mjs 忘了重新导出，结果是网页上的猫换了样子、终端里
 * 的还是旧的——两只不一样的猫，而且没有任何东西会提示你。所以这里直接跑
 * 一遍生成器，拿它的输出和磁盘上那份逐字节比。
 *
 * 顺带把渲染也钉住：ANSI 转义、非 TTY 静默、NO_COLOR。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { render } from '../plugins/dsh-pet-cat/dev/export-to-clamicro.mjs'
import { frames } from '../plugins/dsh-pet-cat/dev/art.mjs'
import { grid, palette, canvas } from '../src/cat-art.mjs'
import { catLines, catBlock, colorDepth } from '../src/cat.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('src/cat-art.mjs 和 art.mjs 没有漂', () => {
  const onDisk = readFileSync(join(root, 'src/cat-art.mjs'), 'utf8')
  assert.equal(
    onDisk,
    render(),
    'src/cat-art.mjs 和 plugins/dsh-pet-cat/dev/art.mjs 对不上了。\n' +
    '重新生成：node plugins/dsh-pet-cat/dev/export-to-clamicro.mjs',
  )
})

test('导出的就是 idle 帧', () => {
  const idle = frames.find((f) => f.id === 'idle')
  assert.deepEqual(grid, idle.grid)
})

test('几何和调色板都对得上', () => {
  assert.equal(grid.length, canvas.height)
  for (const row of grid) assert.equal(row.length, canvas.width)
  for (const row of grid) {
    for (const ch of row) {
      if (ch !== '.') assert.ok(palette[ch], `未知色号 ${ch}`)
    }
  }
})

const TTY = { isTTY: true }

test('16×16 画成 8 行', () => {
  const lines = catLines({ depth: 'truecolor' })
  assert.equal(lines.length, 8)
})

test('每一格都自己 reset —— 否则背景色会流到行尾', () => {
  // 不 reset 的话，窄终端上会从猫的右边一路拖出一条橙色长条
  for (const line of catLines({ depth: 'truecolor' })) {
    assert.ok(line.endsWith('[0m'), `这一行没有以 reset 收尾: ${JSON.stringify(line)}`)
  }
})

test('真彩用 24 位，降级用 256', () => {
  const t = catLines({ depth: 'truecolor' }).join('')
  assert.match(t, /\[38;2;\d+;\d+;\d+m/)
  assert.doesNotMatch(t, /\[38;5;/)

  const c = catLines({ depth: '256' }).join('')
  assert.match(c, /\[38;5;\d+m/)
  assert.doesNotMatch(c, /\[38;2;/)
})

test('NO_COLOR 一律不画', () => {
  assert.equal(colorDepth({ NO_COLOR: '1', COLORTERM: 'truecolor' }, TTY), null)
})

test('非 TTY 不画 —— 重定向到文件时一屏转义字符是纯污染', () => {
  assert.equal(colorDepth({ COLORTERM: 'truecolor' }, { isTTY: false }), null)
  assert.equal(colorDepth({ COLORTERM: 'truecolor' }, undefined), null)
})

test('探测各类终端', () => {
  assert.equal(colorDepth({ COLORTERM: 'truecolor' }, TTY), 'truecolor')
  assert.equal(colorDepth({ COLORTERM: '24bit' }, TTY), 'truecolor')
  assert.equal(colorDepth({ TERM_PROGRAM: 'iTerm.app' }, TTY), 'truecolor')
  assert.equal(colorDepth({ TERM: 'xterm-256color' }, TTY), '256')
  assert.equal(colorDepth({ TERM_PROGRAM: 'Apple_Terminal' }, TTY), '256')
  // 只有 16 色就放弃：这几个橙硬映射过去会难看到不如不画
  assert.equal(colorDepth({ TERM: 'xterm' }, TTY), null)
  assert.equal(colorDepth({}, TTY), null)
})

test('画不出来时返回空串，调用方不必自己判断', () => {
  assert.equal(catBlock({ depth: null }), '')
  assert.ok(catBlock({ depth: 'truecolor' }).endsWith('\n'))
})

test('源码里没有裸 ESC 控制字符', () => {
  // 裸控制字符在 diff、复制粘贴、以及会清洗控制字符的编辑器里都可能悄悄
  // 消失，而消失之后代码照样能解析——只是颜色没了。用  写。
  const src = readFileSync(join(root, 'src/cat.mjs'), 'utf8')
  assert.equal(src.split(String.fromCharCode(27)).length - 1, 0)
})
