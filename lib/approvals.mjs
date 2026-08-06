import { EventEmitter } from 'node:events'
import { randomBytes, randomUUID } from 'node:crypto'

// hook 默认超时 600s。我们在 570s 主动返回 deny，绝不让它走到系统超时——
// 否则超时会被当成「非阻塞错误」而放行到正常权限流程，人不在电脑边时终端会
// 空挂在那里等一个没人看的弹框。（计划 §2.1）
export const SELF_TIMEOUT_MS = Number(process.env.CLAMICRO_APPROVAL_TIMEOUT_MS) || 570_000

export const OUTCOME = {
  ALLOW: 'allow',
  DENY: 'deny',
}

const HIGH_RISK_BASH = [
  { re: /\brm\s+(-\w*[rf]\w*\s+)+/, why: '递归/强制删除' },
  { re: /\bgit\s+push\b[^|;]*\s(--force|-f)\b/, why: '强推覆盖远端' },
  { re: /\bgit\s+(reset\s+--hard|clean\s+-\w*[fd])/, why: '丢弃本地改动' },
  { re: /\bsudo\b/, why: '提权执行' },
  { re: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/, why: '下载后直接执行' },
  { re: /\b(dd|mkfs|diskutil\s+erase)\b/, why: '磁盘级操作' },
  { re: /\bchmod\s+(-R\s+)?777\b/, why: '放开全部权限' },
  { re: /\b(shutdown|reboot|killall)\b/, why: '系统级中断' },
  { re: />\s*\/dev\/(sd|disk)/, why: '写入裸设备' },
  { re: /\bnpm\s+publish\b|\bgh\s+release\s+create\b/, why: '对外发布' },
]

const SENSITIVE_PATH = /(^|\/)(\.env(\.|$)|id_[rd]sa|.*\.pem$|.*\.key$|credentials$|\.aws\/|\.ssh\/|\.npmrc$|\.netrc$)/

function assessRisk(toolName, toolInput, cwd) {
  const reasons = []
  if (toolName === 'Bash') {
    const cmd = toolInput?.command ?? ''
    for (const { re, why } of HIGH_RISK_BASH) if (re.test(cmd)) reasons.push(why)
  }
  const p = toolInput?.file_path ?? toolInput?.path ?? ''
  if (p) {
    if (SENSITIVE_PATH.test(p)) reasons.push('触及密钥/凭证文件')
    if (cwd && p.startsWith('/') && !p.startsWith(cwd)) reasons.push('写入工作目录之外')
  }
  if (toolName?.startsWith('mcp__')) reasons.push('经由 MCP 对外调用')
  return { level: reasons.length ? 'high' : 'normal', reasons }
}

const IMPACT = [
  { re: /\bsudo\b/, label: '提权', tone: 'danger' },
  { re: /\b(curl|wget|ssh|scp|rsync)\b|\bgit\s+(push|pull|fetch|clone)\b|\bnpm\s+(i|install|publish)\b|\bbrew\b/, label: '联网', tone: 'warn' },
  { re: /\b(rm|mv|cp|mkdir|touch|chmod|chown|ln)\b|\bsed\s+-i\b|>{1,2}\s*\S|\btee\b|\bgit\s+(commit|checkout|reset|clean|merge|rebase)\b/, label: '改动文件', tone: 'warn' },
]

/**
 * 把工具调用拆成三层，供 UI 按重要性排版：
 *   headline —— 一句人话（Bash 工具自带 description，直接用）
 *   detail   —— 命令/路径原文，默认折叠
 *   impact   —— 影响面标签，帮助不读原文也能判断
 */
function analyze(toolName, toolInput) {
  const t = toolInput && typeof toolInput === 'object' ? toolInput : {}

  if (toolName === 'Bash') {
    const cmd = String(t.command ?? '')
    const impact = IMPACT.filter((i) => i.re.test(cmd)).map(({ label, tone }) => ({ label, tone }))
    if (!impact.length) impact.push({ label: '只读', tone: 'calm' })
    return {
      // Claude Code 给 Bash 传了 description，之前被白白浪费掉了
      headline: t.description || firstMeaningfulLine(cmd) || '执行 shell 命令',
      detail: cmd,
      impact,
    }
  }

  if (/^(Edit|Write|NotebookEdit)$/.test(toolName)) {
    const p = String(t.file_path ?? t.path ?? '')
    return {
      headline: `${toolName === 'Write' ? '写入' : '修改'} ${p.split('/').pop() || '文件'}`,
      detail: p,
      impact: [{ label: '改动文件', tone: 'warn' }],
    }
  }

  if (/^(Read|Grep|Glob|NotebookRead)$/.test(toolName)) {
    const target = String(t.file_path ?? t.pattern ?? t.path ?? '')
    return { headline: `读取 ${target.split('/').pop() || target}`, detail: target, impact: [{ label: '只读', tone: 'calm' }] }
  }

  if (/^(WebFetch|WebSearch)$/.test(toolName)) {
    return {
      headline: t.url ? `访问 ${safeHost(t.url)}` : `搜索「${t.query ?? ''}」`,
      detail: String(t.url ?? t.query ?? ''),
      impact: [{ label: '联网', tone: 'warn' }],
    }
  }

  if (toolName?.startsWith('mcp__')) {
    return {
      headline: `MCP 调用 ${toolName.split('__').slice(1).join(' · ')}`,
      detail: JSON.stringify(t, null, 2).slice(0, 2000),
      impact: [{ label: '经由 MCP 对外', tone: 'warn' }],
    }
  }

  return {
    headline: t.description || toolName || '未知操作',
    detail: JSON.stringify(t, null, 2).slice(0, 2000),
    impact: [],
  }
}

const MAX_DETAIL = 3000

function truncateDetail(d) {
  const s = String(d ?? '')
  if (s.length <= MAX_DETAIL) return s
  return s.slice(0, MAX_DETAIL) + `\n\n… 还有 ${s.length - MAX_DETAIL} 个字符未显示`
}

/** 跳过 cd / 变量赋值 / 注释，取第一条真正干活的命令 */
function firstMeaningfulLine(cmd) {
  for (const raw of cmd.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (/^(cd|export|set|source|\.)\s/.test(line)) continue
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(line)) continue
    return line.length > 90 ? line.slice(0, 89) + '…' : line
  }
  return cmd.split('\n')[0]?.trim() ?? ''
}

function safeHost(u) {
  try {
    return new URL(u).host
  } catch {
    return String(u).slice(0, 60)
  }
}

export class ApprovalStore extends EventEmitter {
  #items = new Map()
  #waiters = new Map() // id -> {resolve, timer}

  create({ session_id, tool_name, tool_input, permission_rule, tool_use_id, cwd }, policy = {}) {
    const now = Date.now()
    const risk = assessRisk(tool_name, tool_input, cwd)
    const view = analyze(tool_name, tool_input)

    // 无人操作时的默认结果，按风险分档：
    //   普通 → 短时自动通过（别为 npm run build 打扰人）
    //   高危 → 长时自动拒绝（失败即拒绝，人不在就不该放行 rm -rf）
    const autoApproveMs = Number(policy.autoApproveMs ?? 0)
    const canAuto = autoApproveMs > 0 && (risk.level !== 'high' || policy.autoApproveHighRisk)
    const autoDecision = canAuto ? OUTCOME.ALLOW : OUTCOME.DENY
    const ttl = canAuto ? autoApproveMs : Number(policy.timeoutMs ?? SELF_TIMEOUT_MS)

    const ap = {
      id: randomUUID(),
      // 单个审批专用密钥：既用于推送深链，也用于 ntfy 通知内按钮回调。
      // 作用域仅限这一条审批，且随它一起过期。
      key: randomBytes(18).toString('base64url'),
      session_id,
      tool_use_id: tool_use_id ?? null,
      tool_name: tool_name ?? 'unknown',
      tool_input: tool_input ?? {},
      headline: view.headline,
      // agent 生成的命令可能是几 KB 的 heredoc/脚本。全量塞进页面既拖慢
      // 渲染也没人看得完——超长就截断，明确标出还剩多少。
      detail: truncateDetail(view.detail),
      impact: view.impact,
      detail_lines: view.detail ? view.detail.split('\n').length : 0,
      // 首页卡片、日志、推送正文仍用一行摘要
      summary: view.headline,
      rule: permission_rule?.action ?? null,
      rule_behavior: permission_rule?.behavior ?? null,
      risk,
      created_at: now,
      expires_at: now + ttl,
      auto_decision: autoDecision, // 到点后会怎么处理，UI 要如实告诉用户
      status: 'pending', // pending | allowed | denied | auto_allowed | expired | abandoned
      decided_by: null, // phone | timeout | abandoned
      decided_at: null,
    }
    this.#items.set(ap.id, ap)
    this.emit('created', ap)
    return ap
  }

  get(id) {
    return this.#items.get(id) ?? null
  }

  /** 落盘用：导出全部记录 */
  all() {
    return [...this.#items.values()]
  }

  /**
   * 从磁盘恢复。仍是 pending 的一律转 abandoned——
   * 进程重启后那些 hook 的 HTTP 连接早就断了，Claude Code 那边
   * 已经走完各自的超时，再显示成「待审批」是在骗人。
   */
  restore(records) {
    let orphaned = 0
    for (const r of records ?? []) {
      if (!r?.id) continue
      if (r.status === 'pending') {
        r.status = 'abandoned'
        r.decided_by = 'restart'
        r.decided_at = r.decided_at ?? Date.now()
        orphaned++
      }
      this.#items.set(r.id, r)
    }
    return { restored: records?.length ?? 0, orphaned }
  }

  pending(sessionId) {
    return [...this.#items.values()].filter(
      (a) => a.status === 'pending' && (!sessionId || a.session_id === sessionId),
    )
  }

  /** 阻塞直到有人决策或自超时。返回 {decision, reason}。 */
  wait(id) {
    const ap = this.#items.get(id)
    if (!ap) return Promise.resolve({ decision: OUTCOME.DENY, reason: '审批记录不存在' })
    if (ap.status !== 'pending') return Promise.resolve(this.#outcomeOf(ap))

    return new Promise((resolve) => {
      const ttlSec = Math.round((ap.expires_at - ap.created_at) / 1000)
      const timer = setTimeout(() => {
        const allow = ap.auto_decision === OUTCOME.ALLOW
        this.#settle(id, allow ? 'auto_allowed' : 'expired', 'timeout')
        resolve(
          allow
            ? { decision: OUTCOME.ALLOW, reason: null }
            : { decision: OUTCOME.DENY, reason: `等待审批超时（${ttlSec}s），已自动拒绝` },
        )
      }, Math.max(0, ap.expires_at - Date.now()))
      timer.unref?.()
      this.#waiters.set(id, { resolve, timer })
    })
  }

  /** 幂等决策。第一个写入的赢，后到的返回当前状态而不报错。（计划 §4） */
  decide(id, decision, by = 'phone') {
    const ap = this.#items.get(id)
    if (!ap) return { ok: false, code: 'not_found' }
    if (ap.status !== 'pending') {
      return { ok: false, code: 'already_settled', approval: ap }
    }
    if (decision !== OUTCOME.ALLOW && decision !== OUTCOME.DENY) {
      return { ok: false, code: 'bad_decision' }
    }
    this.#settle(id, decision === OUTCOME.ALLOW ? 'allowed' : 'denied', by)
    return { ok: true, approval: ap }
  }

  /** Claude Code 侧断开（会话被杀 / 终端自己批了）→ 标记放弃，手机上给明确提示。 */
  abandon(id) {
    const ap = this.#items.get(id)
    if (!ap || ap.status !== 'pending') return
    this.#settle(id, 'abandoned', 'abandoned')
  }

  #settle(id, status, by) {
    const ap = this.#items.get(id)
    if (!ap || ap.status !== 'pending') return
    ap.status = status
    ap.decided_by = by
    ap.decided_at = Date.now()
    this.emit('settled', ap)

    const waiter = this.#waiters.get(id)
    if (waiter) {
      clearTimeout(waiter.timer)
      this.#waiters.delete(id)
      if (status !== 'expired') waiter.resolve(this.#outcomeOf(ap))
    }
  }

  #outcomeOf(ap) {
    if (ap.status === 'allowed' || ap.status === 'auto_allowed') return { decision: OUTCOME.ALLOW, reason: null }
    if (ap.status === 'denied') return { decision: OUTCOME.DENY, reason: '你在手机上拒绝了这个操作' }
    if (ap.status === 'abandoned') return { decision: OUTCOME.DENY, reason: '审批已放弃' }
    return { decision: OUTCOME.DENY, reason: '审批未通过' }
  }

  /** 定期清理已结束的记录，避免内存无限增长 */
  sweep(maxAgeMs = 3600_000) {
    const cutoff = Date.now() - maxAgeMs
    for (const [id, ap] of this.#items) {
      if (ap.status !== 'pending' && (ap.decided_at ?? ap.created_at) < cutoff) this.#items.delete(id)
    }
  }
}
