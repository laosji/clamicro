/**
 * 配置的派生值。
 *
 * 隧道那组对应一个真实 bug：publicBaseUrl 是落盘持久化的，而 quick tunnel
 * 的地址是临时的。隧道进程一没，配置里那个地址就作废了，但 baseUrl 仍无条件
 * 使用它——之后生成的每个二维码、每条推送深链都指向打不开的域名，且不报错。
 *
 * 这个文件必须在导入 config.mjs **之前**改掉 HOME：CONFIG_DIR 在模块加载时
 * 就由 homedir() 算好了。node --test 每个文件一个进程，所以这样是安全的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, unlinkSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const HOME = mkdtempSync(join(tmpdir(), 'clamicro-test-'))
process.env.HOME = HOME
mkdirSync(join(HOME, '.claude', 'clamicro'), { recursive: true })

const CONFIG_FILE = join(HOME, '.claude', 'clamicro', 'config.json')
const PID_FILE = join(HOME, '.claude', 'clamicro', 'tunnel.pid')

const { loadConfig, saveConfig } = await import('../src/config.mjs')
const { __setCommandOf, commandOf } = await import('../src/service-id.mjs')
const realCommandOf = commandOf
test.after(() => __setCommandOf(realCommandOf))

const writeConfig = (o) => writeFileSync(CONFIG_FILE, JSON.stringify({ token: 't'.repeat(43), ...o }, null, 2))
const silence = () => {
  const orig = console.log
  console.log = () => {}
  return () => (console.log = orig)
}

test.after(() => rmSync(HOME, { recursive: true, force: true }))

test('隧道地址以进程存活为准，不以配置为准', async (t) => {
  const DEAD = 'https://dead-abcd.trycloudflare.com'

  await t.test('没有 pid 文件 → 忽略配置里的地址，回落局域网', () => {
    writeConfig({ publicBaseUrl: DEAD })
    try { unlinkSync(PID_FILE) } catch { /* 本来就没有 */ }
    const un = silence()
    const c = loadConfig()
    un()
    assert.equal(c.tunnelUrl, null)
    assert.ok(!c.baseUrl.includes('trycloudflare'), `baseUrl 不该用死地址: ${c.baseUrl}`)
  })

  await t.test('pid 指向已死进程 → 同样回落', () => {
    writeConfig({ publicBaseUrl: DEAD })
    writeFileSync(PID_FILE, '999999')
    const un = silence()
    const c = loadConfig()
    un()
    assert.equal(c.tunnelUrl, null)
  })

  await t.test('pid 指向存活的 cloudflared → 采用隧道地址', () => {
    // 判据看的是命令行。用 mock 冒充「这个 pid 的命令行是 cloudflared」，
    // 不 spawn 真进程、不依赖真 ps——ps 在极简容器/沙箱里可能不存在
    __setCommandOf(() => '/usr/local/bin/cloudflared tunnel --url http://127.0.0.1:8765')
    try {
      writeConfig({ publicBaseUrl: DEAD })
      writeFileSync(PID_FILE, String(process.pid))
      const un = silence()
      const c = loadConfig()
      un()
      assert.equal(c.tunnelUrl, DEAD)
      assert.equal(c.baseUrl, DEAD)
    } finally {
      try { unlinkSync(PID_FILE) } catch { /* 已经没了 */ }
    }
  })

  /**
   * PID 会被系统回收 —— 「这个号上有进程」不等于「隧道还活着」。
   *
   * cloudflared 死掉之后它的号可能已经属于别的进程。只探存在性的话：
   *   · baseUrl 继续用那个 trycloudflare 地址，而隧道早没了 →
   *     之后每个二维码、每条深链都指向打不开的域名，且没有任何报错
   *   · stopTunnel 会 kill 那个号 → 杀掉一个无辜进程
   *
   * 这两条都是这个文件上面那句「以进程是否存在为准」当初想解决的问题的
   * **第二种成因**，只看 kill(pid,0) 挡不住。
   */
  await t.test('pid 被别的进程占了（PID 复用）→ 不认，回落', () => {
    // 「号还在但换了主人」：命令行不是 cloudflared
    __setCommandOf(() => 'node /opt/clamicro/server.mjs')
    try {
      writeConfig({ publicBaseUrl: DEAD })
      writeFileSync(PID_FILE, String(process.pid))
      const un = silence()
      const c = loadConfig()
      un()
      assert.equal(c.tunnelUrl, null, '号被别人占着时不该采用隧道地址')
      assert.ok(!c.baseUrl.includes('trycloudflare'))
    } finally {
      try { unlinkSync(PID_FILE) } catch { /* 已经没了 */ }
    }
  })

  await t.test('ps 不可用（读不到命令行）→ 不认，回落', () => {
    // 模拟 ps 失败：commandOf 返回空串。tunnelAlive 必须 fail-closed——拿不准
    // 就不信任 PID，绝不能因为读不到命令行就反过来当成「是自己的隧道」
    __setCommandOf(() => '')
    try {
      writeConfig({ publicBaseUrl: DEAD })
      writeFileSync(PID_FILE, String(process.pid))
      const un = silence()
      const c = loadConfig()
      un()
      assert.equal(c.tunnelUrl, null, '读不到命令行时不该采用隧道地址')
      assert.ok(!c.baseUrl.includes('trycloudflare'))
    } finally {
      try { unlinkSync(PID_FILE) } catch { /* 已经没了 */ }
    }
  })

  await t.test('回落不修改盘上的 publicBaseUrl（读取不该有写副作用）', () => {
    writeConfig({ publicBaseUrl: DEAD })
    const un = silence()
    loadConfig()
    un()
    assert.equal(JSON.parse(readFileSync(CONFIG_FILE, 'utf8')).publicBaseUrl, DEAD)
  })
})

test('saveConfig 不把派生字段写回磁盘', () => {
  writeConfig({})
  const un = silence()
  const c = loadConfig()
  saveConfig(c)
  un()
  const disk = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
  for (const k of ['baseUrl', 'altUrl', 'lanIp', 'localHost', 'tailscaleIp', 'tunnelUrl', 'persistedPort']) {
    assert.ok(!(k in disk), `${k} 是每次启动重新探测的派生值，不该落盘`)
  }
})

test('废弃的 relay / push 配置会被清掉（里面装着凭证）', () => {
  writeConfig({
    relay: { enabled: true, notifyTopic: 'ccm-n-SECRET', commandTopic: 'ccm-c-SECRET' },
    push: { macNotify: false, provider: 'bark', bark: { server: 'https://api.day.app', key: 'SECRET-KEY' } },
  })
  const un = silence()
  const c = loadConfig()
  un()
  assert.ok(!('relay' in c), '内存里不该还有 relay')
  const disk = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
  assert.ok(!('relay' in disk), '盘上不该还有 relay')
  assert.ok(!JSON.stringify(disk).includes('SECRET'), 'topic 名是凭证，必须一起清掉')
  assert.ok(!('push' in disk), '废弃的 push 段该被清掉')
  assert.ok(!JSON.stringify(disk).includes('SECRET-KEY'), 'Bark key 是凭证，必须一起清掉')
  assert.equal(disk.notify.macNotify, false, 'macNotify 应被搬进 notify 段')
  assert.equal(disk.token.length, 43, '清理不得误伤 token')
})

test('CLAMICRO_PORT 是运行时覆盖，不固化到磁盘', () => {
  writeConfig({ port: 8765 })
  process.env.CLAMICRO_PORT = '9999'
  const un = silence()
  const c = loadConfig()
  saveConfig(c)
  un()
  delete process.env.CLAMICRO_PORT
  assert.equal(c.port, 9999, '本次运行用覆盖值')
  // 断言的是**行为**不是文件形状：saveConfig 只写和默认值不同的项，
  // 所以 port 等于默认时根本不落盘。真正要保证的是「下次不带环境变量启动，
  // 拿到的还是原来那个端口」，而不是「文件里有 port 这个键」。
  assert.equal(loadConfig().port, 8765, '下次启动仍是原端口，环境变量没被固化')
})

test('bind：自动探测占位符绝不能被固化成具体 IP', async (t) => {
  // 这一条对应查了两天的 bug。saveConfig 把 loadConfig 探测出的局域网 IP
  // 原样写回盘，换网络后那个地址不属于本机 → EADDRNOTAVAIL → 只剩回环。
  // 触发点是 `clamicro trust`：那条**专门用来开放局域网访问**的命令，
  // 跑一次就锁死了之后所有网络的绑定。而 status 一路显示「运行中 ✓ 已信任」。
  await t.test('saveConfig 把探测结果还原成 null 占位符', () => {
    writeConfig({ bind: ['127.0.0.1', null] })
    const un = silence()
    const c = loadConfig()
    saveConfig(c)
    un()
    // 同样测行为：bind 等于默认时整个键都不落盘（比写一份还安全），
    // 键在不在不重要，重要的是**盘上绝不能钉着一个具体的局域网地址**。
    const disk = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    const literals = (disk.bind ?? []).filter((h) => h && h !== '127.0.0.1')
    assert.equal(literals.length, 0, `不该有具体的局域网地址: ${JSON.stringify(literals)}`)
    assert.ok(loadConfig().bind.includes(null) || loadConfig().bind.some((h) => h), 'bind 仍可用')
  })

  await t.test('内存里仍然绑到真实地址（还原只影响落盘）', () => {
    writeConfig({ bind: ['127.0.0.1', null] })
    const un = silence()
    const c = loadConfig()
    un()
    assert.ok(c.bind.includes('127.0.0.1'))
    if (c.lanIp) assert.ok(c.bind.includes(c.lanIp), '本次运行要真的绑局域网 IP')
  })

  await t.test('自愈：盘上已经钉着的失效地址会被清掉', () => {
    // 换网络后的真实形态——旧网络的 IP 还留在盘上，本机已经没有这个地址
    writeConfig({ bind: ['127.0.0.1', '10.99.99.99'] })
    const un = silence()
    const c = loadConfig()
    un()
    assert.ok(!c.bind.includes('10.99.99.99'), '本机不存在的地址必须丢掉，否则 listen 会 EADDRNOTAVAIL')
    // 自愈之后 bind 回到默认形态，于是整个键都不落盘——这比写一份还干净。
    // 断言只能是「盘上没有那个失效地址」，不能是「盘上有个 bind 数组」。
    const disk = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    assert.ok(!JSON.stringify(disk.bind ?? []).includes('10.99.99.99'), '清理结果要落盘')
    assert.ok(loadConfig().bind.includes(null) || loadConfig().bind.length > 0,
      '下次启动仍能绑到新网络的地址')
  })

  await t.test('用户显式指定的本机地址予以保留', () => {
    writeConfig({ bind: ['127.0.0.1', null] })
    const un = silence()
    const c = loadConfig()
    un()
    // 本机确实拥有的地址不该被误删
    if (c.lanIp) {
      writeConfig({ bind: ['127.0.0.1', c.lanIp] })
      const un2 = silence()
      const c2 = loadConfig()
      un2()
      assert.ok(c2.bind.includes(c.lanIp), '本机真实拥有的地址要留着')
    }
  })
})

/**
 * 作用域写（saveConfig 的 only）。
 *
 * 修的是一个复现过的丢改动：每个短命 CLI 命令都是「启动读整份 → 干完整份写回」，
 * 服务那边也整份写回，两边撞上就是后写者赢。实测——终端里跑 trust 的同时手机上
 * 把高危等待时长改成 99 秒，CLI 写回后那个键被 pruneDefaults 当成默认值**剪掉**，
 * 99 秒连痕迹都不剩；而 approval.* 不在热加载里，跑着的服务内存里还是 99 秒，
 * 直到下一次重启才悄悄变回去。
 */
test('saveConfig 的作用域写', async (t) => {
  const { mkdtempSync, writeFileSync, readFileSync, mkdirSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const setup = (disk) => {
    const home = mkdtempSync(join(tmpdir(), 'clamicro-scoped-'))
    mkdirSync(join(home, '.claude', 'clamicro'), { recursive: true })
    writeFileSync(join(home, '.claude', 'clamicro', 'config.json'), JSON.stringify(disk))
    return home
  }
  const read = (home) => JSON.parse(readFileSync(join(home, '.claude', 'clamicro', 'config.json'), 'utf8'))

  await t.test('只改点名的那一项，别人改的原样留着', async () => {
    const home = setup({ token: 'tok', approval: { timeoutMs: 99000 } })
    const prev = process.env.HOME
    process.env.HOME = home
    try {
      const m = await import(`../src/config.mjs?scoped=${Math.random()}`)
      const cfg = m.loadConfig()
      // 模拟 CLI：拿到快照之后，别人（手机）把 timeoutMs 改成了 12345
      writeFileSync(join(home, '.claude', 'clamicro', 'config.json'),
        JSON.stringify({ token: 'tok', approval: { timeoutMs: 12345 } }))
      cfg.trustedNetworks = { net1: { label: '家里' } }
      m.saveConfig(cfg, { only: ['trustedNetworks'] })

      const out = read(home)
      assert.deepEqual(Object.keys(out.trustedNetworks), ['net1'], '自己那一项要写进去')
      assert.equal(out.approval?.timeoutMs, 12345, '别人刚改的不能被旧快照抹掉')
    } finally {
      process.env.HOME = prev
    }
  })

  await t.test('不带 only 就是整份写（老行为不变）', async () => {
    const home = setup({ token: 'tok', approval: { timeoutMs: 99000 } })
    const prev = process.env.HOME
    process.env.HOME = home
    try {
      const m = await import(`../src/config.mjs?whole=${Math.random()}`)
      const cfg = m.loadConfig()
      writeFileSync(join(home, '.claude', 'clamicro', 'config.json'),
        JSON.stringify({ token: 'tok', approval: { timeoutMs: 12345 } }))
      m.saveConfig(cfg)
      // 整份写就是会盖掉——这条不是「应该如此」，是把现状钉住：
      // 哪天想让它也不盖，得先想清楚整份写的语义
      assert.equal(read(home).approval?.timeoutMs, 99000)
    } finally {
      process.env.HOME = prev
    }
  })
})
