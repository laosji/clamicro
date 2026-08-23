/**
 * Codex 审批闭环的验收探针。
 *
 * ## 它回答的两个问题
 *
 * 接 Codex 的时候，有两件事只能在真机上问出答案，而这两件事决定了
 * src/agents.mjs 里 codex 的 `approve` 能不能填 true：
 *
 *   1. **hook 能不能把一次工具调用挂住，挂多久。** 审批的全部意义就是在人
 *      做决定之前把事情停下。挂不住，这个功能就不存在。
 *   2. **「拒绝」到底认不认。** 这条比第 1 条更要紧：猜错的表现不是按钮
 *      没反应，是手机上写着「已拒绝」而命令照样跑完——一个假审批。
 *
 * 所以探针跑两轮：一轮放行、一轮拒绝，各看命令有没有真的执行。
 * 两轮结论相反，才算证明了 Codex 读懂了我们的回包；只有拒绝那一轮通过，
 * 也可能只是因为 `codex exec` 里没有人可问、它自己拒了。
 *
 * ## 为什么不需要 Codex 额度
 *
 * 探针自带一个假的模型服务（OpenAI Responses 协议，几十行），让 Codex 连到
 * 127.0.0.1 上，第一回合直接回一个 exec_command 工具调用。所以整个过程不花
 * 一个 token，也跟你的账号额度无关。
 *
 * ## 用法
 *
 *   node scripts/codex-probe.mjs            # 挂 20 秒
 *   node scripts/codex-probe.mjs --nap 300  # 想知道能挂多久就往大了填
 *
 * 全程只碰一个临时目录（自己的 CODEX_HOME），不读也不改你真实的
 * ~/.codex/config.toml。
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? dflt : process.argv[i + 1]
}
const NAP = Number(arg('nap', 20))
// 8802 是 test/approval-key-expiry.test.mjs 第二个服务用的端口，别撞
const PORT = Number(arg('port', 8899))

/**
 * 找 codex。
 *
 * PATH 上多半没有：它通常是 ChatGPT.app 里带的那一份。这也是
 * agents.mjs 的 detectAgents 不按 PATH 探 codex 的原因。
 */
function findCodex() {
  const candidates = [
    process.env.CODEX_BIN,
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    join(process.env.HOME ?? '', '.local/bin/codex'),
  ].filter(Boolean)
  return candidates.find((p) => existsSync(p)) ?? null
}

/**
 * 假模型服务。
 *
 * 第一回合回一个要求提权的 exec_command——**必须提权**，否则 Codex 直接在
 * 沙箱里跑掉了，根本不会问任何人，也就摸不到 PermissionRequest。
 * 第二回合回一句话收尾。
 *
 * 两个当初调这段时踩到的坑，别再踩：
 *   · SSE 必须带 `event:` 行，`response.completed` 的 response 对象也要写全
 *     （status/output/usage 都要有），否则 Codex 一路重连到
 *     「stream closed before response.completed」。
 *   · 回合计数只能数 /responses。Codex 启动时会先 GET /v1/models，
 *     算进去的话第一回合就被它吃掉了，工具调用永远不会发生。
 */
function fakeProvider(marker) {
  let turn = 0
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (!req.url.includes('/responses')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"data":[]}')
        return
      }
      turn++
      const sse = (o) => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`)
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      sse({ type: 'response.created', response: { id: `r${turn}` } })
      sse({
        type: 'response.output_item.done',
        item: turn === 1
          ? {
              type: 'function_call',
              name: 'exec_command',
              call_id: 'call_1',
              id: 'fc_1',
              arguments: JSON.stringify({
                cmd: `echo ran > ${marker}`,
                sandbox_permissions: 'require_escalated',
                justification: 'clamicro 探针：这一条必须走审批',
              }),
            }
          : { type: 'message', role: 'assistant', id: 'm1', content: [{ type: 'output_text', text: 'done' }] },
      })
      sse({
        type: 'response.completed',
        response: {
          id: `r${turn}`,
          object: 'response',
          status: 'completed',
          model: 'probe',
          output: [],
          usage: {
            input_tokens: 1,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 1,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 2,
          },
        },
      })
      res.end()
    })
  })
  return new Promise((ok) => server.listen(PORT, '127.0.0.1', () => ok(server)))
}

/** 探针版的中继脚本：记时间戳、挂 NAP 秒、按 decision 回话。 */
function relayScript(log, decision) {
  const behavior = decision === 'allow' ? 'allow' : 'deny'
  return `#!/bin/bash
set -uo pipefail
ev="\$1"
payload=$(cat)
printf '%s\\tSTART\\t%s\\n' "\$(date +%s)" "\$ev" >> "${log}"
if [ "\$ev" = "permission-request" ]; then
  sleep ${NAP}
  printf '%s\\tEND\\t%s\\n' "\$(date +%s)" "\$ev" >> "${log}"
  printf '%s' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","permissionDecision":{"behavior":"${behavior}","message":"clamicro 探针"},"permissionDecisionReason":"clamicro 探针"}}'
  ${behavior === 'deny' ? 'exit 2' : 'exit 0'}
fi
printf '%s\\tEND\\t%s\\n' "\$(date +%s)" "\$ev" >> "${log}"
exit 0
`
}

function configToml(relay) {
  const hook = (event, endpoint, timeout) =>
    `[[hooks.${event}]]\nhooks = [{ type = "command", command = "${relay} ${endpoint}", timeout = ${timeout} }]\n`
  return [
    'model_provider = "probe"',
    'model = "probe"',
    'model_context_window = 128000',
    'approval_policy = "on-request"',
    '',
    '[model_providers.probe]',
    'name = "probe"',
    `base_url = "http://127.0.0.1:${PORT}/v1"`,
    'wire_api = "responses"',
    'env_key = "PROBE_KEY"',
    '',
    hook('PermissionRequest', 'permission-request', Math.max(600, NAP + 60)),
    hook('PreToolUse', 'pre-tool-use', 30),
    hook('PostToolUse', 'post-tool-use', 30),
  ].join('\n')
}

async function round(codex, decision) {
  const home = mkdtempSync(join(tmpdir(), 'clamicro-codex-probe-'))
  const log = join(home, 'hooks.log')
  const marker = join(home, 'marker.txt')
  const relay = join(home, 'relay.sh')
  writeFileSync(relay, relayScript(log, decision))
  chmodSync(relay, 0o755)
  writeFileSync(log, '')
  writeFileSync(join(home, 'config.toml'), configToml(relay))

  const server = await fakeProvider(marker)
  const started = Date.now()
  await new Promise((done) => {
    const child = spawn(
      codex,
      [
        'exec',
        '--skip-git-repo-check',
        '--sandbox', 'read-only',
        // 探针自己写的 hooks，放在一个刚建出来的临时目录里。这个开关是 Codex
        // 给「已经自己审过 hook 来源的自动化」留的，正是这里的情形。
        '--dangerously-bypass-hook-trust',
        '-C', home,
        'go',
      ],
      { env: { ...process.env, CODEX_HOME: home, PROBE_KEY: 'x' }, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    child.stdout.on('data', () => {})
    child.stderr.on('data', () => {})
    child.on('close', done)
  })
  const elapsed = Math.round((Date.now() - started) / 1000)
  server.close()

  const events = readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t'))
  const fired = [...new Set(events.map((e) => e[2]))]
  const ran = existsSync(marker)
  rmSync(home, { recursive: true, force: true })
  return { fired, ran, elapsed }
}

const codex = findCodex()
if (!codex) {
  console.error('找不到 codex 可执行文件。装了 ChatGPT.app 或 codex CLI 再跑，或用 CODEX_BIN=... 指定。')
  process.exit(1)
}
console.log(`codex: ${codex}`)
console.log(`审批 hook 会挂 ${NAP} 秒，两轮，请等一会儿\n`)

const allow = await round(codex, 'allow')
console.log(`放行那轮：hook 触发 ${allow.fired.join('、') || '（一个都没有）'}；命令${allow.ran ? '执行了' : '没执行'}；整轮 ${allow.elapsed}s`)

const deny = await round(codex, 'deny')
console.log(`拒绝那轮：hook 触发 ${deny.fired.join('、') || '（一个都没有）'}；命令${deny.ran ? '执行了' : '没执行'}；整轮 ${deny.elapsed}s\n`)

const held = allow.elapsed >= NAP
const ok = allow.fired.includes('permission-request') && held && allow.ran && !deny.ran

if (ok) {
  console.log(`✅ 通过。审批 hook 至少能挂住 ${NAP}s，放行和拒绝都被 Codex 认了。`)
  console.log('   可以把 src/agents.mjs 里 codex 的 approve 改成 true。')
  console.log('   pause / cancel / inbox 仍然没验证，别一起改。')
} else {
  console.log('❌ 不通过。逐条看：')
  if (!allow.fired.includes('permission-request')) {
    console.log('   · PermissionRequest 根本没触发 —— 要么这一版 Codex 不发这个事件，')
    console.log('     要么那条命令没走到审批（探针要求提权就是为了走到）。')
  } else if (!held) {
    console.log(`   · 整轮只花了 ${allow.elapsed}s，短于 ${NAP}s —— hook 被提前掐断了。`)
    console.log('     这就是「能挂多久」的答案：比这个数小。审批时限要压到它以下。')
  }
  if (allow.fired.includes('permission-request') && !allow.ran) {
    console.log('   · 放行没被认：回包的形状 Codex 读不懂，或者提权另有闸门。')
  }
  if (deny.ran) {
    console.log('   · 拒绝没被认 —— 这条最严重：手机上写着「已拒绝」，命令照样跑完。')
    console.log('     在查清楚之前，src/agents.mjs 里 codex 的 approve 必须保持 false。')
  }
  process.exitCode = 1
}
