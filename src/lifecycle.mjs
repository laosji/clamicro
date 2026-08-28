/**
 * 「所有后端都退出了，服务也该走了」。
 *
 * ## 判据为什么不是「没有会话了」
 *
 * 会话只在 `session-end` 时才从表里消失，而 kill -9、直接关终端窗口、进程
 * 崩溃都**不发那个事件**（server.mjs 里 sweepStale 那段注释记的就是这件事）。
 * 所以「会话数为零」和「没人在用」根本不是一回事，而且错的方向最难受：
 * 硬退出留下的会话永远赖在表里，服务于是永远不退。
 *
 * ## 也不是「按名字搜进程」
 *
 * 这条更危险，而且这个仓库已经为此栽过一次——service-id.mjs 的结论是
 * 「命令行只用来**验证一个已知 PID**，不用来查找进程」。实测也支持：
 * Claude Code 的可执行文件路径带版本号
 * （`.../claude-code/2.1.246/claude.app/Contents/MacOS/claude`），
 * 而它至少有桌面 App / 终端 / VS Code 三种形态。漏认一个还活着的会话就会
 * 把服务关掉，之后 hook 全部失败、审批静默失效，而用户完全不会把两件事
 * 联系起来。
 *
 * ## 用的是宿主自报的 PID
 *
 * session-start 那一刻 hook 脚本把 `$PPID` 带上来（bin/session-start.sh）。
 * 实测过 `$PPID` 就是 agent 本身，中间没有 shell。判活是 `kill(pid, 0)`——
 * 没有模式匹配、没有版本路径。
 *
 * **形状因后端而异，这一点决定了它只能用来做这一件事：** Claude Code 是
 * 一个会话一个进程，而 Codex 的 app-server、DSH 的主进程是所有会话共用的
 * 常驻进程。所以它回答的是「这个后端还开着吗」，不是「这个会话还活着吗」。
 *
 * ## 不确定就不退
 *
 * 关错的代价（审批静默失效）远大于多跑一会儿的代价（一个闲置的 node 进程）。
 * 所以下面每一条「拦住」都是有意偏保守的，尤其是「有会话但不知道宿主是谁」
 * ——那是升级期的老会话，宁可让它把服务钉住。
 */

/** 进程还在吗。signal 0 不发信号，只做存在性和权限检查。 */
export function alive(pid, kill = process.kill.bind(process)) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    kill(pid, 0)
    return true
  } catch (err) {
    // EPERM = 进程在，只是不属于我们。判活而言它就是活的
    return err?.code === 'EPERM'
  }
}

/**
 * 现在该退出吗，以及为什么。
 *
 * 返回 `{ exit, why }`。why 是给日志的：**关停必须留下理由**，否则用户下次
 * 发现服务不在了，手上只有一个消失的进程和零条线索。
 *
 * @param sessions   store.sessions()
 * @param opts.owners  store.owners() —— 见过的宿主，**会话结束了也还在表里**。
 *   这是「所有应用退出后关服务」的字面判据：Claude Code 开着但当前没有会话时
 *   服务不该走。只看当前会话的话，一个正常结束的会话就会让服务十分钟后退出，
 *   而那时应用还开着。
 * @param opts.pendingApprovals 待审批条数
 * @param opts.foreground       前台启动（`clamicro start`）
 * @param opts.staleMs          「没有宿主信息的老会话」多久之后不再算数
 * @param opts.now              注入时钟，测试用
 */
export function shouldExit(sessions, {
  owners = [],
  pendingApprovals = 0,
  foreground = false,
  staleMs = 30 * 60_000,
  now = Date.now(),
  isAlive = alive,
} = {}) {
  /**
   * 前台启动的不退。那是用户明确要它跑着——他盯着这个终端窗口，
   * 而窗口里的进程自己消失是最莫名其妙的一种行为。
   */
  if (foreground) return { exit: false, why: 'foreground' }

  /**
   * 有待审批就不退，一条都不行。
   *
   * 服务一走，手机上那张卡片永远挂着；而 Codex 那边拿不到回包会当作
   * 「本 hook 无意见」放行（见 bin/codex-hook.sh 的第 1 条纪律）——
   * 一次本该被拦下的操作就这么过去了。这是这个产品最不能出的错。
   */
  if (pendingApprovals > 0) return { exit: false, why: 'pending-approvals' }

  // 见过的宿主里只要还有一个活着，就说明那个应用还开着
  for (const o of owners) {
    if (isAlive(o.pid)) return { exit: false, why: 'owner-alive' }
  }

  let known = owners.length
  for (const s of sessions) {
    // 会话自带的那份宿主已经在 owners 里查过了，这里只管「没有宿主信息」的
    if (Number.isInteger(s.owner_pid) && s.owner_pid > 0) {
      known++
      continue
    }
    /**
     * 会话在、但不知道宿主是谁。两种来源：升级前建立的会话，或者哪天
     * 有人从别处直接 POST /hooks/session-start。
     *
     * 新鲜的一律拦住——不知道就别关。但**不能永远拦**：一个 kill -9 留下的
     * 老会话没有 session-end、也没有宿主信息，那样服务会被它钉死到重启。
     * 所以过了陈旧线就不再算数，交给下面的判断。
     */
    if (now - (s.updated_at ?? 0) < staleMs) return { exit: false, why: 'unknown-owner' }
  }

  /**
   * 到这里：没有任何活着的宿主，也没有新鲜的未知会话。
   *
   * ## 一无所知**不等于**没人在用
   *
   * `known === 0` 的意思是「我什么都不知道」，不是「我确认过没人」。原来这
   * 两种一起走 exit:true，而这**跟这个文件开头写的原则正好相反**——那里说的
   * 是「不确定就不退」。
   *
   * 真机上当场就撞了，日志留着：
   *
   *     14:44:03 [clamicro] 监听 http://127.0.0.1:8765     ← 服务重启
   *     14:49:03 [lifecycle] 没有后端在用了（no-owner-known），再确认一次就退出
   *     14:54:03 [lifecycle] 所有后端都退出了，服务关闭
   *
   * 而那台机器上 Claude Code 一直开着、正在干活。
   *
   * ## 触发路径
   *
   * 会话表和 `#owners` **都不落盘**（有意的，见下），所以服务因为任何原因
   * 重启之后，它对「谁在用」一无所知。而 `SessionStart` 一个会话只发一次,
   * 早就过去了、不会再来。于是只要接下来十分钟没有 hook 到达——用户在读代码、
   * 在想事情、在开会——服务就自己走了。
   *
   * 上面那道 `unknown-owner` 拦不住：它要求**会话记录存在**，而重启后那张表
   * 是空的。
   *
   * ## 代价不对等，所以只往一边偏
   *
   * 服务一走，九个 hook 全部连不上。而 hook 失败会被当成**非阻塞错误**——
   * `PermissionRequest` 不再阻塞，本该上手机等人批的操作直接跑过去，手机上
   * 什么都不显示，终端里也没有报错。这正是本文件开头那句「审批静默失效，
   * 而用户完全不会把两件事联系起来」。
   *
   * 另一边的代价是一个闲置的 node 进程。
   *
   * ## 为什么不把 owners 落盘
   *
   * 想过，不做。**盘上的 pid 跨重启就没有意义了**——PID 会被系统回收，
   * 这个仓库已经为此栽过两次（service-id.mjs 的 stop、config.mjs 的
   * tunnelAlive，两处都写着「PID 本身从来不足以标识一个进程」）。存下来的
   * pid 在下次开机后可能指向一个毫不相干的进程。
   *
   * 而且它救不了什么：重启后服务收到一条 statusLine 或 SessionStart 就重新
   * 认识了宿主（见 bin/statusline.sh 的 `owner=`）。
   *
   * **但那两条都不保证会来。** SessionStart 一个会话只发一次，重启前发过的
   * 不会再发；statusLine 只在 Claude Code 真的渲染状态栏时才跑，**某些环境下
   * 压根不调**（实测：服务重启后跑了十几分钟、收了一堆 hook，
   * `statusLineSeenAt` 仍是重启前恢复出来的旧值，owners 一直是 0）。
   *
   * 所以重启之后，已经开着的那些会话的宿主**可能永远补不上**——auto-exit
   * 要等到下一个新会话才重新有依据。这不是缺陷，是这里唯一能接受的失败
   * 方向：不知道就不退。上面 `known === 0` 那条兜的正是它。
   *
   * 想靠「从 socket 反查对端 pid」把它补上——**不做**。这个仓库为
   * 「PID 本身不足以标识一个进程」栽过两次（service-id.mjs、config.mjs），
   * 而认错一个 pid 的后果是 owner-alive 永远为真、功能静默失效。
   */
  if (!known) return { exit: false, why: 'no-owner-known' }
  return { exit: true, why: 'all-owners-gone' }
}
