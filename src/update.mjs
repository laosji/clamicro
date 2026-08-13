/**
 * 版本提示。
 *
 * ## 两件不同的事
 *
 * 1. **运行时落后于包**（离线，不花任何代价）
 *    `npx clamicro@latest status` 跑的是 npm 包里的 cli.mjs，但服务跑的是
 *    `~/.claude/clamicro/app` 里那份拷贝——只有 `install` 才会同步。
 *    包更新了却没跑 install 时，status 老老实实报运行时的旧版本号，
 *    不说一个字。用户会以为自己已经是新版了。
 *
 * 2. **本地落后于 registry**（要联网）
 *    这一条和这个项目「完全不联网」的原则有冲突，所以理由必须站得住：
 *
 *    2.0.1 是**会把主令牌泄漏进事件流**的那个版本——事件明细存 Claude 的
 *    回复原文，只要它贴过一次登录地址，任何已配对的手机都能从 /api/stream
 *    读回主令牌。装着那个版本的人如果永远不知道有新版，这个洞就永远在。
 *    一个管审批的工具，不告诉用户「你这版有安全问题」是说不过去的。
 *
 *    代价说清楚：**这是整个工具唯一一次主动对外的网络请求**，只发给
 *    registry.npmjs.org，只在你手动敲 `clamicro status` 时发，一天最多一次
 *    （结果缓存），超时 1.5 秒，失败完全静默。不想要就在 config.json 里
 *    设 `checkUpdates: false`，一次都不会发。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const REGISTRY = 'https://registry.npmjs.org/clamicro/latest'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const TIMEOUT_MS = 1500

/**
 * 语义化版本比较。只比 major.minor.patch，预发布标签一律当成「不新」——
 * 不该把人往 beta 上推。
 *
 * @returns true 表示 a 比 b 新
 */
export function isNewer(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ''))
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
  }
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return false
  // 带预发布标签的（1.2.3-beta.1）不算新版
  if (/^\d+\.\d+\.\d+-/.test(String(a))) return false
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] > y[i]
  }
  return false
}

/**
 * 查 registry 上的最新版。任何失败都返回 null——**没网不是错误**，
 * 一个局域网工具在飞机上也该能用，不能因为查不到版本就报错或者变慢。
 *
 * @param current   本地版本
 * @param cacheFile 缓存路径。传 null 表示不缓存（测试用）
 * @param fetchImpl 注入用，测试不该真的发请求
 */
export async function checkUpdate(current, { cacheFile = null, now = Date.now(), fetchImpl = fetch } = {}) {
  let cached = null
  if (cacheFile) {
    try {
      cached = JSON.parse(readFileSync(cacheFile, 'utf8'))
    } catch {
      /* 没缓存或者坏了，重查 */
    }
    if (cached && typeof cached.at === 'number' && now - cached.at < CACHE_TTL_MS) {
      return cached.latest && isNewer(cached.latest, current) ? { latest: cached.latest } : null
    }
  }

  let latest = null
  try {
    const r = await fetchImpl(REGISTRY, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!r.ok) return null
    const j = await r.json()
    latest = typeof j?.version === 'string' ? j.version : null
  } catch {
    return null // 没网、超时、registry 挂了——一律当作没这回事
  }
  if (!latest) return null

  if (cacheFile) {
    try {
      writeFileSync(cacheFile, JSON.stringify({ at: now, latest }), { mode: 0o600 })
    } catch {
      /* 缓存写不进去就每次都查，不影响功能 */
    }
  }
  return isNewer(latest, current) ? { latest } : null
}
