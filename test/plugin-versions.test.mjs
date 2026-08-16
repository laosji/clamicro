/**
 * 两个 DSH 插件的版本号必须等于 clamicro 的版本号。
 *
 * 它们随 clamicro 一起发布、不单独发 npm、也不单独打 tag（这是产品决定：
 * 这本来就是一个产品）。既然如此，各自维护一个版本号只会制造假信息——
 * 2.15.0 那次发出去的包里，插件写着 0.2.0 和 0.1.0，拿这两个号去翻变更记录
 * 什么也找不到。
 *
 * 没有任何代码读它们（compat.js 里读的是 **DSH 自己的** 版本），所以漂了不会
 * 报错，只会安静地骗人——正好是要用测试钉住的那一类。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sync, rootVersion, bumpVersionText, PLUGIN_PKGS } from '../scripts/sync-plugin-versions.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('插件版本和 clamicro 一致', () => {
  const want = rootVersion()
  for (const rel of PLUGIN_PKGS) {
    const got = JSON.parse(readFileSync(join(root, rel), 'utf8')).version
    assert.equal(
      got, want,
      `${rel} 是 ${got}，clamicro 是 ${want}。\n` +
      '它们随 clamicro 一起发，版本号必须跟着走。\n' +
      '修：node scripts/sync-plugin-versions.mjs',
    )
  }
})

test('sync 是幂等的 —— 已经对齐时不写盘', () => {
  const { changed } = sync({ write: false })
  assert.deepEqual(changed, [], `还有没对齐的：${changed.map((c) => c.rel).join('、')}`)
})

test('只动 version 那一行，别的一个字符都不改', () => {
  /**
   * 直接测纯函数，**不碰任何文件**。
   *
   * 前两版这条都写坏了，两种坏法都值得记下来：
   *   1. 断言「有 name / exports / files」——可 dsh-bridge 本来就没有 exports，
   *      红的是断言本身。挑字段点名既漏（没点到的丢了发现不了）又假。
   *   2. 改成比对文件前后，却在中间调了会写盘的 sync()——于是「文件没被改」
   *      永远成立，还顺手把埋进去的变异修好了。测试写真实文件，就是刚刚
   *      让 removePlugins 删掉开发机上真插件的同一个错。
   */
  const raw = [
    '{',
    '  "name": "x",',
    '  "version": "0.1.0",',
    '  "keywords": ["a", "b"],',
    '  "_comment": "位置和缩进都不该动",',
    '  "nested": { "deep": true }',
    '}',
    '',
  ].join('\n')

  const next = bumpVersionText(raw, '2.15.0')
  assert.equal(JSON.parse(next).version, '2.15.0')
  // 除 version 那一行外逐行相同
  const a = raw.split('\n')
  const b = next.split('\n')
  assert.equal(a.length, b.length, '行数变了，说明被重新序列化过')
  for (let i = 0; i < a.length; i++) {
    if (a[i].includes('"version"')) continue
    assert.equal(b[i], a[i], `第 ${i} 行被动了：${JSON.stringify(a[i])} → ${JSON.stringify(b[i])}`)
  }
})

test('真实的两个 package.json 结构完好', () => {
  for (const rel of PLUGIN_PKGS) {
    const pkg = JSON.parse(readFileSync(join(root, rel), 'utf8'))
    assert.ok(pkg.name, `${rel} 没有 name`)
    assert.ok(Array.isArray(pkg.files), `${rel} 的 files 丢了`)
  }
})
