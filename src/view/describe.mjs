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
    const p = String(t.file_path ?? t.path ?? t.notebook_path ?? '')
    const change = fileChange(toolName, t)
    return {
      headline: `${toolName === 'Write' ? '写入' : '修改'} ${p.split('/').pop() || '文件'}`,
      detail: p,
      change,
      impact: [
        { label: '改动文件', tone: 'warn' },
        // 改了多少是判断「这是不是我要的那个改动」最快的一个信号，
        // 而它在标签行就能给出来，不必展开内容
        ...(change ? [{ label: changeTally(change), tone: 'warn' }] : []),
      ],
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

/**
 * 写文件类操作的**内容预览**。
 *
 * ## 为什么必须有
 *
 * 在这之前，Edit / Write 的 detail 就是一个文件路径。也就是说手机上问你
 * 「修改 auth.ts，批准吗」，而你能依据的只有模型自己写的那句 headline——
 * 可这个文件顶上就写着：模型写的 description 是链路里唯一由被审查方生成的
 * 文本，不可信。Bash 那一支因此把命令原文当主视觉，写文件这一支却把
 * 唯一可信的东西（要写进去的内容）整个丢掉了。同一条原则漏做了一半。
 *
 * ## 为什么不做真正的 diff 算法
 *
 * Edit 的参数是 old_string / new_string——**替换目标**，不是文件全文，
 * 我们手上根本没有上下文。跑 LCS 只会在一份残缺的输入上算出一个看着
 * 很像 diff 的东西，而它暗示的「这就是文件的变化」是假的。
 * 所以老实按块给：旧的整块标 −，新的整块标 +。
 *
 * 唯一做的整理是**掐掉首尾完全相同的行**：模型常在 old/new 两侧各带几行
 * 上下文，两边一模一样，占满手机屏幕却不携带任何信息。掐掉是安全的——
 * 被掐的行两侧逐字相同，没有任何内容因此被藏起来，而且掐了多少会明说。
 *
 * ## 截断与风险的关系
 *
 * truncateDetail 那条「用户看到的必须包含判定所依据的内容」在这里不适用，
 * 因为风险判定**根本不读内容**：assess.mjs 对 Edit/Write 只看 file_path
 * （敏感路径、越界写入）。路径永远完整显示，所以截断内容不会让人对着
 * 看不见的判定依据签字。反过来说也得记住：内容里有什么，风险那栏一个字
 * 都不会说——这正是要把它显示出来给人看的原因。
 */
export const MAX_CHANGE_LINES = 60
export const MAX_CHANGE_LINE_CHARS = 200
export const MAX_CHANGE_CHARS = 4000

/** 一行的形状：t 是 '+' / '-'，s 是文本。前端按 t 上色，不解析内容。 */
function toLines(text, mark) {
  return String(text ?? '').split('\n').map((s) => ({ t: mark, s }))
}

/**
 * 把 old_string / new_string 的一侧切成行。
 *
 * 空串要给**空数组**，不能给 `['']`——而 `''.split('\n')` 恰恰返回后者。
 * 差别不是审美：一次纯删除（new_string 为空）会因此多出一条空的 `+` 行，
 * added 被算成 1，标签行显示「+1 −1」。那个标签还会出现在首页列表和通知里，
 * 于是一次纯删除被告知「新增了 1 行」，diff 里还有一条空的绿行暗示写进了东西。
 */
function sideLines(s) {
  const v = String(s ?? '')
  return v === '' ? [] : v.split('\n')
}

/** 掐掉两侧逐字相同的行，返回 { before, after, trimmed } */
function trimCommonEdges(oldLines, newLines) {
  let head = 0
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head++
  let tail = 0
  while (
    tail < oldLines.length - head &&
    tail < newLines.length - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) tail++
  return {
    before: oldLines.slice(head, oldLines.length - tail),
    after: newLines.slice(head, newLines.length - tail),
    trimmed: head + tail,
  }
}

/**
 * @returns {{kind:string, path:string, lines:{t:string,s:string}[],
 *            added:number, removed:number, trimmed:number,
 *            truncated:{lines:number,chars:number}|null} | null}
 */
export function fileChange(toolName, toolInput) {
  const t = toolInput && typeof toolInput === 'object' ? toolInput : {}
  const path = String(t.file_path ?? t.path ?? t.notebook_path ?? '')

  let lines = []
  let trimmed = 0
  let kind = 'write'

  if (toolName === 'Write') {
    if (typeof t.content !== 'string') return null
    lines = toLines(t.content, '+')
  } else if (toolName === 'NotebookEdit') {
    kind = 'notebook'
    // 删单元格没有新内容可看，但「要删掉哪个」本身就是要给人看的事
    if (t.edit_mode === 'delete') {
      lines = [{ t: '-', s: `删除单元格 ${String(t.cell_id ?? '').slice(0, 80) || '（未指定）'}` }]
    } else if (typeof t.new_source === 'string') {
      lines = toLines(t.new_source, '+')
    } else return null
  } else {
    kind = 'edit'
    // old_string 为空串是合法的（相当于插入），所以判类型不判真假
    if (typeof t.new_string !== 'string' && typeof t.old_string !== 'string') return null
    const cut = trimCommonEdges(sideLines(t.old_string), sideLines(t.new_string))
    trimmed = cut.trimmed
    lines = [
      ...cut.before.map((s) => ({ t: '-', s })),
      ...cut.after.map((s) => ({ t: '+', s })),
    ]
  }

  // 全空（比如 Write 写了个空文件）也要给出来：那本身就是要批准的事实
  if (!lines.length) lines = [{ t: '+', s: '' }]

  const added = lines.filter((l) => l.t === '+').length
  const removed = lines.filter((l) => l.t === '-').length

  /**
   * 截断三道：单行长度、总行数、总字符数。三道都要，因为一行几万字符的
   * 压缩产物、几千行的生成文件、以及两者的组合是三种不同的爆法。
   *
   * **字符预算用尽就 break，绝不能 continue。** 原来是 continue：某一行超出
   * 剩余预算被跳过，而它**后面**较短的行仍然通过检查被显示出来——于是
   * diff 中间被静默挖掉一行，而页面底下只说「还有 N 行未显示」，读起来是
   * 「尾部截断了」。实测复现过：20 行 199 字符之后，第 21 行被吞掉，
   * 第 22 行的 `rm -rf ~` 紧挨着第 20 行显示，看上去完全连续。
   *
   * 截断可以，挖洞不行——用户是照着这段内容点「批准」的。
   */
  let truncatedChars = 0
  let total = 0
  const shown = []
  for (const raw of lines.slice(0, MAX_CHANGE_LINES)) {
    const clipped = raw.s.length > MAX_CHANGE_LINE_CHARS
      ? { t: raw.t, s: raw.s.slice(0, MAX_CHANGE_LINE_CHARS) }
      : raw
    if (total + clipped.s.length > MAX_CHANGE_CHARS) break
    total += clipped.s.length
    // 只统计**显示出来的**那些行被削掉多少。整行没显示的算进 hiddenLines，
    // 两边都记一遍会让底下那句话把同一批内容说两次
    if (clipped !== raw) truncatedChars += raw.s.length - MAX_CHANGE_LINE_CHARS
    shown.push(clipped)
  }
  const hiddenLines = lines.length - shown.length

  return {
    kind,
    path,
    lines: shown,
    added,
    removed,
    trimmed,
    truncated: hiddenLines || truncatedChars ? { lines: hiddenLines, chars: truncatedChars } : null,
  }
}

/** 标签行上那个「+12 −3」。Write 只有加，就不写那个 −0。 */
export function changeTally(change) {
  const parts = []
  if (change.added) parts.push(`+${change.added}`)
  if (change.removed) parts.push(`−${change.removed}`)
  return parts.join(' ') || '无改动'
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
