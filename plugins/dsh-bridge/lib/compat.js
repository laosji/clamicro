/**
 * 版本漂移探测。
 *
 * ## 为什么不是「记个版本号然后比对」
 *
 * DSH 是开发预览版，明说会有破坏性变更。但版本号变了**不一定**影响我们——
 * 46 个事件类型里我们只用 7 个，绝大多数改动跟这个插件无关。反过来，
 * 真正会伤到我们的是字段级的改名，而那种改动完全可能发生在一个 patch 版本里。
 *
 * 所以这里做两件强度不同的事：
 *
 *   · **版本差异** → 只提示一句。它说明「该回归一遍了」，不说明坏了。
 *   · **字段形状不对** → 高声警告。它说明**现在就已经在错译了**。
 *
 * ## 为什么形状检查这么重要
 *
 * 这个插件所有的翻译错误都是**安静**的：`tool/call.name` 要是改名叫别的，
 * 我们读到 undefined，手机上每张卡片显示 `?`，没有任何一处会抛异常。
 * `arguments` 要是从字符串改成对象，parseArgs 返回 null，所有审批变成
 * 「参数未知」的高危——安全，但每一条都要手点，而人只会觉得「这东西怎么变傻了」。
 *
 * 这类故障不会自己浮出来，只能主动检查。
 *
 * ## 为什么不直接读 DSH 的权威事件表
 *
 * `@deepseek-ai/dsh-session` 的 exports 里没有 `known-event-types`
 * （实测 0.1.0-rc.6），拿不到那个 Set。而且就算拿得到，它只能回答
 * 「事件名还在不在」，回答不了「字段还在不在」——后者才是我们真正依赖的。
 */

/** 本插件核对过的 DSH 版本。升级后跑一遍回归再改这里。 */
export const TESTED_DSH = '0.1.0-rc.6'

/**
 * 我们真正依赖的字段。只列**读了就会用**的，不列顺手带的。
 *
 * 每一项：给一个事件负载，返回它是否还是我们认得的形状。
 * 判据要**宽松**——只认「这个字段存在且类型对」，不管有没有多出别的东西。
 * 严了会在 DSH 加字段时误报，而加字段是最常见的无害变更。
 */
const SHAPES = {
  'tool/call': (d) =>
    typeof d?.name === 'string' &&
    // arguments 是模型原样吐的 JSON 字符串。哪天改成对象了要立刻知道：
    // 那会让 parseArgs 的分支全部走错
    (typeof d?.arguments === 'string' || (d?.arguments != null && typeof d?.arguments === 'object')),
  'tool/result': (d) => Array.isArray(d?.message?.content),
  'turn/end': (d) => typeof d?.reason?.kind === 'string',
  'user/message': (d) => Array.isArray(d?.content) || typeof d?.content === 'string',
  'assistant/message': (d) => d?.message != null,
}

export class ShapeWatch {
  #warned = new Set()
  #log

  constructor({ log = () => {} } = {}) {
    this.#log = log
  }

  /**
   * 检查一条事件的形状。
   *
   * **每种事件只警告一次**：一个跑了一整天的会话会有几千条 tool/call，
   * 形状要是不对，每条都喊一遍就等于没喊——真正要紧的那行会被自己刷掉。
   *
   * @returns 形状是否认得。false 时调用方仍照常翻译（尽力而为），
   *   只是结果多半是残的——这比整个插件停摆好，但必须让人看见。
   */
  check(type, data) {
    const shape = SHAPES[type]
    if (!shape) return true // 没登记形状的事件不检查
    let ok = false
    try {
      ok = shape(data) === true
    } catch {
      ok = false
    }
    if (!ok && !this.#warned.has(type)) {
      this.#warned.add(type)
      this.#log(
        `⚠️ DSH 事件 ${type} 的形状跟预期不符 —— 本插件是按 DSH ${TESTED_DSH} 写的。` +
        `手机上这类事件的显示会是残的（工具名变 ?、或者审批全变成「参数未知」）。` +
        `请对照 docs/dsh-bridge.zh-CN.md §4.1 重新核对字段名。`,
      )
    }
    return ok
  }
}

/**
 * 提示一句版本差异。**不是错误**——大多数 DSH 改动跟这个插件无关。
 *
 * 版本读不到就什么都不说：读不到的原因通常是包结构变了，而为一件
 * 「可能没事」的事在启动日志里喊一嗓子，只会训练人忽略这个插件的输出。
 */
export function noteVersion(installed, log) {
  if (typeof installed !== 'string' || !installed) return
  if (installed === TESTED_DSH) return
  log(
    `DSH 是 ${installed}，本插件核对过的是 ${TESTED_DSH}。` +
    `多数改动不影响本插件；真出问题时上面会有形状不符的警告。`,
  )
}

/** 试着读出当前 DSH 的版本。拿不到就返回 null，绝不抛。 */
export async function installedDshVersion() {
  try {
    // package.json 在 dsh-session 的 exports 里（实测 0.1.0-rc.6），
    // 而 known-event-types 不在——所以只能走这条
    const { default: pkg } = await import('@deepseek-ai/dsh-session/package.json', {
      with: { type: 'json' },
    })
    return pkg?.version ?? null
  } catch {
    return null
  }
}
