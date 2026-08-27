/**
 * 局域网暴露面的开关。
 *
 * ## 为什么这个文件必须存在
 *
 * 这段逻辑原来内联在 server.mjs 里，**测不了**：判据是 `detectLanIp()`
 * （读 os.networkInterfaces）和 `fingerprint()`（spawn route/arp/ipconfig），
 * 前者连换 PATH 都伪造不了。代价是实打实的——它出过两个 bug，两个都只有
 * 代码审查发现，一条测试都没红：
 *
 *   · **收缩收错了对象**：关的是 `config.lanIp`（启动那一刻探到的值），
 *     而换过一次 IP 之后还活着的套接字已经不是它了。于是关掉一个早就没用
 *     的旧 socket，新地址上的监听原样留着，日志和通知却说「已摘掉局域网
 *     监听」——**界面说的和事实相反，方向还偏向不安全那侧**。
 *   · **白名单没跟上**：ALLOWED_HOSTS 启动时算死。于是「已恢复局域网监听」
 *     之后手机连过来 Host 对不上，一律 403。日志说恢复了，实际连不上。
 *
 * 所以这里钉的不是「函数返回什么」，是**每次转移之后，「真的在听哪个地址」
 * 和「白名单认哪个地址」这两件事对不对得上**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLanGate } from '../src/lanbind.mjs'

const PORT = 8765

/**
 * 一个假的世界：网络可以随时改，监听和白名单都看得见。
 *
 * 真实实现里这两样一个在 http.Server、一个在 handler 的闭包里，谁也摸不着。
 */
function world({ ip = '10.0.0.5', netId = 'home', trusted = ['home'], startTrusted = true } = {}) {
  const now = { ip, netId }
  const listening = new Set()
  let allowed = new Set()
  const notes = []
  const config = {
    port: PORT, lanIp: ip, localHost: 'MyMac.local',
    tailscaleIp: null, tunnelUrl: null,
    bind: ['127.0.0.1', ip],
  }
  const gate = createLanGate({
    config,
    listenOn: (h) => listening.add(h),
    stopListening: (h) => listening.delete(h),
    applyAllowedHosts: (s) => { allowed = s },
    detectLanIp: () => now.ip,
    fingerprint: () => ({ id: now.netId, label: now.netId }),
    isTrusted: (_cfg, fp) => trusted.includes(fp.id),
    notify: async (m) => { notes.push(m) },
    log: () => {}, warn: () => {},
  })

  // 启动：回环永远听着；局域网那个只在信任时听
  listening.add('127.0.0.1')
  const bindHosts = startTrusted ? config.bind : ['127.0.0.1']
  if (startTrusted) listening.add(ip)
  gate.start({ lanIp: ip, netId, bindHosts })

  return {
    gate, config, notes, now,
    listening: () => [...listening].sort(),
    /** 白名单认不认这个 Host（带不带端口都试一遍） */
    allows: (h) => allowed.has(h.toLowerCase()) || allowed.has(`${h.toLowerCase()}:${PORT}`),
    /** 换个网络 */
    moveTo: (netId, ip) => { now.netId = netId; if (ip !== undefined) now.ip = ip },
  }
}

// ---------------------------------------------------------------------------
test('换到另一个已信任网络、而且换了 IP', async (t) => {
  const w = world({ trusted: ['home', 'office'] })
  w.moveTo('office', '192.168.1.7')
  const r = w.gate.onNetworkChange()

  await t.test('新地址开始监听', () => {
    assert.equal(r, 'moved')
    assert.deepEqual(w.listening(), ['127.0.0.1', '192.168.1.7'])
  })

  /**
   * 旧地址上的套接字必须真的关掉。留着它的话，后面一旦换到不可信网络，
   * 收缩会去关一个「已经不在监听的地址」而放过真正开着的那个。
   */
  await t.test('旧地址不再监听', () => {
    assert.ok(!w.listening().includes('10.0.0.5'), '旧 socket 没关')
  })

  /**
   * **白名单必须跟着换**，否则上面那条「已恢复局域网监听」是画出来的：
   * 手机连过来 Host 是新 IP，hostAllowed 里只有旧的，一律 403 bad host。
   */
  await t.test('白名单认新地址', () => {
    assert.equal(w.allows('192.168.1.7'), true, '新地址不在白名单里 —— 监听是画的')
  })
  await t.test('白名单不再认旧地址', () => {
    // 那个地址上已经没有监听了，留在白名单里只是一条和事实对不上的记录
    assert.equal(w.allows('10.0.0.5'), false)
  })
  await t.test('回环和本机名一直都在', () => {
    assert.equal(w.allows('127.0.0.1'), true)
    assert.equal(w.allows('mymac.local'), true)
  })
})

/**
 * 这一组是那两个 bug 的正脸。
 *
 * 序列：家里（信任，10.0.0.5）→ 公司（信任，**换了 IP** 192.168.1.7）
 *      → 咖啡厅（不信任）
 *
 * 老代码在最后一步会 `stopListening(config.lanIp)` = 关 10.0.0.5，
 * 而那个早就关了；真正开着的 192.168.1.7 原样留着，人就暴露在咖啡厅的
 * 网络上，而日志和通知都写着「已摘掉局域网监听」。
 */
test('换过 IP 之后再进不可信网络 —— 收缩必须收对', async (t) => {
  // home 和 office 都信任，cafe 不信任
  const w = world({ trusted: ['home', 'office'] })
  w.moveTo('office', '192.168.1.7')
  w.gate.onNetworkChange()
  assert.deepEqual(w.listening(), ['127.0.0.1', '192.168.1.7'], '前置条件')

  w.moveTo('cafe', '172.16.0.9')
  const r = w.gate.onNetworkChange()

  await t.test('局域网监听真的没了，只剩回环', () => {
    assert.equal(r, 'shrunk')
    assert.deepEqual(w.listening(), ['127.0.0.1'],
      '还在监听局域网地址 —— 而通知已经告诉用户「已关闭」了')
  })
  await t.test('白名单里一个局域网地址都不剩', () => {
    for (const h of ['192.168.1.7', '10.0.0.5', '172.16.0.9']) {
      assert.equal(w.allows(h), false, `${h} 还在白名单里`)
    }
    assert.equal(w.allows('127.0.0.1'), true, '回环不该被牵连')
  })
  await t.test('发了一条通知 —— 这件事必须让人知道', () => {
    assert.equal(w.notes.length, 1)
    assert.match(w.notes[0].subtitle, /收缩/)
    assert.match(w.notes[0].body, /cafe/)
  })
})

test('不可信网络：本来就没暴露就别喊', async (t) => {
  const w = world({ startTrusted: false, trusted: [] })
  w.moveTo('cafe', '172.16.0.9')
  const r = w.gate.onNetworkChange()
  await t.test('返回 already-shrunk', () => assert.equal(r, 'already-shrunk'))
  await t.test('不发通知', () => {
    // 「已关闭局域网访问」对一个从来没开过的人是句废话，而且会让他
    // 以为刚刚发生了什么
    assert.equal(w.notes.length, 0)
  })
  await t.test('回环不受影响', () => assert.deepEqual(w.listening(), ['127.0.0.1']))
})

/**
 * 恢复必须和收缩**对称**。
 *
 * 以前这条分支只打日志：任何一次误判（哪怕下一秒就纠正）都会让局域网监听
 * 永久消失到进程重启为止，日志里「未被信任」「已信任」反复横跳，而实际状态
 * 一路单向退化成只剩回环。只有一半的策略不是保守，是坏掉。
 */
test('换回已信任的网络要真的把监听装回去', async (t) => {
  const w = world({ trusted: ['home'] })
  w.moveTo('cafe', '172.16.0.9')
  w.gate.onNetworkChange()
  assert.deepEqual(w.listening(), ['127.0.0.1'], '前置条件：已收缩')

  w.moveTo('home', '10.0.0.5')
  const r = w.gate.onNetworkChange()
  await t.test('监听回来了', () => {
    assert.equal(r, 'restored')
    assert.deepEqual(w.listening(), ['10.0.0.5', '127.0.0.1'])
  })
  await t.test('白名单也回来了', () => {
    assert.equal(w.allows('10.0.0.5'), true, '监听回来了但白名单没有 —— 还是连不上')
  })
})

/**
 * **拿不到网关 ≠ 换到了陌生网络。**
 *
 * 全隧道 VPN 周期性重连、Wi-Fi 抖一下，fingerprint 就会返回 id: null。
 * 老代码把它当成「一个不认识的新网络」而摘掉监听——手机当场连不上，
 * 而 `clamicro networks` 还显示当前网络已信任，看不出任何异常。
 */
test('信息缺失时什么都不做', async (t) => {
  await t.test('指纹算不出来（未联网 / VPN 抖动）→ 不动', () => {
    const w = world()
    w.moveTo(null, null)
    assert.equal(w.gate.onNetworkChange(), 'unknown')
    assert.deepEqual(w.listening(), ['10.0.0.5', '127.0.0.1'], '证据不足就收缩了')
    assert.equal(w.notes.length, 0)
  })

  await t.test('同一个网络重复来事件 → 不动', () => {
    const w = world()
    assert.equal(w.gate.onNetworkChange(), 'same')
    assert.deepEqual(w.listening(), ['10.0.0.5', '127.0.0.1'])
  })

  await t.test('换了网络但 IP 没变（192.168.1.x 到处都是）→ 仍然按新网络判', () => {
    // 这正是 netwatch 存在的理由：IP 没变所以套接字还有效，
    // 光靠「地址失效」是发现不了的
    const w = world({ trusted: ['home'] })
    w.moveTo('cafe') // ip 不变
    assert.equal(w.gate.onNetworkChange(), 'shrunk')
    assert.deepEqual(w.listening(), ['127.0.0.1'])
  })
})

test('通知失败不许拖垮整个转移', () => {
  const listening = new Set(['10.0.0.5', '127.0.0.1'])
  const config = { port: PORT, lanIp: '10.0.0.5', localHost: null, tailscaleIp: null, tunnelUrl: null, bind: [] }
  const gate = createLanGate({
    config,
    listenOn: (h) => listening.add(h),
    stopListening: (h) => listening.delete(h),
    applyAllowedHosts: () => {},
    detectLanIp: () => '10.0.0.5',
    fingerprint: () => ({ id: 'cafe', label: 'cafe' }),
    isTrusted: () => false,
    notify: () => Promise.reject(new Error('osascript 没了')),
    log: () => {}, warn: () => {},
  })
  gate.start({ lanIp: '10.0.0.5', netId: 'home', bindHosts: ['10.0.0.5', '127.0.0.1'] })
  // 收缩是安全动作，绝不能因为一条装饰性提醒发不出去就没做成
  assert.doesNotThrow(() => gate.onNetworkChange())
  assert.deepEqual([...listening].sort(), ['127.0.0.1'])
})

test('start：未信任启动时 bound 是 null，不是那个没在听的 IP', () => {
  // 记错的话，第一次网络变化会去 stopListening 一个从没开过的地址，
  // 而 wasExposed 会误报 true —— 用户收到一条「已关闭局域网访问」，
  // 而它从来就没开过
  const w = world({ startTrusted: false, trusted: [] })
  assert.equal(w.gate.bound(), null)
})
