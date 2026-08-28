/**
 * ui/sched.js —— 真跑，用一个手动泵代替 rAF。
 *
 * 这两条保证都是**用实测的坏行为换来的**，所以测试也得能真的复现那两种坏：
 *
 *   合并   一个 85 条事件的会话，开一次页面实测发出 105 个 /api/sessions/:id
 *          （SSE 一连上就全量重放历史事件，而每条都直接接了 refresh）。
 *          首页那边是 20 次工具调用 = 60 个请求。
 *   排序   同一页并发发 40 次，回来的顺序实测是 1,2,3,14,15,4,16,5…
 *          ——第 14 个比第 4 个先到。不拦的话最后落地的是**旧的那一份**，
 *          而屏幕上看不出任何异样：页面在刷新，内容是过期的。
 *
 * raf 注入成手动泵，是为了这些断言不依赖真的等一帧——那种测试在慢机器上
 * 会随机变红，然后被人加 retry，然后它就再也不报警了。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(root, 'ui/sched.js'), 'utf8')

/** 空 context：sched.js 但凡伸手摸 window/document 就在这里炸 */
const { coalesced } = vm.runInContext(`${src}\n;({ coalesced })`, vm.createContext({}))

/** 手动泵。攒着回调，`flush()` 才放一帧过去。 */
function pump() {
  const q = []
  const raf = (fn) => q.push(fn)
  raf.flush = () => { const n = q.splice(0); for (const fn of n) fn(); return n.length }
  raf.size = () => q.length
  return raf
}

test('合并：一帧之内叫多少次都只跑一次', async (t) => {
  await t.test('105 次调用 → 1 次执行', () => {
    const raf = pump()
    let runs = 0
    const go = coalesced(() => { runs++ }, { raf })
    for (let i = 0; i < 105; i++) go()
    assert.equal(runs, 0, '排程时不该就地跑——那就没合并可言了')
    raf.flush()
    assert.equal(runs, 1, '一帧之内 105 次调用只该落地 1 次')
  })

  await t.test('下一帧还能再跑（不是只跑一次就哑了）', () => {
    const raf = pump()
    let runs = 0
    const go = coalesced(() => { runs++ }, { raf })
    go(); go(); raf.flush()
    go(); go(); raf.flush()
    assert.equal(runs, 2, '每一帧各一次；「合并」不等于「只认第一次」')
  })

  await t.test('没人叫就不跑', () => {
    const raf = pump()
    let runs = 0
    coalesced(() => { runs++ }, { raf })
    raf.flush()
    assert.equal(runs, 0)
  })
})

test('排序：晚到的旧响应不许盖掉新的', async (t) => {
  /** 造一个「取数据慢、可以手动决定谁先回来」的 run */
  function stagger() {
    const applied = []
    const pending = []
    const run = (isStale) => new Promise((resolve) => {
      pending.push({
        // 调用方的写法：取完先问一句自己过时没有
        land: (data) => { if (!isStale()) applied.push(data); resolve() },
      })
    })
    return { run, pending, applied }
  }

  await t.test('第 2 轮先回来，第 1 轮再回来 —— 只认第 2 轮', async () => {
    const raf = pump()
    const { run, pending, applied } = stagger()
    const go = coalesced(run, { raf })

    go(); raf.flush()          // 第 1 轮开跑
    go(); raf.flush()          // 第 2 轮开跑（第 1 轮还在路上）
    assert.equal(pending.length, 2)

    pending[1].land('新')       // 后发的先到
    pending[0].land('旧')       // 先发的后到 —— 实测里就是这个顺序
    await new Promise((r) => setImmediate(r))

    assert.deepEqual(applied, ['新'],
      '旧响应把新内容盖掉了 —— 页面会稳定停在一个比已经收到过的还旧的状态')
  })

  await t.test('正常顺序回来时两次都算数', async () => {
    // 别把保护做成「只有最后一次生效」——中间那些也该画，
    // 否则一条慢链路上界面就不动了
    const raf = pump()
    const { run, pending, applied } = stagger()
    const go = coalesced(run, { raf })

    go(); raf.flush()
    pending[0].land('第一份')
    await new Promise((r) => setImmediate(r))
    go(); raf.flush()
    pending[1].land('第二份')
    await new Promise((r) => setImmediate(r))

    assert.deepEqual(applied, ['第一份', '第二份'])
  })

  await t.test('now() 也领号，一样挡得住', async () => {
    const raf = pump()
    const { run, pending, applied } = stagger()
    const go = coalesced(run, { raf })

    go.now()                    // 第 1 轮
    go.now()                    // 第 2 轮
    pending[1].land('新')
    pending[0].land('旧')
    await new Promise((r) => setImmediate(r))

    assert.deepEqual(applied, ['新'], 'now() 绕过的只该是合并，不是排序保护')
  })
})

test('now()：马上跑，并且**把 promise 交出来**', async (t) => {
  await t.test('不等下一帧', () => {
    const raf = pump()
    let runs = 0
    const go = coalesced(() => { runs++ }, { raf })
    go.now()
    assert.equal(runs, 1, 'now() 该就地跑')
    assert.equal(raf.size(), 0, 'now() 不该往 rAF 队列里塞东西')
  })

  await t.test('返回值透传，能 await、能 .then', async () => {
    /*
     * 这一条钉的是**调用方读起来是对的**。首页首屏写的是
     * `refresh.now().then(connect)`，会话页几处人触发的动作写的是
     * `await refresh.now()`——排程版返回 undefined，那些地方要么当场
     * TypeError，要么 await 立刻返回、代码看着等过了其实没等。
     */
    const raf = pump()
    const go = coalesced(async () => 'ok', { raf })
    const p = go.now()
    assert.equal(typeof p?.then, 'function', 'now() 必须把 run 的返回值原样交出来')
    assert.equal(await p, 'ok')
  })

  await t.test('首屏不该依赖 rAF', () => {
    // rAF 在后台标签页是挂起的。合并省的是重复，不该省掉唯一的那一次——
    // 让第一次渲染排进 rAF，等于页面可能什么都不画
    const raf = pump()
    let runs = 0
    const go = coalesced(() => { runs++ }, { raf })
    go.now()
    assert.equal(runs, 1, '一帧都没放过去，首屏也得画出来')
  })
})

test('两个页面都真的用上了，而且没各自抄一份', async (t) => {
  const read = (p) => readFileSync(join(root, p), 'utf8')
  const PAGES = ['ui/home.html', 'ui/session.html']

  for (const page of PAGES) {
    const s = read(page)
    await t.test(`${page} 引了 /ui/sched.js`, () => {
      assert.match(s, /coalesced\s*\(/, `${page} 该用 coalesced 包住 refresh`)
      assert.match(s, /<script src="\/ui\/sched\.js"><\/script>/,
        `${page} 用了 coalesced 却没引 /ui/sched.js —— 整段脚本会 ReferenceError`)
    })
    await t.test(`${page} 没有自己再写一份`, () => {
      assert.doesNotMatch(s, /^function coalesced\s*\(/m,
        `${page} 又抄了一份 coalesced —— 后加载的会静默盖掉 ui/sched.js 里那份`)
    })
  }

  await t.test('SSE 那几条绑的是合并版，不是 now()', () => {
    // 这是整件事的起点：**机器造出来的洪水**才需要合并。
    // 这几行要是绑回 refresh.now，105 个请求就原样回来了
    const home = read('ui/home.html')
    assert.match(home, /addEventListener\('session', refresh\)/)
    assert.match(home, /addEventListener\('approval', refresh\)/)
    const sess = read('ui/session.html')
    assert.match(sess, /addEventListener\('event', refresh\)/)
    assert.match(sess, /addEventListener\('session', refresh\)/)
    for (const [name, s] of [['home', home], ['session', sess]]) {
      assert.doesNotMatch(s, /addEventListener\('(?:event|session|approval)', refresh\.now\)/,
        `${name} 把 SSE 绑回了 now() —— 那就等于没合并`)
    }
  })

  await t.test('服务端真的会把 /ui/sched.js 发出去', () => {
    const pages = read('src/routes/pages.mjs')
    const m = pages.match(/const asset = path\.match\((\/.*?\/)\)/)
    assert.ok(m, '没找到静态资源那条正则，是不是改写法了？')
    const re = new RegExp(m[1].slice(1, -1))
    assert.ok(re.test('/ui/sched.js'), 'pages.mjs 的白名单没放行 /ui/sched.js')
  })
})
