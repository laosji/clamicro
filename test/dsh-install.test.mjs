/**
 * DSH 插件接入。
 *
 * 最要紧的是 patchProfile：这个项目零依赖，**没有 YAML 解析器**，所以它是
 * 按行改一个用户的配置文件。改坏了 DSH 整个 profile 起不来，而用户根本不会
 * 想到是装 clamicro 弄的。所以这里重点钉三件事：
 *   · 幂等 —— 重复安装不写重
 *   · 认不出的形状一律不动手，返回 manual 让人自己贴
 *   · 摘除只摘我们放进去的，用户自己的行原样保留
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { patchProfile, removePlugins, PLUGINS } from '../src/dsh.mjs'

/**
 * 假的文件系统。
 *
 * `rm` 和 `exists` 也必须注入 —— 这里踩过一次，而且是真踩：第一版只拦了
 * 补丁文件的读写，removePlugins 里的 rmSync 直接打到真实文件系统，跑一次
 * 测试就把开发机上 ~/.dsh/profiles/node_modules 里**真正装着的插件删了**，
 * DSH 当场 404。测试删掉用户的东西，比测试没覆盖到还糟。
 *
 * 所以：这个模块里任何会写盘的调用，都要能从参数里换掉。
 */
function fake(initial) {
  const box = { text: initial, writes: 0, removed: [] }
  return {
    box,
    read: () => {
      if (box.text === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return box.text
    },
    write: (_p, data) => { box.text = data; box.writes++ },
    rm: (dir) => box.removed.push(dir),
    mkdir: () => {},
    // 补丁文件当作存在，插件目录当作不存在（除非某条用例另说）
    exists: (p) => (p.endsWith('.yml') ? box.text !== null : false),
  }
}

const EXISTING = [
  '# Your patch layer for this dsh profile',
  '- insert:',
  '    - id: someone-elses',
  '      name: their-plugin',
  '',
].join('\n')

test('已经装过就什么都不做（幂等）', () => {
  const withOurs = [
    '- insert:',
    '    - id: pet-cat',
    '      name: dsh-pet-cat',
    '    - id: clamicro-bridge',
    '      name: clamicro-dsh-bridge',
    '',
  ].join('\n')
  const f = fake(withOurs)
  const r = patchProfile(8765, f)
  assert.equal(r.action, 'already')
  assert.equal(f.box.writes, 0, '幂等就是一个字节都不该写')
})

test('插进已有的 insert 块，别人的行原样保留', () => {
  const f = fake(EXISTING)
  const r = patchProfile(8765, f)
  assert.equal(r.action, 'patched')
  assert.match(f.box.text, /name: clamicro-dsh-bridge/)
  assert.match(f.box.text, /name: dsh-pet-cat/)
  assert.match(f.box.text, /name: their-plugin/, '别人的插件被我们弄没了')
  assert.match(f.box.text, /origin: 'http:\/\/127\.0\.0\.1:8765'/)
})

test('端口不是写死的 8765', () => {
  const f = fake(EXISTING)
  patchProfile(9999, f)
  assert.match(f.box.text, /127\.0\.0\.1:9999/)
})

test('只装了一半时，只补缺的那块', () => {
  const half = ['- insert:', '    - id: pet-cat', '      name: dsh-pet-cat', ''].join('\n')
  const f = fake(half)
  patchProfile(8765, f)
  assert.equal((f.box.text.match(/name: dsh-pet-cat/g) ?? []).length, 1, '猫被写了两遍')
  assert.equal((f.box.text.match(/name: clamicro-dsh-bridge/g) ?? []).length, 1)
})

test('认不出的形状不动手 —— 改不认识的 YAML 比不改危险', () => {
  const weird = 'somethingElse:\n  nested: true\n'
  const f = fake(weird)
  const r = patchProfile(8765, f)
  assert.equal(r.action, 'manual')
  assert.equal(f.box.writes, 0, '认不出还写了，这正是最该避免的')
  assert.ok(r.rows.some((l) => l.includes('clamicro-dsh-bridge')), '得把要贴的行给出来')
})

test('摘除只摘我们的行', () => {
  const mixed = [
    '- insert:',
    '    - id: someone-elses',
    '      name: their-plugin',
    '    - id: pet-cat',
    '      name: dsh-pet-cat',
    '    - id: clamicro-bridge',
    '      name: clamicro-dsh-bridge',
    '      config:',
    "        origin: 'http://127.0.0.1:8765'",
    '        approve: true',
    '',
  ].join('\n')
  const f = fake(mixed)
  removePlugins(f)
  assert.doesNotMatch(f.box.text, /dsh-pet-cat/)
  assert.doesNotMatch(f.box.text, /clamicro-dsh-bridge/)
  assert.doesNotMatch(f.box.text, /approve: true/, 'config 子行留下了，YAML 会坏')
  assert.match(f.box.text, /name: their-plugin/, '把别人的插件也摘了')
  assert.match(f.box.text, /^- insert:/m, 'insert 块本身不该被删')
})

test('没装过时摘除是空操作', () => {
  const f = fake(EXISTING)
  removePlugins(f)
  assert.equal(f.box.writes, 0, '没有我们的东西还写盘，卸载的下界是「什么都没变」')
})

test('manual 给出的行，照抄下去要和自动写的一模一样', () => {
  /**
   * manual 这条路径的**全部意义**就是让人照抄，而 YAML 里缩进就是结构。
   *
   * 这里真踩过：install.mjs 打印时写的是 say(`  ${line}`)，屏幕上就成了
   * 6 个空格，而文件里要的是 4 个。抄下去正好破坏那个 `- insert:` 块——
   * 而我们绕这么大弯子不敢自动改它，就是为了别把它弄坏。
   *
   * 所以钉的性质是：manual 返回的行，必须和「文件不存在时我们自己写出来的
   * 那份」里对应的行**逐字符相同**。屏幕上多一个空格，这条就该红。
   */
  const weird = fake('somethingElse:\n  nested: true\n')
  const manual = patchProfile(8765, weird)
  assert.equal(manual.action, 'manual')

  const fresh = fake(null)
  fresh.exists = () => false
  patchProfile(8765, fresh)
  const written = fresh.box.text.split('\n')

  for (const row of manual.rows) {
    assert.ok(
      written.includes(row),
      `这一行不在自动生成的文件里，说明缩进或内容对不上：${JSON.stringify(row)}`,
    )
  }
  // 缩进具体是多少也钉死：条目 4 空格、子键 6 空格
  assert.equal(manual.rows[0], '    - id: pet-cat')
  assert.equal(manual.rows[1], '      name: dsh-pet-cat')
})

test('删目录也走注入 —— 测试绝不能碰真实的 ~/.dsh', () => {
  const f = fake(EXISTING)
  f.exists = () => true // 假装两个插件目录都在
  const r = removePlugins(f)
  assert.deepEqual(r.removed, ['clamicro-dsh-bridge', 'dsh-pet-cat'])
  assert.equal(f.box.removed.length, 2, 'rm 没走注入，说明打到真实文件系统了')
  for (const d of f.box.removed) assert.match(d, /node_modules/)
})

test('桥接是必需的，猫是可选的', () => {
  const bridge = PLUGINS.find((p) => p.name === 'clamicro-dsh-bridge')
  const cat = PLUGINS.find((p) => p.name === 'dsh-pet-cat')
  assert.equal(bridge.required, true, '没有桥接，DSH 的事件一条都到不了')
  assert.equal(cat.required, false)
})
