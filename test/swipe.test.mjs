/**
 * 滑动手势的放行判定。
 *
 * 这是整个 UI 里唯一必须有测试的部分：**误滑就是误批准**。右滑代表同意，
 * 而同意的可能是 `rm -rf`。已经出过一次「阈值被算成 0」的 bug——横屏或后台
 * 渲染时 innerWidth 读到 0，于是任何一点点拖动都能放行。
 *
 * 测的是 ui/swipe.js 里真正跑的那两个函数（通过 window.__swipeLogic 导出），
 * 不是抄一份逻辑过来——抄的那份会跟真实实现慢慢漂移，而漂移的方向永远是
 * 测试还在过、线上已经不对了。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// 在一个假 window 里跑 swipe.js。它是个 IIFE，只往 window 上挂东西，
// 没有 DOM 就跑不起来的部分都在 attachSwipe 内部，不影响我们要的纯函数。
function loadLogic() {
  const win = {}
  const ctx = vm.createContext({
    window: win,
    document: { createElement: () => ({ style: {}, setAttribute() {}, addEventListener() {} }), body: { appendChild() {} } },
    navigator: {},
    performance: { now: () => 0 },
  })
  vm.runInContext(readFileSync(join(root, 'ui/swipe.js'), 'utf8'), ctx)
  assert.ok(win.__swipeLogic, 'swipe.js 应导出 __swipeLogic')
  return win.__swipeLogic
}

const { MIN_PX, computeThreshold, shouldCommit } = loadLogic()

/** 一次「正常人手」的滑动，只覆盖要测的那个维度 */
const gesture = (over) => ({
  dx: 200, vx: 0, axis: 'x', th: 120, moves: 8, dtMs: 300, mode: 'normal', rightBlocked: false, ...over,
})

test('阈值：按屏宽比例，但两头都夹住', async (t) => {
  await t.test('常规是屏宽的 32%', () => {
    assert.equal(computeThreshold(375, true, 'normal'), 375 * 0.32)
  })

  await t.test('高危右滑要 55%——批准危险操作得划得更明确', () => {
    assert.equal(computeThreshold(375, true, 'high'), 375 * 0.55)
  })

  await t.test('高危左滑（拒绝）仍是 32%：拒绝永远该更容易', () => {
    assert.equal(computeThreshold(375, false, 'high'), 375 * 0.32)
  })

  await t.test('宽度读不出来时用 375 兜底，绝不会算出 0', () => {
    // 出过的真 bug：innerWidth 读到 0 → 阈值 0 → 蹭一下就放行。
    // 0 和 NaN 都被 `|| 375` 接住，走的是同一条兜底路径。
    for (const bad of [0, NaN, undefined, null, 'abc', {}]) {
      assert.equal(computeThreshold(bad, true, 'normal'), 375 * 0.32, `width=${bad}`)
    }
  })

  await t.test('负数宽度被夹到下限 320', () => {
    assert.equal(computeThreshold(-100, true, 'normal'), 320 * 0.32)
  })

  await t.test('小屏也不低于 320 —— 阈值不随屏宽无限缩小', () => {
    assert.equal(computeThreshold(200, true, 'normal'), 320 * 0.32)
  })

  await t.test('上限 420：横屏 1024 宽不该要求划半个屏幕', () => {
    assert.equal(computeThreshold(1024, true, 'normal'), 420 * 0.32)
    assert.equal(computeThreshold(2560, true, 'high'), 420 * 0.55)
  })

  await t.test('任何宽度下阈值都不低于 MIN_PX', () => {
    for (const w of [0, 1, 320, 375, 430, 1024, 4096]) {
      assert.ok(computeThreshold(w, true, 'normal') >= MIN_PX, `width=${w}`)
    }
  })
})

test('放行的基本条件', async (t) => {
  await t.test('划过阈值就放行', () => {
    assert.equal(shouldCommit(gesture({ dx: 130, th: 120 })).go, true)
  })

  await t.test('差一点点不放行', () => {
    assert.equal(shouldCommit(gesture({ dx: 119, th: 120 })).go, false)
  })

  await t.test('刚好等于阈值算过', () => {
    assert.equal(shouldCommit(gesture({ dx: 120, th: 120 })).go, true)
  })

  await t.test('左滑（拒绝）同样判定，方向对称', () => {
    assert.equal(shouldCommit(gesture({ dx: -130, th: 120 })).go, true)
    assert.equal(shouldCommit(gesture({ dx: -119, th: 120 })).go, false)
  })
})

test('轴锁定：竖着滚页面不该触发左右滑', async (t) => {
  for (const axis of ['y', null, undefined]) {
    await t.test(`axis=${axis} 一律不放行`, () => {
      assert.equal(shouldCommit(gesture({ axis })).go, false)
    })
  }
})

test('MIN_PX 绝对下限：比例过了也得真划够距离', async (t) => {
  await t.test('阈值很小但位移 < 56px 时仍然拒绝', () => {
    // 唯一能挡住「阈值被算成 0」这类 bug 的兜底
    const r = shouldCommit(gesture({ dx: 40, th: 0 }))
    assert.equal(r.past, true, '按比例是过了')
    assert.equal(r.go, false, '但绝对位移不够，不能放行')
  })

  await t.test('恰好 56px 且过阈值时放行', () => {
    assert.equal(shouldCommit(gesture({ dx: MIN_PX, th: 10 })).go, true)
  })

  await t.test('55px 不行', () => {
    assert.equal(shouldCommit(gesture({ dx: MIN_PX - 1, th: 10 })).go, false)
  })
})

test('人手门槛：一帧跳到位的不算数', async (t) => {
  await t.test('只有 1 次 move —— 合成事件的典型形态', () => {
    const r = shouldCommit(gesture({ moves: 1 }))
    assert.equal(r.human, false)
    assert.equal(r.go, false)
  })

  await t.test('move 够多但耗时 < 80ms —— 瞬移拖拽', () => {
    assert.equal(shouldCommit(gesture({ moves: 10, dtMs: 20 })).go, false)
  })

  await t.test('2 次 move + 80ms 是刚好过线的最低配', () => {
    assert.equal(shouldCommit(gesture({ moves: 2, dtMs: 80 })).go, true)
  })

  await t.test('79ms 不行', () => {
    assert.equal(shouldCommit(gesture({ moves: 2, dtMs: 79 })).go, false)
  })

  await t.test('人手门槛挡不住的话，甩出快捷方式也一样挡住', () => {
    // human 是最外层的与条件，flick 分支不能绕过它
    assert.equal(shouldCommit(gesture({ dx: 100, th: 500, vx: 3, moves: 1, dtMs: 5 })).go, false)
  })
})

test('甩出（flick）：快速轻扫的快捷方式', async (t) => {
  // 位移没到阈值，但速度够快、方向一致
  const flick = (over) => gesture({ dx: 100, th: 200, vx: 2, ...over })

  await t.test('速度够快时不用划到阈值', () => {
    const r = shouldCommit(flick())
    assert.equal(r.past, false, '没到阈值')
    assert.equal(r.flick, true)
    assert.equal(r.go, true)
  })

  await t.test('速度不够（≤0.55）不算甩', () => {
    assert.equal(shouldCommit(flick({ vx: 0.55 })).go, false)
  })

  await t.test('速度方向和位移方向相反时不算——那是回抽', () => {
    // 手指划出去又往回收，松手瞬间速度是反的，明显不是要提交
    const r = shouldCommit(flick({ vx: -2 }))
    assert.equal(r.flick, false)
    assert.equal(r.go, false)
  })

  await t.test('甩也要满足 MIN_PX', () => {
    assert.equal(shouldCommit(flick({ dx: 40, vx: 5 })).go, false)
  })

  await t.test('甩还要求位移超过阈值的 45%', () => {
    // 否则轻轻一弹就能提交
    assert.equal(shouldCommit(flick({ dx: 100, th: 500, vx: 5 })).go, false, '100 < 500*0.45')
    assert.equal(shouldCommit(flick({ dx: 100, th: 200, vx: 5 })).go, true, '100 > 200*0.45')
  })
})

test('高危批准：不给快捷方式，必须实打实划过去', async (t) => {
  await t.test('高危 + 右滑时 canFlick 为 false', () => {
    const r = shouldCommit(gesture({ dx: 100, th: 200, vx: 5, mode: 'high' }))
    assert.equal(r.flick, true, '手势本身够得上甩')
    assert.equal(r.canFlick, false, '但高危批准不认')
    assert.equal(r.go, false, '一次快扫不能放行 rm -rf')
  })

  await t.test('高危 + 右滑划过阈值仍然放行', () => {
    assert.equal(shouldCommit(gesture({ dx: 240, th: 231, mode: 'high' })).go, true)
  })

  await t.test('高危 + 左滑（拒绝）保留快捷方式', () => {
    // 拒绝是安全方向，不该被加摩擦
    const r = shouldCommit(gesture({ dx: -100, th: 200, vx: -5, mode: 'high' }))
    assert.equal(r.canFlick, true)
    assert.equal(r.go, true)
  })
})

test('rightBlocked：右滑被禁用时（比如已经批过了）', async (t) => {
  await t.test('再怎么划都不放行', () => {
    const r = shouldCommit(gesture({ dx: 400, th: 100, vx: 5, rightBlocked: true }))
    assert.equal(r.dirOk, false)
    assert.equal(r.go, false)
  })

  await t.test('左滑不受影响', () => {
    assert.equal(shouldCommit(gesture({ dx: -400, th: 100, rightBlocked: true })).go, true)
  })
})

test('组合：真机上的两种常见误触', async (t) => {
  await t.test('滚列表时手指略微横移——不该批准任何东西', () => {
    assert.equal(shouldCommit(gesture({ dx: 18, axis: 'y', moves: 12, dtMs: 400 })).go, false)
  })

  await t.test('高危卡片上一次犹豫的半程滑动——停在阈值内就是不批', () => {
    const th = computeThreshold(375, true, 'high') // 206.25
    assert.equal(shouldCommit(gesture({ dx: 150, th, vx: 0.3, mode: 'high' })).go, false)
  })
})

/**
 * 阈值必须落在把手走得到的范围里。
 *
 * 这一条是实测出来的，不是推演：390 宽的手机上决策条净宽 352、把手 52，
 * 可用行程 144px；而 computeThreshold 的 320 下限（那是给「视口宽度」
 * 准备的）会把高危阈值抬到 176px。于是把手顶在轨道尽头，进度条停在 82%
 * 永远不满，**高危审批在界面上根本走不完**——只能凭猜把手指拖到控件外面。
 *
 * 而高危恰恰是最需要人能确凿完成这个动作的场合。
 */
test('阈值不得超过控件真正走得到的行程', async (t) => {
  const PHONE_TRAVEL = 144 // 390 宽手机上实测：352/2 - 52/2 - 6

  await t.test('高危右滑在小屏上够得着', () => {
    const th = computeThreshold(PHONE_TRAVEL * 2, true, 'high', PHONE_TRAVEL)
    assert.ok(th < PHONE_TRAVEL, `阈值 ${th} 应当小于可用行程 ${PHONE_TRAVEL}`)
  })

  await t.test('过线之后还得剩一段行程', () => {
    // 「已过线」和「顶到头」必须在手感上分得开——那一跳是松手前唯一的确认
    const th = computeThreshold(PHONE_TRAVEL * 2, true, 'high', PHONE_TRAVEL)
    assert.ok(PHONE_TRAVEL - th >= 12, `只剩 ${PHONE_TRAVEL - th}px 余量，过线跳变会被顶到头淹掉`)
  })

  await t.test('封顶不会把阈值压到 MIN_PX 以下', () => {
    // 行程极小时宁可够不着也不能变成「碰一下就批准」
    const th = computeThreshold(120, true, 'high', 20)
    assert.ok(th >= MIN_PX, `阈值 ${th} 掉到了绝对下限 ${MIN_PX} 以下`)
  })

  await t.test('不传 maxTravel 时行为完全不变', () => {
    // 整卡片滑动那条路径传的是视口宽度，本来就没有「行程上限」这回事
    for (const [w, right, mode] of [[375, true, 'high'], [375, false, 'normal'], [800, true, 'normal']]) {
      assert.equal(computeThreshold(w, right, mode), computeThreshold(w, right, mode, 0))
    }
  })

  await t.test('行程够大时封顶不生效——不该顺手把正常屏幕的阈值也调松', () => {
    assert.equal(computeThreshold(375, true, 'high', 900), computeThreshold(375, true, 'high'))
  })
})
