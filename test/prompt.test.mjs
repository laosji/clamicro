/**
 * 安装器问答的一条**安全不变式**：`optIn` 的问题谁都不许代答。
 *
 * 它写的是别人家的配置（`~/.dsh/profiles`、`~/.codex/config.toml`），所以
 * `--yes` 不算同意，stdin 关掉了也不算同意。
 *
 * 后半句此前是破的，而且破在一条没人会想到的路径上：`closePrompt()` 之后再
 * 问，`closed` 已经为真，`confirm()` 把「没人能回答」折成空行、按默认值答
 * 「是」，然后接着去改那两个文件——而用户一个字都没输入。安装流程恰恰在
 * closePrompt 之后才问 DSH / Codex，所以这条路径是**每次安装都会走到的**，
 * 只是要那台机器上正好装了 DSH 或 Codex 才看得出后果。
 *
 * 这一组用例就是钉住这件事。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { makePrompt } from '../src/prompt.mjs'

/** 一个只收不发的假 stdout，顺便把写进去的东西留下来给断言看。 */
const sink = () => {
  const out = { text: '', write(s) { this.text += s; return true } }
  return out
}

/** 用一段固定输入喂问答。不传 lines 就是「立刻 EOF」。 */
const withInput = (lines = [], opts = {}) => {
  const input = Readable.from(lines.map((l) => `${l}\n`))
  const output = sink()
  return { ...makePrompt({ input, output, ...opts }), output }
}

test('照常回答', async (t) => {
  await t.test('y / 空行都算同意', async () => {
    const p = withInput(['y', '', 'YES'])
    assert.equal(await p.confirm('Q1'), true)
    assert.equal(await p.confirm('Q2'), true)
    assert.equal(await p.confirm('Q3'), true)
  })

  await t.test('n 算拒绝', async () => {
    const p = withInput(['n'])
    assert.equal(await p.confirm('Q'), false)
  })

  // 管道输入答完就 EOF，后面的问题按默认（是）走 —— 这是原有语义，别改坏
  await t.test('管道答完之后，普通问题仍按默认「是」', async () => {
    const p = withInput(['n'])
    assert.equal(await p.confirm('第一问'), false)
    assert.equal(await p.confirm('第二问'), true)
  })
})

test('optIn 的问题谁都不许代答', async (t) => {
  await t.test('--yes 不算同意', async () => {
    const p = withInput([], { yes: true })
    assert.equal(await p.confirm('普通'), true)
    assert.equal(await p.confirm('改别人家的配置', true), false)
  })

  // 这一条就是那个真 bug：closePrompt 之后再问，原来会自问自答「是」
  await t.test('stdin 关掉之后也不算同意', async () => {
    const p = withInput(['y'])
    assert.equal(await p.confirm('第一问'), true)
    p.close()
    await new Promise((r) => setImmediate(r))
    assert.equal(await p.confirm('接 Codex 吗？', true), false,
      'stdin 已经关了，没人能回答 —— 这时候不许当成同意')
  })

  await t.test('输入还没来就 EOF，同样不算同意', async () => {
    const p = withInput([])
    assert.equal(await p.confirm('接 DSH 吗？', true), false)
  })

  await t.test('没人能回答时要说出来，不能默默跳过', async () => {
    const p = withInput([])
    await p.confirm('接 DSH 吗？', true)
    // 屏幕上留下一个「? [Y/n]」然后什么都不发生，会让人以为自己错过了一次输入
    assert.match(p.output.text, /未同意/)
  })
})

test('关掉之后普通问题的老行为不变', async () => {
  // 只收紧 optIn 那一档。普通问题在管道 EOF 后按默认「是」，是原有语义，
  // 顺手一起改会让 `printf 'y\\n' | install` 的后半段行为跟着变
  const p = withInput([])
  assert.equal(await p.confirm('普通问题'), true)
})
