/**
 * 界面的**纯判断**：给它 sessions / quota / 一个时刻，还你一个布尔或一小段字。
 *
 * ## 为什么单开一个文件
 *
 * `ui/home.html` 里有两千多行 JS、47 个顶层函数，全挤在同一个扁平作用域，
 * 而**其中被任何测试真正执行过的只有一个**（agentUsage，靠 test/agent-usage
 * 里手写的 `extractFn()` 按文本抠出来塞进 vm）。其余 46 个，测试对它们做的
 * 只有 readFileSync + 正则断言——扫得出「这段字在不在」，扫不出「这段字跑起来
 * 对不对」。
 *
 * 代价是有账可查的。同一轮里三个「测试全绿、界面是坏的」，全部出自那个文件：
 *
 *   · 两个同名的 `staleNote` —— 扁平作用域里后声明的静默赢，纯 Codex /
 *     纯 DSH 用户一打开会话 tab 就是「页面渲染出错」
 *   · 删 `qbadge` 时留下一句 `const qn = Object.values(inbox)`，而 inbox 那个
 *     全局已经没了 —— ReferenceError，会话 tab 整个空白
 *   · 主控台 `esc(s0.sub_state)` 裸输出 `Editing`，正下方的卡片写着「编辑中」
 *
 * 三个都只有**真把页面打开**才看得见。
 *
 * ## 判据是「能不能在 vm 里跑起来」
 *
 * 搬进来的一律**不碰 DOM、不读全局**，要什么就作为参数传进来。这不是洁癖：
 * `quotaStaleNote` 原来直接读 `quota` 这个全局，于是想测它就得先把整个
 * home.html 的作用域搭起来——而那正是它一直没有测试的原因。
 *
 * `now` 一律可注入，否则跟时间有关的分支只能靠 sleep 去撞。
 *
 * ## 怎么往里加
 *
 * 不必一次搬完，**改到哪个搬哪个**——每搬一个，「不可测的全局」就少一个。
 * 反过来也成立：新写的纯判断直接写在这里，别再往 home.html 里加。
 *
 * 页面用 <script src="/ui/view.js"> 引进去，这些名字是全局的（同 agents.js）。
 * 两件事必须一起做，漏一件就是**整段脚本 ReferenceError、页面白屏**：
 *   1. 用到的页面加 <script src>
 *   2. 路径加进 src/routes/pages.mjs 的静态资源白名单（那是白名单，不是前缀）
 * test/ui-shared.test.mjs 两条都钉着，另外还钉「页面不许再定义一个同名的」
 * ——那种覆盖不报错，只是让你对 view.js 的修改**看起来没生效**。
 */

/**
 * 「运行中，但很久没动静了」。
 *
 * 会话只在 session-end 时才消失，而 kill -9 / 关终端 / 崩溃都不发那个事件——
 * 那样的会话会永远停在「运行中」。服务端只标「从什么时候开始没动静」
 * （stale_since），不替它下死亡判定：一条跑二十分钟的测试命令同样一声不响。
 *
 * 所以这里也只说观察到的事实。真死了的和真在跑的，用户自己一眼能分辨——
 * 他知道自己有没有在跑长命令，我们不知道。
 *
 * 名字里带 session 不是啰嗦。**这个函数曾经整个是死代码**：它原来也叫
 * `staleNote`，而 700 行开外还有一个同名的 `staleNote()`（讲额度新鲜度）。
 * 同一个作用域里两个同名函数声明，**后声明的赢**——于是会话卡片上那句
 * `staleNote(s)` 调的是额度那个，参数被静默丢掉。
 *
 * 三个后果，全是实测出来的：
 *   1. 这句「很久没动静」从来没在界面上出现过，而服务端的 stale_since
 *      一直好好地在算（还有测试钉着）
 *   2. 每张会话卡片改成显示额度那句「新开一个 Claude Code 会话就会刷新」
 *      ——在 DSH / Codex 的卡片上那是**假话**
 *   3. 额度那个要读 `quota.at`，而 quota 只有 statusLine 会写。于是
 *      **纯 DSH / 纯 Codex 的用户一打开会话 tab 就是「页面渲染出错」**
 *
 * 重名不会报错，也不会有任何测试变红。test/ui-shared.test.mjs 现在扫这件事。
 */
function sessionStaleNote(s, now = Date.now()) {
  if (!s?.stale_since) return '';
  const mins = Math.round((now - s.stale_since) / 60000);
  const howLong = mins >= 60 ? `${Math.round(mins / 60)} 小时` : `${mins} 分钟`;
  return `<div class="stalenote">已经 ${howLong}没有任何上报 —— 可能还在跑一条长命令，也可能那边已经没了</div>`;
}

/**
 * 「多久以前」。
 *
 * 到小时就封顶的话，四天前的数据会写成「96 小时前」——那个数字要在脑子里
 * 除一下才知道有多久，而这一行的全部作用就是让人一眼判断「还能不能信」。
 */
function ago(ts, now = Date.now()) {
  if (!ts) return '未知';
  const s = Math.round((now - ts) / 1000);
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return `${Math.round(s / 86400)} 天前`;
}

/**
 * 这份用量是不是已经过期了。
 *
 * statusLine 在活跃会话里每次响应都上报，秒级新鲜；超过 10 分钟没动静就说明
 * 没有会话在报。**这时候把旧数字当当前值展示是在骗人**，所以环压灰、
 * 底下补一句 quotaStaleNote()——判据只有这一处，界面各部分不能各判各的。
 *
 * 没有 quota 时返回 false 而不是 true：「还没拿到过数据」跟「拿到过、但已经
 * 旧了」是两件事，前者该走「新开一个会话后这里会出现数字」，后者才该压灰。
 */
function quotaStale(quota, now = Date.now()) {
  return !!quota && now - quota.at > 600_000;
}

/**
 * 过期时环下面那一行：**多旧 + 怎么才能看到新的。**
 *
 * 这行字曾经是一条 ⚠️ 开头的独立警告（「⚠️ 这是 19 小时前的旧数据。新开一个
 * Claude Code 会话才会刷新。」）。放在灰环下面它是**这张卡上最响的东西**——
 * 一个黄三角，配着两句话，为的是说一件既不紧急、也不需要你此刻做任何事的事。
 * 而「不是当前值」这件事，两只灰环已经说过了；警告图标只是把同一句话喊了一遍。
 *
 * 现在压成一行轻字，句式跟另外几档保持一致：
 *
 *     19 小时前的数据 · 新开一个 Claude Code 会话就会刷新
 *
 * 前半句回答「还能不能信」，后半句回答「那我怎么办」，中间一个 · 分开——
 * 两件事各一次，没有第二遍。「就会」而不是「才会」：前者说的是「这么点事
 * 就够了」，后者听起来像在拦你。
 *
 * 讲的是**额度读数**有多旧，跟某个会话无关——所以不接会话，名字也要说出来；
 * 跟 sessionStaleNote 重过名，见那里那段。`why` 由调用方算好传进来：它要看
 * sessions 和能力表，那是另一层的事。
 */
function quotaStaleNote(quota, why, now = Date.now()) {
  const how = why === 'hooks-only'
    // `claude` 放句中不放句末：它是一段不可断行的等宽字，摆在最后会被整个
    // 甩到第二行独占一行，一句两行的小字于是长得像两句
    ? '此界面不刷新，在终端跑 <code>claude</code> 才看得到当前值'
    : '新开一个 Claude Code 会话就会刷新';
  return `${ago(quota?.at, now)}的数据 · ${how}`;
}

/**
 * 「此刻没有正在发生的事」。
 *
 * 抽出来是因为**有两个消费者**：header 下面那条用量，和分组标题后面那个
 * skill 计数。两处都遵守同一条规矩——参考信息在有事发生时让位（见
 * renderTopUsage）——而各抄一份判据，早晚有一处漏掉某个状态，然后那一处会在
 * 最忙的时候继续占着位置。
 *
 * 「刚完成」也算有事：那一分钟里你多半正想看结果。
 *
 * 断线也不算空闲：那时屏幕上所有数字都是断开前的旧值，把参考信息摆出来
 * 等于拿旧数据冒充当前状态。
 */
function isIdleView({ sessions = [], pending = [], disconnected = false, now = Date.now() } = {}) {
  return !disconnected && !pending.length
    && !sessions.some((s) => s.state === 'Error')
    && !sessions.some((s) => s.state === 'Running' || s.state === 'Waiting Approval' || s.state === 'Paused')
    && !sessions.some((s) => s.state === 'Done' && now - s.updated_at < 60_000);
}
