/**
 * 自排除目录的匹配边界。
 *
 * 原来是裸 `cwd.startsWith(d)`。排除 `/Users/me/proj` 会把
 * `/Users/me/project-x` 也一起吞掉，而被吞掉的项目**一条工具调用都不再
 * 走审批**——hook 返回 {} 就是「无意见」，直接落回 Claude Code 自己的
 * 权限流程。你以为在盯着它，其实没有，且没有任何提示。
 *
 * 这是这个项目最忌讳的形态：静默地少做一件安全相关的事。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { underIgnored } from '../src/routes/hooks.mjs'

const IGN = ['/Users/me/proj']

test('自排除只在真正的子路径上生效', async (t) => {
  await t.test('目录自身', () => {
    assert.equal(underIgnored('/Users/me/proj', IGN), true)
  })

  await t.test('子目录', () => {
    assert.equal(underIgnored('/Users/me/proj/src/routes', IGN), true)
  })

  await t.test('同前缀的**另一个项目**不该被吞掉', () => {
    for (const cwd of ['/Users/me/project-x', '/Users/me/proj-backup', '/Users/me/projX']) {
      assert.equal(underIgnored(cwd, IGN), false, `${cwd} 被误判为自排除，它的审批会被静默跳过`)
    }
  })

  await t.test('配置里带尾斜杠也要能对上', () => {
    assert.equal(underIgnored('/Users/me/proj/src', ['/Users/me/proj/']), true)
    assert.equal(underIgnored('/Users/me/project-x', ['/Users/me/proj/']), false)
  })

  await t.test('父目录不算', () => {
    assert.equal(underIgnored('/Users/me', IGN), false)
  })
})

test('脏输入一律按「不排除」处理', async (t) => {
  // 拿不准的时候要走审批，不是跳过审批
  await t.test('cwd 缺失', () => {
    for (const cwd of [undefined, null, '', 123, {}]) assert.equal(underIgnored(cwd, IGN), false)
  })

  await t.test('列表缺失或含脏项', () => {
    assert.equal(underIgnored('/Users/me/proj', undefined), false)
    assert.equal(underIgnored('/Users/me/proj', ['', null, 0]), false)
  })

  await t.test('空字符串条目不能变成「匹配一切」', () => {
    // '' 做前缀能匹配任何路径——那等于整台机器都不走审批了
    assert.equal(underIgnored('/anything/at/all', ['']), false)
  })
})
