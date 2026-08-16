/**
 * 风险判定。规则表在 ./rules.mjs，这里只有逻辑。
 *
 * 独立成模块的理由：它是整个产品的安全核心。判定错了，
 * 上层再好的 UI、再稳的传输都没有意义。独立之后测试可以直接打在它身上，
 * 不必启动服务、不必伪造 hook payload。
 */
import {
  HIGH_RISK_BASH,
  IMPACT,
  SENSITIVE_PATH,
  SECRET_IN_COMMAND,
  ENV_IN_COMMAND,
  EXFIL_VERBS,
  READ_ONLY_CMDS,
  READ_ONLY_GIT,
} from './rules.mjs'

/**
 * 把命令拆成一个个「命令位置的词」。
 * `ls -la | grep foo && sudo rm -rf /` → ['ls', 'grep', 'sudo', 'rm']
 * 用来判断只读：只有每一段的头一个词都认识且都只读，才敢说只读。
 */
function commandHeads(cmd) {
  return cmd
    .split(/[\n;|&]+|\|\||&&/)
    .map((seg) => seg.trim())
    .filter(Boolean)
    .map((seg) => {
      // 剥掉前置的环境变量赋值：FOO=1 ls -la
      const s = seg.replace(/^(?:\w+=[^\s]*\s+)+/, '')
      const [head, ...rest] = s.split(/\s+/)
      return { head: (head ?? '').replace(/^.*\//, ''), arg: rest[0] ?? '' }
    })
}

/**
 * 只有**认得且确定只读**才返回 true。认不出来一律 false —— 见 rules.mjs
 * 里 READ_ONLY_CMDS 的说明：把未知当只读是之前最危险的一个默认值。
 */
export function isDefinitelyReadOnly(cmd) {
  const segs = commandHeads(cmd)
  if (!segs.length) return false
  // 有重定向就不是只读（>file、>>file），但 2>&1 这种不算
  if (/>{1,2}\s*[^\s&|]/.test(cmd)) return false
  return segs.every(({ head, arg }) => {
    if (head === 'git') return READ_ONLY_GIT.test(arg)
    // find 只有在不带 -delete/-exec 时才只读，那两种已被 HIGH_RISK 捕获
    if (head === 'find') return !/-delete\b|-exec\b/.test(cmd)
    return READ_ONLY_CMDS.test(head)
  })
}

/**
 * 命令里有没有碰到凭证。
 * 返回 null 或一句说明。
 */
export function secretExposure(cmd) {
  if (SECRET_IN_COMMAND.test(cmd)) return '触及密钥/凭证文件'
  // .env 太常见，只有配上「读出来/送出去」的动词才算 —— 见 rules.mjs
  if (ENV_IN_COMMAND.test(cmd) && EXFIL_VERBS.test(cmd)) return '读取/传输 .env'
  return null
}

/**
 * 这个路径是不是落在工作目录之外。
 *
 * ## 原来的写法漏掉三整类
 *
 * 判据曾是 `cwd && p.startsWith('/') && !p.startsWith(cwd)`，裸字符串前缀比。
 * 三个洞，都实测复现过（cwd = `/Users/me/proj`）：
 *
 *   · **兄弟目录**：`/Users/me/proj-other/x`、`/Users/me/proj2/x` 的前缀
 *     确实是 `/Users/me/proj`，于是被当成「在工作目录内」→ 判 normal
 *   · **`..` 逃逸**：`/Users/me/proj/../secret` 前缀匹配通过，不规范化就看不出
 *     它其实指向 `/Users/me/secret`
 *   · **相对路径**：`../../etc/passwd` 不以 `/` 开头，直接跳过整条检查
 *
 * 三者都落到 normal，也就是 **10 秒自动通过**。
 *
 * 这跟 routes/hooks.mjs 里 `underIgnored` 踩过的是**同一个错误**——那边
 * 修过了并写了注释（「必须按路径分段比，不能裸 startsWith」），但风险模块
 * 没跟着改。同一个错误在两个地方，只修了一个，是这次最该记住的教训。
 *
 * ## 现在的判据
 *
 * 先规范化（吃掉 `.`/`..`/重复斜杠），相对路径按 cwd 解析，然后**按路径分段**
 * 比。`/a/b` 和 `/a/bc` 的分段不同，前缀却相同——分段比是唯一不会被
 * 目录名后缀骗到的写法。
 *
 * 规范化失败（畸形输入）时返回 true：算不出来就当越界，让人看一眼。
 */
export function escapesWorkspace(p, cwd) {
  if (!p || !cwd) return false
  const norm = (s) => {
    const abs = s.startsWith('/')
    const out = []
    for (const seg of s.split('/')) {
      if (!seg || seg === '.') continue
      if (seg === '..') {
        // 相对路径开头的 `..` 要留着，它是「往上走」的语义，不能吃掉
        if (out.length && out[out.length - 1] !== '..') out.pop()
        else if (!abs) out.push('..')
        continue
      }
      out.push(seg)
    }
    return (abs ? '/' : '') + out.join('/')
  }
  try {
    const base = norm(cwd)
    // 相对路径按工作目录解析——`../../etc/passwd` 只有解析过才看得出它去了哪
    const full = p.startsWith('/') ? norm(p) : norm(`${base}/${p}`)
    if (full === base) return false
    // 按分段比：`/a/b` 是 `/a/bc` 的字符串前缀，但不是它的父目录
    return !full.startsWith(base.endsWith('/') ? base : base + '/')
  } catch {
    return true // 算不出来就当越界，宁可多问一次
  }
}

/**
 * 影响面标签。**认不出来就说认不出来**，不要假装只读。
 */
export function impactOf(toolName, toolInput) {
  const t = toolInput && typeof toolInput === 'object' ? toolInput : {}

  if (toolName !== 'Bash') return null // 非 Bash 由调用方按工具类型直接给

  const cmd = String(t.command ?? '')
  const hits = IMPACT.filter((i) => i.re.test(cmd)).map(({ label, tone }) => ({ label, tone }))
  // 碰凭证是这一行里最重要的信号，排在最前面。
  // 之前它只体现在「高风险」那一栏，标签行完全看不出来——而标签行
  // 恰恰是给「不展开原文也能判断」准备的。
  if (secretExposure(cmd)) hits.unshift({ label: '读凭证', tone: 'danger' })
  if (hits.length) return hits
  if (isDefinitelyReadOnly(cmd)) return [{ label: '只读', tone: 'calm' }]
  // 既没命中任何已知影响面，也不在只读白名单里 —— 老实说不知道
  return [{ label: '影响面未知', tone: 'warn' }]
}

/**
 * 命令文本里命中风险规则的位置区间，供 UI 高亮。
 *
 * 返回**下标区间**而不是匹配到的字符串：前端要先转义再拼 HTML，
 * 如果按字符串去替换，转义后的文本和原文对不上（`>` 变成了 `&gt;`），
 * 要么高亮错位要么得在转义后的串上二次匹配，两条路都容易出 XSS。
 * 给区间，前端按区间切片、逐段转义，拼接时结构就是确定的。
 *
 * @returns {{start:number,end:number,why:string}[]} 已合并重叠、按位置排序
 */
export function riskSpans(text) {
  const s = String(text ?? '')
  if (!s) return []
  const spans = []
  const collect = (re, why) => {
    // 规则表里的正则没带 g，克隆一个带 g 的来扫全部出现位置
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
    let m
    while ((m = g.exec(s)) !== null) {
      if (m[0].length === 0) { g.lastIndex++; continue }
      spans.push({ start: m.index, end: m.index + m[0].length, why })
    }
  }
  for (const { re, why } of HIGH_RISK_BASH) collect(re, why)
  collect(SECRET_IN_COMMAND, '凭证路径')
  if (EXFIL_VERBS.test(s)) collect(ENV_IN_COMMAND, '凭证路径')

  spans.sort((a, b) => a.start - b.start || b.end - a.end)
  const merged = []
  for (const sp of spans) {
    const last = merged[merged.length - 1]
    if (last && sp.start <= last.end) {
      last.end = Math.max(last.end, sp.end)
      if (!last.why.includes(sp.why)) last.why += ` · ${sp.why}`
    } else {
      merged.push({ ...sp })
    }
  }
  return merged
}

/**
 * 风险等级。high 意味着「不自动放行，等人决定」。
 *
 * @param cwd 会话工作目录，用来识别「写到工作目录之外」
 */
export function assessRisk(toolName, toolInput, cwd, { argsKnown = true } = {}) {
  const reasons = []
  const t = toolInput && typeof toolInput === 'object' ? toolInput : {}

  /**
   * 参数**不知道**的时候，一律按高危处理。
   *
   * 这条路径来自 DSH：它的 ApprovalRequest 刻意不带工具参数，桥接侧靠
   * callId 回查 session log，查不到就只能说「不知道」（见 plugins/dsh-bridge）。
   *
   * 「不知道」和「没有参数」必须分开——传个 {} 进来的话，下面每条规则都
   * 匹配不上，于是算出 normal，于是进入自动通过的档位。那就是一次**没有
   * 任何人真正看过内容的放行**，而且卡片上还会显得人畜无害。
   *
   * 判成 high 的直接后果是不自动通过（见 approvals.create 的 canAuto），
   * 必须由人点一下。参数未知时让人多看一眼，是这里唯一说得过去的默认值。
   */
  if (!argsKnown) {
    return { level: 'high', reasons: ['工具参数未知，无法评估'] }
  }

  /**
   * shell 规则的触发条件是「**有没有命令**」，不是「工具叫不叫 Bash」。
   *
   * 原来写的是 `toolName === 'Bash'`，精确匹配 Claude Code 的工具名。
   * 接 DSH 时实测发现它的工具叫 **`bash`**（小写），于是整套 HIGH_RISK_BASH
   * 规则一条都不会跑——`rm -rf /` 判普通风险，10 秒自动放行。
   * 名字差一个字母，安全核心就整个静默失效了，而且没有任何报错。
   *
   * 所以判据换成「参数里有 command 字符串」：命令是什么形状由参数决定，
   * 跟哪个后端、工具叫什么名字无关。名字仍然认（大小写不敏感），
   * 那是为了 command 字段哪天改名时还有第二道。
   *
   * 代价是可能对一个恰好带 command 参数的别的工具跑一遍 shell 规则，
   * 结果是**多判几次高危**——那是安全的方向：多让人点一下，
   * 而不是少拦一次 rm -rf。
   */
  const cmd = String(t.command ?? t.cmd ?? '')
  if (cmd || String(toolName ?? '').toLowerCase() === 'bash') {
    for (const { re, why } of HIGH_RISK_BASH) if (re.test(cmd)) reasons.push(why)
    // 曾经漏掉的一整类：SENSITIVE_PATH 只作用于 file_path 参数，
    // 于是 `cat ~/.ssh/id_rsa` 判普通风险、10 秒自动放行。
    const secret = secretExposure(cmd)
    if (secret) reasons.push(secret)
  }

  const p = String(t.file_path ?? t.path ?? t.notebook_path ?? '')
  if (p) {
    if (SENSITIVE_PATH.test(p)) reasons.push('触及密钥/凭证文件')
    if (cwd && escapesWorkspace(p, cwd)) reasons.push('触及工作目录之外')
  }

  if (toolName?.startsWith('mcp__')) reasons.push('经由 MCP 对外调用')

  return { level: reasons.length ? 'high' : 'normal', reasons: [...new Set(reasons)] }
}
