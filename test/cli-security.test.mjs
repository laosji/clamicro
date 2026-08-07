/**
 * 两个安全相关的 CLI 命令：撤销信任、轮换令牌。
 *
 * 它们补的是同一类缺口——**只有增，没有减**：
 *   · trust 能加信任网络，之前没有任何办法去掉。而 trust 在安装流程里就会
 *     问一次，咖啡厅手滑点「是」，那个网络就永久留在列表里
 *   · 令牌泄露（二维码被拍、局域网嗅探、截图误发）之后没有补救手段，
 *     只能手工编辑 config.json 再重装
 *
 * 令牌是 bearer 凭证：拿到它 = 能批准任意操作。这两条不是锦上添花。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = mkdtempSync(join(tmpdir(), 'clamicro-cli-'))
mkdirSync(join(HOME, '.claude', 'clamicro'), { recursive: true })
const CONFIG = join(HOME, '.claude', 'clamicro', 'config.json')

const run = (...args) =>
  spawnSync(process.execPath, [join(ROOT, 'server.mjs'), ...args], {
    env: { ...process.env, HOME },
    encoding: 'utf8',
  })
const write = (o) => writeFileSync(CONFIG, JSON.stringify({ token: 't'.repeat(43), ...o }, null, 2))
const read = () => JSON.parse(readFileSync(CONFIG, 'utf8'))

const NETS = {
  aaaa1111bbbb2222: { label: '网关 10.0.0.1', gateway: '10.0.0.1', subnet: '10.0.0', addedAt: 1 },
  cccc3333dddd4444: { label: '网关 192.168.1.1', gateway: '192.168.1.1', subnet: '192.168.1', addedAt: 2 },
}

test.after(() => rmSync(HOME, { recursive: true, force: true }))

test('untrust：撤销指定的网络', async (t) => {
  await t.test('按 id 前缀撤销一个', () => {
    write({ trustedNetworks: { ...NETS } })
    const r = run('--untrust=aaaa1111')
    assert.equal(r.status, 0, r.stdout + r.stderr)
    const left = Object.keys(read().trustedNetworks)
    assert.deepEqual(left, ['cccc3333dddd4444'], '只该删掉匹配的那一个')
  })

  await t.test('all 清空整个列表', () => {
    write({ trustedNetworks: { ...NETS } })
    assert.equal(run('--untrust=all').status, 0)
    assert.deepEqual(read().trustedNetworks, {})
  })

  await t.test('对不上的 id → 非零退出，且不动配置', () => {
    write({ trustedNetworks: { ...NETS } })
    const before = readFileSync(CONFIG, 'utf8')
    const r = run('--untrust=nosuchid')
    assert.notEqual(r.status, 0, '没删掉东西就不该报成功')
    assert.equal(readFileSync(CONFIG, 'utf8'), before, '失败时不得写盘')
  })

  await t.test('撤销不误伤其他配置', () => {
    write({ trustedNetworks: { ...NETS }, hostMode: 'ip', notify: { macNotify: false } })
    run('--untrust=all')
    const c = read()
    assert.equal(c.hostMode, 'ip')
    assert.equal(c.notify.macNotify, false)
    assert.equal(c.token.length, 43, '不得误伤令牌')
  })
})

test('rotate-token：换发令牌', async (t) => {
  await t.test('令牌确实变了，且长度足够', () => {
    write({})
    const before = read().token
    assert.equal(run('--rotate-token').status, 0)
    const after = read().token
    assert.notEqual(after, before, '令牌必须变')
    // 32 字节 base64url ≈ 43 字符
    assert.ok(after.length >= 43, `新令牌太短: ${after.length}`)
  })

  await t.test('两次轮换不会得到相同的值', () => {
    write({})
    run('--rotate-token')
    const a = read().token
    run('--rotate-token')
    assert.notEqual(read().token, a)
  })

  await t.test('不误伤其他配置（信任网络、设置都要留着）', () => {
    write({ trustedNetworks: { ...NETS }, hostMode: 'hostname' })
    run('--rotate-token')
    const c = read()
    assert.equal(Object.keys(c.trustedNetworks).length, 2, '轮换令牌不该动信任列表')
    assert.equal(c.hostMode, 'hostname')
  })
})
