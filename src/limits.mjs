/**
 * 从 Claude Code 那边继承来的硬约束。
 *
 * 独立成模块是因为这几个数**不是我们的选择，是外部事实**，而且同一个事实
 * 原来被三处各自写了一遍：approvals.mjs 的 SELF_TIMEOUT_MS、config.mjs 的
 * MAX_APPROVAL_TIMEOUT_MS、control.mjs 的 MAX_HOLD_MS——三个名字、三段注释，
 * 说的都是「hook 的系统超时是 600 秒」。
 *
 * 哪天 Claude Code 改了那个超时，得同时找到三处才不出错；漏一处的后果不是
 * 报错，是**审批静默失效**——那正是这个项目最不愿意有的失败形态。
 */

/**
 * hook 的系统超时。
 *
 * 走到这一步，Claude Code 会把它当成**非阻塞错误**放行到正常的权限流程——
 * 等于这次审批白做，而且没有任何报错：人不在电脑边时，终端会空挂在那里
 * 等一个没人看的弹框。
 */
export const HOOK_SYSTEM_TIMEOUT_MS = 600_000

/**
 * 我们自己必须先结掉的时限。留 30 秒余量给网络和进程调度。
 *
 * 三个地方用它，含义各不相同但边界同源：
 *   · 审批等待多久后自动决定（approvals）
 *   · 设置页 / API 写入时夹住用户填的值（config）
 *   · Pause 最多能把一次工具调用挂多久（control）
 */
export const SELF_DEADLINE_MS = HOOK_SYSTEM_TIMEOUT_MS - 30_000
