import { cpSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 运行时文件的安装位置。
 *
 * hooks 里写的是绝对路径，所以这个位置必须稳定。npm 包本身不行：
 *   · npx 每次跑在会变的缓存目录里
 *   · 全局安装路径随 node 版本 / nvm / homebrew 变化
 * 路径一旦失效，所有 hook 会静默失败——你不会收到任何报错，只是再也
 * 收不到通知。所以把运行时复制到用户目录下的固定位置，npm 包只当安装器。
 */
export const APP_DIR = join(homedir(), '.claude', 'clamicro', 'app')

export const SOURCE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

/** 从 npm 包（或源码目录）同步到 APP_DIR */
export function syncApp() {
  // 全量替换，避免旧版本残留的文件被新版本的代码 import 到
  if (existsSync(APP_DIR)) rmSync(APP_DIR, { recursive: true, force: true })
  mkdirSync(APP_DIR, { recursive: true })

  for (const item of ['server.mjs', 'src', 'ui', 'bin']) {
    const from = join(SOURCE_DIR, item)
    if (existsSync(from)) cpSync(from, join(APP_DIR, item), { recursive: true })
  }

  // 记一笔来源和版本，排查时有用
  let version = '0.0.0'
  try {
    version = JSON.parse(readFileSync(join(SOURCE_DIR, 'package.json'), 'utf8')).version
  } catch {
    /* 源码目录直接跑时可能没有 */
  }
  writeFileSync(
    join(APP_DIR, 'INSTALLED.json'),
    JSON.stringify({ version, source: SOURCE_DIR, at: new Date().toISOString() }, null, 2),
  )
  return { version, appDir: APP_DIR }
}

export function installedInfo() {
  try {
    return JSON.parse(readFileSync(join(APP_DIR, 'INSTALLED.json'), 'utf8'))
  } catch {
    return null
  }
}

export const appPaths = () => ({
  server: join(APP_DIR, 'server.mjs'),
  statusLine: join(APP_DIR, 'bin', 'statusline.sh'),
  sessionStart: join(APP_DIR, 'bin', 'session-start.sh'),
})
