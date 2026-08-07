/**
 * HTTP 收发的基本件。不含任何业务判断。
 */

/**
 * 读请求体并解析 JSON。
 *
 * 有大小上限：hook 的 payload 里带着模型生成的 tool_input，理论上可以很大，
 * 而这个服务是常驻进程，没有上限就等于给本机任何进程留了个把内存吃光的口子。
 */
export function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (err) {
        reject(new Error(`invalid JSON: ${err.message}`))
      }
    })
    req.on('error', reject)
  })
}

export function json(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

export function text(res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

export function html(res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/**
 * 把值安全地嵌进内联 <script> 里的 JSON 字面量。
 *
 * 三处转义都是必须的，各自对应一次真实事故或一类真实事故：
 *   `<`        —— 命令里含 `</script>` 会当场截断内联脚本，页面把自己的源码渲染出来
 *   U+2028/29  —— JS 里是行终止符，会把字符串字面量拦腰截断
 *
 * 注意调用方必须用**函数式** replace 把结果塞进模板：String.replace 的替换串里
 * `$'` 表示「匹配之后的全部内容」、`$&` 表示匹配本身，而审批内容是 shell 命令、
 * `$` 遍地都是。传字符串会把页面自己的源码注入进来。
 */
export function inlineJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}
