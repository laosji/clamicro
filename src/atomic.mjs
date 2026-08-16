import { writeFileSync, renameSync, chmodSync, unlinkSync } from 'node:fs'

/**
 * 原子地写一个文件。
 *
 * ## 为什么不能直接 writeFileSync
 *
 * `writeFileSync` 是**截断 + 逐块写**：文件先变成 0 字节，再慢慢填回去。
 * 那个中间态是真实存在的，别人读到就是半截 JSON。
 *
 * 这在这个项目里有两条具体路径会踩到：
 *
 *   · **配置热加载**（server.mjs 的 watchConfig）。CLI 改盘的同时服务在读，
 *     读到半截就解析失败。那边虽然有「解析失败保持原样」的兜底，但兜底
 *     是最后一道，不该拿来当第一道。
 *   · **进程被打断**（Ctrl-C、崩溃、断电）正好落在写的中途，文件就永久
 *     半截了。config.json 半截 = 令牌和已配对设备全没了，手机得重新扫码；
 *     settings.json 半截 = Claude Code 起不来。
 *
 * ## 做法
 *
 * 先写同目录的临时文件，再 rename 覆盖。同一文件系统上的 rename 是原子的：
 * 任何时刻读到的要么是完整的旧内容，要么是完整的新内容，不存在中间态。
 *
 * 临时文件必须在**同一个目录**——跨文件系统的 rename 会退化成复制，
 * 原子性就没了。
 *
 * history.mjs 早就是这么写的，config 和 settings 一直没跟上。
 * 抽出来共用，免得下一个写盘的地方又各写一遍。
 *
 * @param path 目标路径
 * @param data 内容
 * @param mode 可选，写完后 chmod（比如含凭证的文件给 0o600）
 */
export function writeAtomic(path, data, mode) {
  const tmp = `${path}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, data)
    // 先设权限再 rename：rename 之后再 chmod 的话，中间有一瞬间目标文件
    // 是默认权限（0644）。含令牌的文件在那一瞬是全局可读的
    if (mode !== undefined) chmodSync(tmp, mode)
    renameSync(tmp, path)
  } catch (err) {
    // 失败时别把临时文件留在那儿碍事
    try { unlinkSync(tmp) } catch { /* 本来就没建成 */ }
    throw err
  }
}
