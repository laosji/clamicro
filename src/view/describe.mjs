import { impactOf, isDefinitelyReadOnly } from '../risk/assess.mjs'
import { HIGH_RISK_BASH } from '../risk/rules.mjs'

/**
 * 把一次工具调用描述成人能读的东西。
 *
 * 是 `(toolName, toolInput) → 展示结构` 的纯函数，不碰审批状态机，
 * 所以能单独测。它和 risk/ 是一对：risk 判「危不危险」，这里管「怎么说清楚」。
 *
 * 贯穿这个文件的一条原则：**模型写的 description 不可信**。
 * 它是链路里唯一由被审查方生成的文本，所以它不能占主视觉、不符时要说破。
 */

/**
 * 描述在自称只读/无害。
 *
 * 只匹配开头的动词——不做语义比对，那需要另一个模型，而那个模型同样不可信。
 */
const HARMLESS_SOUNDING =
  /^(?:查看|列出|读取|检查|确认|显示|统计|搜索|查找|list|show|read|check|view|inspect|display|count|search|find|verify)/i

/**
 * 描述说自己无害，命令却不是。
 *
 * 返回一句话或 null。这条比「高风险」更值得显眼：高风险只是说这事危险，
 * 不符是说那句人话在骗你。
 */
export function describeMismatch(description, cmd) {
  const d = String(description ?? '').trim()
  if (!d || !cmd) return null
  if (!HARMLESS_SOUNDING.test(d)) return null
  if (isDefinitelyReadOnly(cmd)) return null
  const hit = HIGH_RISK_BASH.find(({ re }) => re.test(cmd))
  if (hit) return `描述称「${d.slice(0, 24)}」，但命令会${hit.why}`
  return `描述听起来是只读操作，但命令并非只读`
}

/**
 * 分成几层，供 UI 按重要性排版：
 *   detail    —— 命令/路径原文，**主视觉**
 *   headline  —— 模型写的一句话，辅助
 *   impact    —— 影响面标签
 *   mismatch  —— 描述与命令不符的警告，没有则 null
 */
/**
 * 把 AskUserQuestion 的输入拆成手机能渲染的结构。
 *
 * ## 为什么必须特判
 *
 * 走通用分支的话，headline 是光秃秃的 `AskUserQuestion`，detail 是一整坨
 * 十几行的原始 JSON——手机上根本读不了，而且底下只有「允许 / 拒绝」两个
 * 按钮，对一道选择题毫无意义。
 *
 * ## 只取渲染需要的字段
 *
 * question / header / label / description / multiSelect，其余一律不带。
 * 这些文本会进 HTML，转义在前端做；这里只负责**把结构理出来**，
 * 顺便把长度掐住——description 可以写得很长，手机上一屏放不下。
 */
export function askQuestions(toolInput) {
  const t = toolInput && typeof toolInput === 'object' ? toolInput : {}
  const qs = Array.isArray(t.questions) ? t.questions : []
  return qs.slice(0, 4).map((q, i) => ({
    idx: i,
    question: String(q?.question ?? '').slice(0, 500),
    header: String(q?.header ?? '').slice(0, 40),
    multiSelect: !!q?.multiSelect,
    options: (Array.isArray(q?.options) ? q.options : []).slice(0, 8).map((o) => ({
      label: String(o?.label ?? '').slice(0, 120),
      description: String(o?.description ?? '').slice(0, 400),
    })).filter((o) => o.label),
  })).filter((q) => q.question && q.options.length)
}

export function analyze(toolName, toolInput) {
  const t = toolInput && typeof toolInput === 'object' ? toolInput : {}

  if (toolName === 'AskUserQuestion') {
    const qs = askQuestions(t)
    // 标题用第一道题的 header（那本来就是给人看的短标签），退而求其次用题干。
    // 「AskUserQuestion」这个工具名对人零信息量，不该出现在通知和列表里
    const first = qs[0]
    return {
      headline: first ? (first.header || first.question).slice(0, 60) : '一个需要你回答的问题',
      // detail 仍然给出题干：手机上按 choices 渲染，而通知正文和终端只有纯文本
      detail: qs.map((q) => q.question).join('\n\n') || JSON.stringify(t, null, 2).slice(0, 2000),
      impact: [{ label: '等你回答', tone: 'calm' }],
    }
  }

  if (toolName === 'Bash') {
    const cmd = String(t.command ?? '')
    return {
      headline: t.description || firstMeaningfulLine(cmd) || '执行 shell 命令',
      detail: cmd,
      impact: impactOf('Bash', t),
      mismatch: describeMismatch(t.description, cmd),
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
    return {
      headline: `读取 ${target.split('/').pop() || target}`,
      detail: target,
      impact: [{ label: '只读', tone: 'calm' }],
    }
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

export const MAX_DETAIL = 3000

/**
 * 截断长命令。
 *
 * 关键约束：**风险判定读的是全文，用户看到的必须包含判定所依据的内容。**
 * 曾经不是这样——400 行 echo 后面跟一句 `sudo rm -rf /`，判定正确地标了高危，
 * 但用户在页面上翻到底也看不到那一句，等于让人对着看不见的东西签字。
 *
 * 所以截断时把被省略部分里命中规则的行单独提出来附在后面。
 */
export function truncateDetail(d) {
  const s = String(d ?? '')
  if (s.length <= MAX_DETAIL) return s

  const head = s.slice(0, MAX_DETAIL)
  const hidden = s.slice(MAX_DETAIL)
  const flagged = hidden
    .split('\n')
    .filter((line) => HIGH_RISK_BASH.some(({ re }) => re.test(line)))
    .map((line) => line.trim())
    .slice(0, 10)

  let out = `${head}\n\n… 中间省略 ${hidden.length} 个字符`
  if (flagged.length) {
    out += `\n\n⚠️ 被省略的部分里有命中风险规则的内容：\n${flagged.map((l) => `  ${l}`).join('\n')}`
  }
  return out
}

/** 跳过 cd / 变量赋值 / 注释，取第一条真正干活的命令 */
export function firstMeaningfulLine(cmd) {
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
