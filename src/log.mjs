/**
 * 给日志加时间戳。
 *
 * ## 为什么需要
 *
 * 服务日志一度是 2836 行、**一个时间戳都没有**。排查一条
 * `[http] POST /api/pair: notify is not a function` 时，能确定的只有「它出现在
 * 某次 `[clamicro] 退出` 之前」——是哪天、离现在多久、和前一条隔了多长时间，
 * 一概答不出来。而事故分析里这几个问题往往就是全部。
 *
 * ## 只给常驻服务加，不给 CLI 加
 *
 * `clamicro qr` 这类命令是**借 server.mjs 跑一次性查询**（见 ONE_SHOT），它们
 * 的输出是给人看的终端内容——二维码、状态表格。给那些行挨个加前缀会把二维码
 * 直接毁掉。所以装钩子的地方要判 ONE_SHOT。
 *
 * ## 为什么是本地时间、精确到秒
 *
 * 这是一台 Mac 上的个人工具，你对照的是「我当时在不在电脑前」，不是 UTC。
 * 精确到秒够用：需要毫秒级的地方（审批从创建到决策隔了多久）在
 * history.json 里有原始 epoch，不靠日志文本还原。
 *
 * 短格式（`08-13 19:45:12`）而不是完整 ISO：日志主要是人 `tail` 着看的，
 * 前缀越短，真正的消息越靠左、越好扫。
 */

const pad = (n) => String(n).padStart(2, '0')

export function stamp(d = new Date()) {
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

let installed = false

/**
 * 把 console.log / warn / error 包一层，每行前面加时间戳。
 *
 * 幂等：装两次不会加两个前缀。
 * 返回一个还原函数，测试用完要能恢复，否则会污染同进程里后面的用例。
 */
export function stampConsole(console_ = console, now = () => new Date()) {
  if (installed) return () => {}
  installed = true
  const orig = {}
  for (const level of ['log', 'warn', 'error']) {
    orig[level] = console_[level].bind(console_)
    console_[level] = (...args) => orig[level](stamp(now()), ...args)
  }
  return () => {
    for (const level of ['log', 'warn', 'error']) console_[level] = orig[level]
    installed = false
  }
}
