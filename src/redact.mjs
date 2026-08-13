/**
 * 从要落盘 / 要发给手机的文本里抹掉自己的凭证。
 *
 * ## 为什么需要这个
 *
 * `events[].detail` 存的是 Claude 的回复原文（Stop hook 的
 * `last_assistant_message`）。只要 Claude 在对话里贴过一次登录地址——
 * 比如 `http://x.local:8765/ui?t=<主令牌>`——主令牌就被原样写进
 * `history.json`，并且通过 `/api/stream` 推给**任何已配对的设备**。
 *
 * 那台手机本来只持有自己的**设备令牌**：它可以被 `clamicro forget` 单独
 * 吊销，权限也只到自己这一份。而主令牌不属于任何设备，`forget` 吊销不掉，
 * 它还能签发新设备。**从事件流里读回主令牌 = 提权。** 实测在自己的
 * history.json 里搜到过 5 次。
 *
 * 这是个自伤型漏洞：工具的职责就是把 Claude 的输出摊开给你看，而它把
 * 自己的钥匙也一起摊了。
 *
 * ## 两道网
 *
 * 1. **精确匹配当前所有令牌**——主令牌 + 每台设备的令牌。
 * 2. **按 URL 参数形状匹配** `?t=` / `?k=`，不看值。这道网能罩住第 1 道
 *    罩不住的：已经轮换掉的旧令牌、单条审批的 `k=`、以及以后新加的
 *    任何一次性凭证。凭证换了、这里忘了改，第 2 道仍然生效。
 *
 * 只抹不改长度对齐之类的东西——这不是脱敏展示，是防止凭证外流，
 * 抹成固定标记就够了。
 */

const MASK = '***'

/** `?t=abc` / `&k=abc` → `?t=***`。值的字符集按 base64url + 点号取，覆盖各种令牌形态。 */
const QUERY_SECRET = /([?&](?:t|k)=)[A-Za-z0-9_\-.~+/=%]+/g

/**
 * @param secrets 返回**当前**全部凭证的函数。必须是函数不是数组——
 *                配对会往 config.devices 里加设备，抹除必须看到最新的那份。
 */
export function makeRedactor(secrets = () => []) {
  return function redact(text) {
    if (typeof text !== 'string' || !text) return text
    let out = text.replace(QUERY_SECRET, `$1${MASK}`)
    for (const s of secrets()) {
      // 太短的「凭证」不敢全局替换：会把正常文本打得到处是 ***
      if (typeof s === 'string' && s.length >= 12) out = out.split(s).join(MASK)
    }
    return out
  }
}

/** 什么都不抹。给测试和不关心凭证的调用方用。 */
export const noRedact = (text) => text
