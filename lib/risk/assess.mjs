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
 * 影响面标签。**认不出来就说认不出来**，不要假装只读。
 */
export function impactOf(toolName, toolInput) {
  const t = toolInput && typeof toolInput === 'object' ? toolInput : {}

  if (toolName !== 'Bash') return null // 非 Bash 由调用方按工具类型直接给

  const cmd = String(t.command ?? '')
  const hits = IMPACT.filter((i) => i.re.test(cmd)).map(({ label, tone }) => ({ label, tone }))
  if (hits.length) return hits
  if (isDefinitelyReadOnly(cmd)) return [{ label: '只读', tone: 'calm' }]
  // 既没命中任何已知影响面，也不在只读白名单里 —— 老实说不知道
  return [{ label: '影响面未知', tone: 'warn' }]
}

/**
 * 风险等级。high 意味着「不自动放行，等人决定」。
 *
 * @param cwd 会话工作目录，用来识别「写到工作目录之外」
 */
export function assessRisk(toolName, toolInput, cwd) {
  const reasons = []
  const t = toolInput && typeof toolInput === 'object' ? toolInput : {}

  if (toolName === 'Bash') {
    const cmd = String(t.command ?? '')
    for (const { re, why } of HIGH_RISK_BASH) if (re.test(cmd)) reasons.push(why)
    // 曾经漏掉的一整类：SENSITIVE_PATH 只作用于 file_path 参数，
    // 于是 `cat ~/.ssh/id_rsa` 判普通风险、10 秒自动放行。
    const secret = secretExposure(cmd)
    if (secret) reasons.push(secret)
  }

  const p = String(t.file_path ?? t.path ?? t.notebook_path ?? '')
  if (p) {
    if (SENSITIVE_PATH.test(p)) reasons.push('触及密钥/凭证文件')
    if (cwd && p.startsWith('/') && !p.startsWith(cwd)) reasons.push('写入工作目录之外')
  }

  if (toolName?.startsWith('mcp__')) reasons.push('经由 MCP 对外调用')

  return { level: reasons.length ? 'high' : 'normal', reasons: [...new Set(reasons)] }
}
