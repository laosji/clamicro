/**
 * `agentUsage` —— 分区标题和空闲卡上那行用量。
 *
 * ## 为什么值得单独测
 *
 * 它是**多个数据源汇成一行字**的地方：账户级窗口（Claude 的 statusLine）、
 * 后端自报窗口（Codex 的 rollout）、累计 token（DSH / Codex）、以及三种
 * 「没有数字」的不同含义。汇错了不会报错，只会在界面上少一段或者说错话。
 *
 * 直接从 home.html 里把函数抠出来跑：那段逻辑没有 DOM 依赖，而为了测它
 * 把整页搬进 jsdom 要引一个依赖（本项目零依赖），照抄一份到测试里则会
 * 立刻和真实代码漂开——那正是 ui-shared.test.mjs 在防的事。
 *
 * ## 主要挡的那个回归
 *
 * 后端自报的窗口一度**只在 `quota === 'tokens'` 分支里被读**。于是把
 * Codex 的 quota 档位改成别的，30 天窗口会跟着从界面上消失，而没有任何
 * 测试变红——改的是 agents.mjs 里一个看起来无关的字段。
 * docs/architecture.zh-CN.md §6.3 把这个隐式耦合记了下来，这个文件关掉它。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

import { AGENTS, QUOTA } from '../src/agents.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 从 home.html 里抠出 agentUsage 的源码。
 *
 * 按大括号配平找结尾，不用正则数行数：函数体里有 `}` 结尾的模板串和注释，
 * 正则版本会在下一次有人加一行时安静地截错，而截错的表现是语法错误——
 * 那种失败至少是响的，但配平版本连这一步都不会走到。
 */
function extractFn(name) {
  const src = readFileSync(join(root, 'ui/home.html'), 'utf8')
  const i = src.indexOf(`function ${name}(`)
  assert.notEqual(i, -1, `home.html 里找不到 ${name}，是不是改名了？`)
  let depth = 0, started = false, j = i
  for (; j < src.length; j++) {
    if (src[j] === '{') { depth++; started = true }
    else if (src[j] === '}') { depth--; if (started && depth === 0) { j++; break } }
  }
  return src.slice(i, j)
}

/** 造一个跑得动 agentUsage 的最小环境。依赖都是纯函数，不涉及 DOM。 */
function run({ agentLimits = {}, quota = null, stale = false } = {}) {
  const ctx = vm.createContext({
    agentLimits,
    quota,
    esc: (s) => String(s),
    fmtTokens: (n) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n)),
    quotaStale: () => stale,
    QUOTA_WHY_TEXT: { 'no-cc': 'no-cc', 'hooks-only': 'hooks-only', nothing: 'nothing', 'no-field': 'no-field' },
    quotaWhy: () => 'nothing',
  })
  return vm.runInContext(`${extractFn('agentUsage')}\n;agentUsage`, ctx)
}

const CODEX_WINDOWS = { codex: { windows: [{ key: 'primary', label: '30d', pct: 12.5, resets_at: 1 }] } }
const session = (over = {}) => ({ agent: 'codex', tokens: null, usage_reported: null, ...over })

test('后端自报的窗口，换任何 quota 档位都不该消失', async (t) => {
  const agentUsage = run({ agentLimits: CODEX_WINDOWS })

  /**
   * 逐档跑一遍，而不是只测当前那一档。
   *
   * 这条断言的全部价值就在这里：今天 codex 是 tokens，明天可能因为别的理由
   * 被改成 none 或者一个新档位。窗口是**后端自己报的事实**，跟我们给它归的
   * 档位无关——判据只能是「有没有收到」。
   */
  for (const quota of Object.values(QUOTA)) {
    await t.test(`quota = ${quota}`, () => {
      const u = agentUsage('codex', { quota }, [session()])
      assert.ok(u, `档位 ${quota} 下整条都没了`)
      assert.match(u.html, /30d 13%/,
        `档位 ${quota} 下 30 天窗口消失了。窗口是 Codex 自己报的，`
        + `不该因为我们改了一个归类字段就从界面上不见`)
    })
  }
})

test('窗口和累计 token 并排，不是二选一', () => {
  const agentUsage = run({ agentLimits: CODEX_WINDOWS })
  const u = agentUsage('codex', { quota: QUOTA.TOKENS }, [session({ tokens: 20263, usage_reported: true })])
  // 两者回答的是不同的问题：「这个月还剩多少」和「这轮花了多少」
  assert.match(u.html, /30d 13%/)
  assert.match(u.html, /20\.3k tok/)
})

test('三种「没有数字」说的是三句不同的话', async (t) => {
  await t.test('还没跑完一轮 —— 什么都不说', () => {
    const agentUsage = run()
    assert.equal(agentUsage('dsh', { quota: QUOTA.TOKENS }, [session({ agent: 'dsh' })]), null)
  })

  await t.test('桥接明说不上报 —— 说出来', () => {
    const agentUsage = run()
    const u = agentUsage('dsh', { quota: QUOTA.TOKENS }, [session({ agent: 'dsh', usage_reported: false })])
    assert.match(u.html, /不上报用量/)
  })

  await t.test('档位就是 none 且真的没窗口 —— 也说出来', () => {
    // 空着的话用户会一直等一个永远不会出现的数字
    const agentUsage = run()
    const u = agentUsage('x', { quota: QUOTA.NONE }, [])
    assert.match(u.html, /不上报用量/)
  })
})

test('Claude Code 的窗口仍然走账户级的那条，不受影响', () => {
  const agentUsage = run({ quota: { five_hour: { pct: 7 }, seven_day: { pct: 76 } } })
  const u = agentUsage('claude-code', AGENTS['claude-code'], [session({ agent: 'claude-code' })])
  assert.match(u.html, /5h 7%/)
  assert.match(u.html, /7d 76%/)
})
