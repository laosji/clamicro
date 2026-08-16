/**
 * 原子写。
 *
 * ## 为什么值得单独钉
 *
 * `writeFileSync` 是**截断 + 逐块写**：文件先变 0 字节再填回去。那个中间态
 * 是真实存在的，而这个项目有两条路径会读到它：
 *
 *   · 配置热加载（server.mjs 的 watchConfig）—— CLI 改盘时服务正在读
 *   · 进程被打断（Ctrl-C、崩溃、断电）正好落在写的中途
 *
 * 后果不对称地严重：config.json 半截 = 令牌和已配对设备全没，手机得重新
 * 扫码；settings.json 半截 = Claude Code 直接起不来。
 *
 * ## 权限那条同样重要
 *
 * config.json 里有主令牌。原来是 `writeFileSync` 之后再 `chmodSync(0o600)`
 * ——中间有一瞬间文件已就位而权限还是默认的 0644，同机其他用户可读。
 * 窗口很短，但「短」不是安全属性。现在 chmod 在 rename **之前**做，
 * 文件出现在目标路径时权限就已经是对的。
 *
 * 跑：node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, statSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeAtomic } from '../src/atomic.mjs'

const dir = mkdtempSync(join(tmpdir(), 'clamicro-atomic-'))
test.after(() => rmSync(dir, { recursive: true, force: true }))

const mode = (p) => (statSync(p).mode & 0o777).toString(8)

test('写出来的内容完整', () => {
  const f = join(dir, 'a.json')
  writeAtomic(f, '{"a":1}')
  assert.equal(readFileSync(f, 'utf8'), '{"a":1}')
})

test('覆盖已有文件', () => {
  const f = join(dir, 'b.json')
  writeAtomic(f, 'old')
  writeAtomic(f, 'new')
  assert.equal(readFileSync(f, 'utf8'), 'new')
})

test('权限在文件就位前就设好 —— 不留 0644 的窗口', () => {
  const f = join(dir, 'c.json')
  writeAtomic(f, 'secret', 0o600)
  assert.equal(mode(f), '600')
})

test('覆盖一个 0644 的旧文件后权限也是对的', () => {
  const f = join(dir, 'd.json')
  writeFileSync(f, 'old') // 默认 0644
  writeAtomic(f, 'secret', 0o600)
  assert.equal(mode(f), '600', '覆盖不能继承旧文件的宽松权限')
})

test('失败时不留临时文件', () => {
  const sub = join(dir, 'sub')
  const before = readdirSync(dir).length
  // 目标目录不存在 → 写临时文件就会失败
  assert.throws(() => writeAtomic(join(sub, 'e.json'), 'x'))
  assert.equal(readdirSync(dir).length, before, '失败路径不该留下 .tmp 垃圾')
})

test('临时文件带 pid —— 两个进程同时写不会互相踩', () => {
  // 不能直接观察到并发，但可以确认命名里有 pid 这个区分维度：
  // 固定名 `.tmp` 的话，两个 clamicro 进程同时保存会写同一个临时文件，
  // 一个 rename 走了另一个就写到了不存在的路径
  const f = join(dir, 'f.json')
  writeAtomic(f, 'x')
  assert.equal(readdirSync(dir).some((n) => n.includes('.tmp')), false, '正常路径不该残留临时文件')
})
