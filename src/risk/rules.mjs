/**
 * 风险规则表 —— 纯数据，不含逻辑。判定逻辑在 ./assess.mjs。
 *
 * 这是整个产品的安全核心：用户之所以敢让 Claude Code 跑命令，
 * 靠的就是这里能把「需要你亲自看一眼」的操作挑出来。挑漏了，
 * 高危操作会在 10 秒后自动放行；标错了，用户会照着错标签签字。
 *
 * ## 这套规则做不到什么
 *
 * 它是**启发式，不是沙箱**。任何混淆都能绕过：
 *
 *     eval $(echo 'cm0gLXJmIC8=' | base64 -d)
 *     r''m -rf /
 *     $(printf '\x72\x6d') -rf /
 *
 * 这是正则方案的固有上限，不打算修——真正的防线是**人看到了命令原文**。
 * 所以 UI 必须保证命令本身可见（见 approval.html 里命令优先于描述的排版），
 * 规则表只负责「把该看的挑出来、别说反话」。
 *
 * ## 加规则时的两条原则
 *
 * 1. **宁可误报，不可漏报。** 误报的代价是多等你一下；漏报的代价是
 *    `rm -rf` 在你没看手机时自动放行。
 * 2. **长短参数要成对。** `rm -rf` 和 `rm --recursive --force` 是同一件事，
 *    只写一个等于留了个后门。曾经就是这样漏掉的。
 */

/**
 * 词首断言：要求这个词前面不是词字符、点或横线。
 *
 * 这解决的是 `cat ~/.ssh/id_rsa` 里的 `.ssh` 被当成 ssh 命令的问题——
 * 它的形状是「词被粘在路径里」，不是「词不在命令位置」。
 *
 * 一开始我按「命令位置」（行首/管道/分号之后）来锚，结果开了个更大的洞：
 *     env rm -rf /        判普通风险，还标成「只读」
 *     xargs rm -rf /      同上
 *     time / nohup / sudo -u x  都能这样垫一层
 * 因为 rm 前面垫任何一个词就不在命令位置了。宁可误报不可漏报——
 * 只排除「粘在标识符里」这一种情况，不要求命令位置。
 */
const W = String.raw`(?<![\w.-])`

/** 短横线参数，长短形式都认。传入短标志字符和长标志名 */
const flag = (short, long) => String.raw`(?:-\w*[${short}]\w*|--(?:${long}))`

export const HIGH_RISK_BASH = [
  {
    // rm -rf / rm -r -f / rm --recursive --force / rm -fR / env rm -rf / xargs rm -rf …
    re: new RegExp(String.raw`${W}rm\s+(?:${flag('rf', 'recursive|force|dir')}\s+)+`),
    why: '递归/强制删除',
  },
  {
    // find … -delete 和 find … -exec rm
    re: /\bfind\b[^|;]*(-delete\b|-exec\s+(sudo\s+)?rm\b)/,
    why: '批量删除文件',
  },
  { re: /\b(shred|srm)\b/, why: '不可恢复地擦除' },
  { re: /\btruncate\s+-s\s*0\b/, why: '清空文件内容' },
  {
    // --force / -f / 以及 `git push origin +main` 的加号强制 refspec
    re: /\bgit\s+push\b[^|;]*(\s(--force\b|--force-with-lease\b|-f\b)|\s\+[\w./-]+:)/,
    why: '强推覆盖远端',
  },
  { re: /\bgit\s+(reset\s+--hard|clean\s+-\w*[fd]|checkout\s+--\s|branch\s+-D)/, why: '丢弃本地改动' },
  // (?!ers) 排掉 sudoers —— 读一个 sudoers 备份文件不是提权
  { re: new RegExp(String.raw`${W}sudo\b(?!ers)`), why: '提权执行' },
  { re: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|k)?sh\b/, why: '下载后直接执行' },
  { re: /\b(dd|mkfs\w*|diskutil\s+(erase|reformat)|fdisk|parted)\b/, why: '磁盘级操作' },
  // 777 / 0777 / a+rwx 都是同一件事
  { re: /\bchmod\s+(-\w+\s+)*(0?777|a\+rwx|ugo\+rwx)\b/, why: '放开全部权限' },
  { re: /\bchown\s+(-\w+\s+)*root\b/, why: '改所有者为 root' },
  { re: /\b(shutdown|reboot|halt|killall)\b/, why: '系统级中断' },
  { re: />\s*\/dev\/(sd|disk|nvme)/, why: '写入裸设备' },
  { re: /\bnpm\s+publish\b|\byarn\s+publish\b|\bgh\s+release\s+create\b|\bpip\s+upload\b/, why: '对外发布' },
  { re: /\bgit\s+push\b[^|;]*\s(--tags|--delete|-d)\b/, why: '改动远端引用' },
]

/**
 * 绝不该在日常命令里出现的凭证路径。命中即高危，不看动词。
 * 这些东西没有「顺手 cp 一下」的正当场景。
 */
export const SECRET_TOKENS = [
  String.raw`\.ssh/`,
  String.raw`id_(?:rsa|dsa|ecdsa|ed25519)\b`,
  String.raw`\.aws/(?:credentials|config)`,
  String.raw`\.npmrc\b`,
  String.raw`\.netrc\b`,
  String.raw`\.pgpass\b`,
  String.raw`\.gnupg\b`,
  String.raw`\.kube/config`,
  String.raw`\.docker/config\.json`,
  String.raw`login\.keychain`,
  String.raw`[\w./-]+\.(?:pem|p12|pfx|jks|keystore)\b`,
  String.raw`\bprivate[_-]?key\b`,
  String.raw`\bid_rsa\b`,
]

/**
 * `.env` 单独处理：它太常见了。
 *
 * `cp .env.example .env`、`touch .env` 是日常操作，全判高危会造成告警疲劳——
 * 而告警疲劳本身就是安全问题（用户会开始无脑划过去）。
 * 只有当它和「读出来 / 送出去」的动词一起出现时才算高危。
 */
// 前置用后顾断言而不是白名单：`curl -d @.env` 里前面是 `@`，
// 枚举分隔符总会漏掉一个。只要求「前面不是词字符或点」，
// 这样 `something.envelope`、`myfile.env` 不会误命中，而 `@.env`、`/.env`、`".env` 都能命中。
export const ENV_FILE = String.raw`(?<![\w.-])\.env(?:\.[\w-]+)?\b`

export const EXFIL_VERBS =
  /\b(cat|bat|less|more|head|tail|strings|xxd|base64|od|nc|ncat|socat|curl|wget|scp|rsync|ftp|sftp|mail|sendmail|tee|open|pbcopy)\b/

/** 作为工具参数传入的路径（Read/Write/Edit 的 file_path），路径锚定 */
export const SENSITIVE_PATH = new RegExp(
  String.raw`(^|/)(\.env(\.|$)|${SECRET_TOKENS.join('|')})`,
  'i',
)

/** 出现在 shell 命令文本里的凭证路径 */
export const SECRET_IN_COMMAND = new RegExp(SECRET_TOKENS.join('|'), 'i')
export const ENV_IN_COMMAND = new RegExp(ENV_FILE, 'i')

/**
 * 影响面标签。用户不展开命令原文时靠它判断，所以**错的标签比没有标签更危险**。
 *
 * 顺序即优先级：命中多条时全部显示，但 danger 会排在前面。
 * 注意 `ssh`/`curl` 这类必须限定在命令位置——否则 `cat ~/.ssh/id_rsa`
 * 会因为路径里的 `.ssh` 被标成「联网」，把一次凭证读取伪装成网络请求。
 */
export const IMPACT = [
  { re: new RegExp(String.raw`${W}sudo\b(?!ers)`), label: '提权', tone: 'danger' },
  {
    // 词首断言而非命令位置：`.ssh/id_rsa` 里的 ssh 前面是点，排除掉；
    // 而 `env ssh host`、`echo x | scp …` 里的仍然算。
    re: new RegExp(
      String.raw`${W}(?:ssh|scp|rsync|curl|wget|nc|ncat|ftp|sftp|telnet)\b` +
        String.raw`|${W}git\s+(?:push|pull|fetch|clone|remote)\b` +
        String.raw`|${W}(?:npm|yarn|pnpm|pip|brew|apt|gem|cargo)\s+(?:i|install|add|publish|update|upgrade)\b`,
    ),
    label: '联网',
    tone: 'warn',
  },
  {
    re: new RegExp(
      String.raw`${W}(?:rm|mv|cp|mkdir|rmdir|touch|chmod|chown|ln|dd|shred|truncate|tee)\b` +
        String.raw`|${W}sed\s+-i\b|${W}find\b[^|;]*(?:-delete|-exec)\b` +
        String.raw`|>{1,2}\s*[^\s&|]|${W}git\s+(?:commit|checkout|reset|clean|merge|rebase|stash|apply)\b`,
    ),
    label: '改动文件',
    tone: 'warn',
  },
]

/**
 * 确定只读的命令。**只有明确认得的才敢标「只读」。**
 *
 * 原先的逻辑是「没命中任何影响面 → 只读」，于是 `find . -delete` 这种
 * 没被规则覆盖的命令被标成了只读——完全说反。现在认不出来就说认不出来。
 *
 * 名单里**不能有**能执行任意代码或写文件的东西。曾经放进去过 `node`、
 * `python`、`env`、`tee`，等于把 `node -e "..."`、`env rm -rf /`、
 * `tee /etc/hosts` 全标成了只读。解释器和"垫一层"的前缀命令一律不进名单，
 * 它们会落到「影响面未知」，那是诚实的答案。
 */
export const READ_ONLY_CMDS =
  /^(?:ls|ll|pwd|cd|echo|printf|cat|bat|head|tail|less|more|wc|grep|rg|ag|fd|which|whereis|type|file|stat|du|df|ps|top|date|whoami|id|uname|printenv|history|man|help|jq|sort|uniq|cut|column|tr)$/

/** 这些 git 子命令不改工作区 */
export const READ_ONLY_GIT = /^(?:status|log|diff|show|branch|remote|config|blame|describe|rev-parse|ls-files|shortlog|tag)$/
