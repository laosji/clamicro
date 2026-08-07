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

const { loadConfig, saveConfig } = await import('../lib/config.mjs')

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

  await t.test('pid 指向存活进程 → 采用隧道地址', () => {
    writeConfig({ publicBaseUrl: DEAD })
    writeFileSync(PID_FILE, String(process.pid))
    const un = silence()
    const c = loadConfig()
    un()
    assert.equal(c.tunnelUrl, DEAD)
    assert.equal(c.baseUrl, DEAD)
    unlinkSync(PID_FILE)
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

test('废弃的 relay 配置会被清掉（topic 名是凭证）', () => {
  writeConfig({
    relay: { enabled: true, notifyTopic: 'ccm-n-SECRET', commandTopic: 'ccm-c-SECRET' },
    push: { macNotify: true, provider: 'bark', bark: { server: 'https://api.day.app', key: 'KEEPME' } },
  })
  const un = silence()
  const c = loadConfig()
  un()
  assert.ok(!('relay' in c), '内存里不该还有 relay')
  const disk = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
  assert.ok(!('relay' in disk), '盘上不该还有 relay')
  assert.ok(!JSON.stringify(disk).includes('SECRET'), 'topic 名是凭证，必须一起清掉')
  assert.equal(disk.push.bark.key, 'KEEPME', '清理不得误伤 Bark key')
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
  assert.equal(JSON.parse(readFileSync(CONFIG_FILE, 'utf8')).port, 8765, '盘上保持原值')
})
