/**
 * 起一个真实的服务进程做集成测试。
 *
 * 为什么不 import handler 直接调：要测的恰恰是进程边界上的东西——
 * Host 白名单、回环判定、cookie、CSP 头、端口绑定。在同一个进程里
 * 伪造 req/res 会把这些全绕过去，测了个寂寞。
 *
 * HOME 指到临时目录：配置、历史、token 都是全新的，不碰用户的真实数据，
 * 也不会因为「当前网络未被信任」而只绑回环——那正是我们想要的，
 * 测试不该往局域网上暴露任何东西。
 */
import { spawn } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * @param env 额外环境变量。主要用途是改 PATH，把 qrencode / osascript 换成
 *   假的——那两条外部依赖的失败路径没法在真机上直接制造，而它们恰恰
 *   是「屏幕上什么都没有，前端却说有」这类故障的源头。
 */
export async function startServer({ port = 8791, env = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'clamicro-http-'))
  const child = spawn(process.execPath, [join(ROOT, 'server.mjs')], {
    env: { ...process.env, HOME: home, CLAMICRO_PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const logs = []
  child.stdout.on('data', (d) => logs.push(String(d)))
  child.stderr.on('data', (d) => logs.push(String(d)))
  let died = null
  child.on('exit', (code, signal) => { died = signal ? `信号 ${signal}` : `退出码 ${code}` })

  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 8000
  let up = false
  let stranger = false
  while (Date.now() < deadline) {
    if (died) break
    try {
      const r = await fetch(`${base}/healthz`)
      const body = r.ok ? await r.json() : null
      /**
       * **必须认 pid**，不能只看 healthz 通不通。
       *
       * 端口被别的进程占着时，healthz 照样回 200——应答的是那个陌生进程，
       * 而我们的子进程正因为 EADDRINUSE 在退出。原来这里以为起来了，
       * 下一行去读自己临时 HOME 里的 config.json，撞上一句
       * `ENOENT: ... config.json`（子进程还没来得及写完就死了）。
       *
       * 那句报错指向的地方跟真正的原因毫无关系。这个坑是真踩过的：手动起
       * 了一个服务占着 8799，两条 codex-tail 的测试立刻开始报「文件不存在」,
       * 看起来像是配置写入坏了，查了半天才发现是端口。
       *
       * pid 这一招不是新发明的：CLI 在 kill 之前用的就是它，理由一模一样
       * ——「端口上这个进程真的是我要找的那个吗」。见 server.mjs 的 /healthz。
       */
      if (body?.ok && body.pid === child.pid) { up = true; break }
      if (body?.ok) stranger = true
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 80))
  }
  if (!up) {
    child.kill('SIGKILL')
    rmSync(home, { recursive: true, force: true })
    const why = stranger
      ? `端口 ${port} 被**别的进程**占着（healthz 应答的不是我们起的那个）。`
        + `test/ 下每个文件的端口必须唯一，也别在跑测试时手动起服务。`
      : died
        ? `服务起来就退了（${died}）。`
        : '服务没起来。'
    throw new Error(`${why}日志：\n${logs.join('')}`)
  }

  const cfgFile = join(home, '.claude', 'clamicro', 'config.json')
  const token = JSON.parse(readFileSync(cfgFile, 'utf8')).token

  return {
    base,
    token,
    home,
    logs: () => logs.join(''),
    /** 带 token 的 fetch；opts.raw = true 时不带认证 */
    async get(path, opts = {}) {
      return fetch(base + path, {
        redirect: 'manual',
        headers: {
          ...(opts.raw ? {} : { Authorization: `Bearer ${token}` }),
          ...(opts.headers ?? {}),
        },
      })
    },
    async post(path, body, opts = {}) {
      return fetch(base + path, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json',
          ...(opts.raw ? {} : { Authorization: `Bearer ${token}` }),
          ...(opts.headers ?? {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    },
    /**
     * 原生请求，可以设任意 Host 头。
     *
     * fetch 不行：Host 是 forbidden header name，规范要求实现忽略调用方设置的值。
     * 我第一版就是用 fetch 测 DNS rebinding 的，头被静默丢弃、请求带着真实 Host
     * 发出去，于是「伪造 Host 被拒」这条测试测的其实是「合法 Host 被放行」。
     * 差一点就把一条毫无意义的断言当成安全验证收下了。
     */
    raw(path, { host, method = 'GET', headers = {} } = {}) {
      return new Promise((resolve, reject) => {
        const req = httpRequest(
          { host: '127.0.0.1', port, path, method, headers: { ...(host ? { Host: host } : {}), ...headers } },
          (res) => {
            let body = ''
            res.on('data', (c) => (body += c))
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
          },
        )
        req.on('error', reject)
        req.end()
      })
    },
    async stop() {
      child.kill('SIGTERM')
      await new Promise((r) => setTimeout(r, 300))
      if (!child.killed) child.kill('SIGKILL')
      if (existsSync(home)) rmSync(home, { recursive: true, force: true })
    },
  }
}
