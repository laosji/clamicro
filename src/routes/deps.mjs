/**
 * 路由工厂的依赖检查。
 *
 * 路由模块从 ctx 里解构一堆东西。装配处漏传一个，解构结果就是 undefined——
 * 而 JS 不会在这一刻报错，要等到真的调用它才抛「x is not a function」。
 * 那时候用户已经点了按钮，看到的是一个坏掉的页面。
 *
 * 这个项目里同一类错误犯过两次：
 *   · 把 store.applyHook 解构出的 notify 和通知函数重名，遮蔽了后者
 *   · 删 Bark 时把 pageRoutes({ …, push, … }) 的 push 直接删掉，忘了换成 notify
 *
 * 两次都是运行时才炸，而且都是测试没覆盖到的路径。所以把它挪到启动时：
 * 缺依赖 = 服务起不来，日志第一行就写清楚缺哪个。
 * 起不来比「起来了但某个按钮是坏的」好排查得多。
 */
export function requireDeps(name, ctx, keys) {
  const missing = keys.filter((k) => ctx?.[k] === undefined)
  if (missing.length) {
    throw new Error(`${name} 缺少依赖: ${missing.join(', ')}（装配处漏传了）`)
  }
}
