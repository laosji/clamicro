/**
 * 安装器接 DSH 的那段流程。
 *
 * 这套测试是补票：那段代码已经发到 npm 才第一次被执行——我在沙箱 HOME 里
 * 手跑了一遍真实安装，当场发现打印待粘贴的行时多加了两个空格前缀，屏幕上
 * 6 空格、文件里要 4 空格，照抄正好破坏那个 `- insert:` 块。而这条路径的
 * 全部意义就是「不敢自动改你的 YAML，给你一份抄本」。
 *
 * 那次是手敲的一次性验证，下次改 install.mjs 不会自动跑到。所以把流程抽成
 * wireUp() 并在这里钉住——**断言的是实际打印出来的字符串**，不是「函数返回
 * 的行对不对」：出错的正是打印那一步，行本身一直是对的。
 *
 * 不 spawn 真安装：那要起服务、绑端口、探网络，慢且容易假红，而且覆盖不到
 * 更多东西——真正脆的就是这段文本和分支。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { wireUp, patchProfile, PATCH_FILE } from '../src/dsh.mjs'

/** 收集所有 say() 出来的行；ui 默认恒等函数，所以拿到的是干净字符串 */
function rig({ dsh = true, answer = true, patch, install } = {}) {
  const lines = []
  const asked = []
  return {
    lines,
    asked,
    run: () => wireUp({
      here: '/fake/app',
      port: 8891,
      say: (s = '') => lines.push(s),
      confirm: (q, optIn) => { asked.push({ q, optIn }); return Promise.resolve(answer) },
      detect: () => dsh,
      install: install ?? (() => ['clamicro-dsh-bridge', 'dsh-pet-cat']),
      patch: patch ?? (() => ({ action: 'patched' })),
    }),
  }
}

test('没有 DSH 就完全不出声', async () => {
  const r = rig({ dsh: false })
  const out = await r.run()
  assert.equal(out.action, 'no-dsh')
  assert.deepEqual(r.lines, [], '没装 DSH 的人不该看到任何一行 DSH 相关的话')
  assert.deepEqual(r.asked, [], '也不该被问')
})

test('这个确认必须是 optIn —— --yes 不能替用户写别人家的配置', async () => {
  const r = rig()
  await r.run()
  assert.equal(r.asked.length, 1)
  assert.equal(
    r.asked[0].optIn, true,
    'optIn 传错，--yes 就会静默改用户的 ~/.dsh —— README 里明文承诺过不会',
  )
})

test('拒绝就什么都不做', async () => {
  let installed = false
  let patched = false
  const r = rig({
    answer: false,
    install: () => { installed = true; return [] },
    patch: () => { patched = true; return { action: 'patched' } },
  })
  const out = await r.run()
  assert.equal(out.action, 'declined')
  assert.equal(installed, false, '用户说了不要，还是装了')
  assert.equal(patched, false, '用户说了不要，还是改了配置')
  assert.ok(r.lines.some((l) => l.includes('跳过')))
})

test('manual：待粘贴的行原样打印，一个前缀都不许加', async () => {
  const rows = [
    '    - id: pet-cat',
    '      name: dsh-pet-cat',
    '    - id: clamicro-bridge',
    '      name: clamicro-dsh-bridge',
    '      config:',
    "        origin: 'http://127.0.0.1:8891'",
    '        approve: true',
    "        askTools: ['bash']",
  ]
  const r = rig({ patch: () => ({ action: 'manual', rows }) })
  const out = await r.run()
  assert.equal(out.action, 'manual')

  // 这就是那个 bug：每一行都必须**逐字符**出现在输出里
  for (const row of rows) {
    assert.ok(
      r.lines.includes(row),
      `这一行没有原样打印出来（多半是被加了前缀）：${JSON.stringify(row)}\n` +
      `实际打印的相近行：${JSON.stringify(r.lines.find((l) => l.trim() === row.trim()))}`,
    )
  }
  assert.ok(r.lines.some((l) => l.includes('格式不认识')), '得说清楚为什么要你手动贴')
  assert.ok(r.lines.some((l) => l.includes(PATCH_FILE)), '得告诉你是哪个文件')
})

test('manual 时仍然把插件文件装好 —— 贴完就能用', async () => {
  const r = rig({ patch: () => ({ action: 'manual', rows: ['    - id: x'] }) })
  const out = await r.run()
  assert.deepEqual(out.installed, ['clamicro-dsh-bridge', 'dsh-pet-cat'])
})

test('already：说清楚没重复写', async () => {
  const r = rig({ patch: () => ({ action: 'already' }) })
  const out = await r.run()
  assert.equal(out.action, 'already')
  assert.ok(r.lines.some((l) => l.includes('已经有了')))
  assert.ok(!r.lines.some((l) => l.includes('重启 DSH')), '没改动就别让人白重启')
})

test('patched：提醒要重启 DSH 才生效', async () => {
  const r = rig()
  await r.run()
  assert.ok(r.lines.some((l) => l.includes('重启 DSH')), '不说的话用户会以为没生效')
})

test('接 DSH 失败不能拖垮整个安装', async () => {
  const r = rig({ install: () => { throw new Error('找不到插件源目录 /fake/app/plugins/dsh-bridge') } })
  const out = await r.run()
  assert.equal(out.action, 'failed')
  assert.match(out.error, /找不到插件源目录/)
  assert.ok(r.lines.some((l) => l.includes('Claude Code 那边不受影响')),
    '得让人知道主功能是好的，否则会以为整个装砸了')
})

test('ui 只做装饰，不改内容', async () => {
  // install.mjs 传的是带 ANSI 的着色函数。装饰不该影响待粘贴的行——
  // 那几行如果被包上转义序列，复制出来就带垃圾
  const rows = ['    - id: pet-cat']
  const lines = []
  await wireUp({
    here: '/fake/app', port: 8891,
    say: (s = '') => lines.push(s),
    confirm: () => Promise.resolve(true),
    detect: () => true,
    install: () => [],
    patch: () => ({ action: 'manual', rows }),
    ui: { b: (s) => `<b>${s}</b>`, dim: (s) => `<d>${s}</d>`, g: (s) => s, y: (s) => s },
  })
  assert.ok(lines.includes('    - id: pet-cat'), '待粘贴的行被装饰污染了')
})

/**
 * plugins/README.md 里那段 YAML 是给人**照抄**的，所以它和 insertRows() 是
 * 同一份内容的两个副本——副本会漂。
 *
 * 上一次漂的结果是整节都错了：README 说这两个插件「不随 npm 包发布」，
 * 而 package.json 的 files 里早就有 plugins/ 了；同一节里的 YAML 顺序、
 * origin 的引号也和代码实际写出去的不一样。照着抄的人贴进 cordis.patch.yml
 * 的是一份代码从没生成过的东西。
 *
 * 断言用 includes 而不是逐行 find：块内的**顺序和相邻关系**也是结构的一部分。
 */
test('plugins/README.md 的待抄 YAML 和 insertRows() 逐字一致', () => {
  let written = ''
  patchProfile(8765, {
    read: () => '',
    write: (_p, c) => { written = c },
    exists: () => false,
    mkdir: () => {},
  })
  // FRESH_PATCH 里带缩进的就是 insertRows() 那几行
  const block = written.split('\n').filter((l) => l.startsWith('    ')).join('\n')

  const readme = readFileSync(new URL('../plugins/README.md', import.meta.url), 'utf8')
  assert.ok(
    readme.includes(block),
    `plugins/README.md 里的 YAML 和代码生成的对不上，照抄会贴错。\n代码生成的是：\n${block}`,
  )
})
