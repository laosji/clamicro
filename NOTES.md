# 维护笔记

给未来的自己。记的是**踩过的坑和当时的判断依据**，不是使用说明——那部分在 [README](./README.md)。

---

## 发布

### npm 11 的浏览器登录令牌没有发布权限

`npm login` 走浏览器 OAuth，终端确实会打印 `Logged in on https://registry.npmjs.org/`，`npm whoami` 也能返回用户名。但一发布就是：

```
403 Forbidden - Two-factor authentication or granular access token
with bypass 2fa enabled is required to publish packages.
```

**`npm publish --otp=xxxxxx` 也救不了**，试过。而且 npm 11 在这种令牌下根本不会弹出 OTP 交互提示，直接失败。

出路只有一条：去 https://www.npmjs.com/settings/<user>/tokens/new 建 **Granular Access Token**，勾上 **Bypass 2FA**，权限选 Read and write，然后

```bash
npm config set //registry.npmjs.org/:_authToken=<令牌>
```

包发布之后记得回去把令牌的作用域从 All packages 收窄到这一个包——泄露时影响面差别很大。

另一条路是把账号 2FA 从 *Authorization and Publishing* 降到 *Authorization only*，但那是把整个账号的发布保护关掉，为一次发布不值得。

### 发布前必须解包实物 tarball 搜密钥

`npm pack --dry-run` 只列文件名，看不到内容。真正的检查是解开打好的包逐字搜：

```bash
npm pack --pack-destination /tmp/v && tar xzf /tmp/v/*.tgz -C /tmp/v
grep -rl "<你的真实token>" /tmp/v/package
```

**这条救过一次**：`ui/settings.html` 里输入框的 placeholder 当初直接写了真实的 Bark key（`placeholder="例如 rNJf…"`）。发出去等于把推送通道公开，任何人都能往那台手机推东西。同类问题还有注释里的真实内网 IP 和主机名。

### 版本号一旦用掉就永久占用

即使 unpublish 也不能再发同号。24 小时后连 unpublish 都不行，只能 deprecate。

---

## 架构上不能忘的几件事

### 目录约定

```
server.mjs        入口。**必须留在根目录**——已安装的 hooks 里写的是
                  ~/.claude/clamicro/app/server.mjs 这个绝对路径，挪了就断
cli.mjs           CLI 入口（package.json 的 bin）
install.mjs       安装器
bin/*.sh          hook 脚本。同样被绝对路径引用，不能挪
src/
  http/           收发与传输层安全（respond / security）
  auth/           口令校验
  risk/           风险判定：危不危险。规则表与逻辑分开
  view/           展示：怎么说清楚。(toolName, toolInput) → 展示结构的纯函数
  routes/         按职责分的路由（hooks / pages / api）
  *.mjs           领域与基础设施（approvals / state / config / …）
ui/               页面
test/             不进 npm 包
```

`risk/` 和 `view/` 是一对：前者判「危不危险」，后者管「怎么说清楚」。
分开的好处在 `view/describe.mjs` 上很明显——它原本埋在 ApprovalStore 里，
只能通过 `create()` 间接测；拆出来之后边界情况（空输入、坏 URL、
超长描述、截断上限）才有人管。

**`state.mjs` 没有拆，是有意的。** 它 337 行主要是 `applyHook` 那个大 switch，
而 switch 全程在动 `#sessions` / `#log` / `#touch` 这些私有字段——抽出去就得
把内部状态暴露成公开 API，那是拿封装换行数，更差。行数大不等于该拆，
要看有没有真的接缝。

路由模块统一是「工厂 + 返回 handler」：`routes(ctx)` 拿到依赖，返回
`(req, res, url, path) => boolean`，**返回 true 表示已处理**。加新端点时
放进对应的 routes 文件，别往 server.mjs 里塞——它现在只负责装配和启动。

`src/risk/` 单独拎出来是因为它是安全核心：判定错了，上层再好的 UI、
再稳的传输都没有意义。独立之后测试可以直接打在它身上，不必起服务。

一个坑：`server.mjs` 装配路由时不能直接传 `net` / `trusted`，它们在
下面的「网络信任闸门」一节才求值，直接传会撞 TDZ。传闭包（`network: () => …`），
闭包体到请求进来时才执行。

### npm 包只是安装器

运行时必须复制到 `~/.claude/clamicro/app/`，hooks 指向那里。

hooks 里存的是**绝对路径**，而 `npx` 跑在会变的缓存目录、全局安装路径随 node 版本 / nvm / homebrew 变化。指向 npm 包意味着某天路径失效，**所有 hook 静默失败**——不报错，只是再也收不到通知。

验证方式：装完删掉 `node_modules`，服务和 hook 应该照常工作。

### hooks 热加载，statusLine 不

改 hooks 当前会话立刻生效；statusLine 是**会话启动时读一次**。

所以改名或换安装路径之后，**已经开着的会话 statusLine 会静默失效**——表现是那个会话再也不上报额度，而且没有任何报错。只能新开会话。

### 服务的生命周期跟着 Claude Code 走

监听套接字绑在**进程启动那一刻**的局域网 IP 上。DHCP 续租、换 Wi-Fi 之后那个
地址不再属于本机，于是：进程还活着、`/healthz` 照常回 ok、终端里一片安静，
但手机连过来是超时。

曾经想加个 20 秒的后台巡检来动态重绑，砍掉了——服务本来就是被 SessionStart
hook 拉起来的，生命周期已经跟着 Claude Code 了，再加一条独立的心跳是第二套
状态机。现在 `/healthz` 多返回一个 `stale`（现场重新探测 IP 和启动时比对），
`bin/session-start.sh` 看到 `stale:true` 就杀掉重启。顺带让网络信任闸门也
重新判一遍当前网络。

**已知残留**：如果换到一个不同的网络但**恰好拿到相同的 IP**，且中途不新开
Claude Code 会话，信任闸门不会重新跑，局域网监听会一直开着。窄，但不是零。
真要堵死得靠巡检或者 macOS 的网络变化通知。

### PermissionRequest 的 payload 里没有 tool_use_id

实测两个 hook 收到的字段（Claude Code 2.1.x）：

```
PermissionRequest  session_id transcript_path cwd prompt_id permission_mode
                   effort hook_event_name tool_name tool_input
                   permission_suggestions
PreToolUse         …同上（无 permission_suggestions）+ tool_use_id
PostToolUse        …PreToolUse 的全部 + tool_response duration_ms
```

**权限阶段还没分配 `tool_use_id`**，要到 PreToolUse 才有。所以「把挂起的审批和已经开跑的工具调用对上号」不能用它——第一版就是这么写的，结果 `supersede()` 是段永远匹配不上的死代码，幽灵条目照旧。

能用的只有两边都在、且逐字相同的三元组：`session_id` + `tool_name` + `tool_input`。哈希成 `match_key` 存在审批记录上，PreToolUse/PostToolUse 拿同样的三元组算一次去销账。

两个坑：

- `tool_input` 要**递归排序键后再序列化**。同源对象的键顺序本该一致，但那是「碰巧成立」，不值得赌。
- 同一会话里可能连着跑两条一模一样的命令，键会撞。一次只销**最早**的那条，剩下的留给下一次对账——否则两条挂起会被一次全销掉。

### 只能在服务端验证的东西，不代表客户端也成立

曾经把 `.local` 主机名设成默认地址，理由是「换 IP 不用重扫码」，并且在 Mac 上 `curl http://<host>.local:8765/healthz` 返回了 200，以为验证通过了。

**那个测试毫无意义**——Mac 解析自己的 `.local` 走的是回环，永远成功。手机能不能通过 mDNS 解析是另一回事，受管网络常屏蔽组播。结果就是二维码扫了打不开。

现在默认是 IP，`.local` 由**手机自己**发一个真实请求去探测，通了才建议切换。

同类判断：拿硬故障换小麻烦是亏的。打不开 = 完全不能用，IP 变了 = 重扫一次。

---

## 开发时会自己卡自己

`config.ignoreCwds` 里的工作目录跳过阻塞审批。开发本项目时把项目目录放进去，否则每跑一条命令都在等自己审批——**高危命令（`rm -rf` 之类）会挂满 570 秒**，而那时候没人在看手机。

注意匹配的是**会话的 cwd**，不是命令里 `cd` 到哪。踩过两次：填了 `.../clamicro` 而会话 cwd 是它的父目录 `~/Downloads`，等于没填。正确的写法是会话 cwd 本身。

`clamicro status` 现在会把免审批目录列出来并标黄——它是**完全旁路**，那些目录里 `rm -rf` 直接执行，这种事不该看不见。

发布前记得清空。

---

## 那些"看起来能跑"但其实错的

按踩到的顺序：

| 症状 | 真因 |
|---|---|
| 页面渲染出自己的源码 | `String.replace` 的替换串里 `$'` 表示"匹配之后的全部内容"，而审批内容全是 shell 命令、`$` 遍地都是。必须用函数式替换 |
| 一次 20px 的拖动就批准了操作 | `window.innerWidth` 在页面后台渲染时可能返回 **0**，阈值算出 0，任何位移都过线。阈值要有下限，另加绝对位移底线 |
| 从推送点进来每次都要重新扫码 | cookie 用了 `SameSite=Strict`。从外部 App 跳转属于跨站导航，Strict 的 cookie 不会被带上。必须 `Lax` |
| 取消之后下一个工具调用也被取消 | `cancel()` 唤醒挂起的 waiter 后没复位状态，`CANCELLED` 留着被下一次消费 |
| 额度反复变空 | 额度是纯内存的，没进 `history.json`，每次重启就清零 |
| 卸载后残留一个 hook | 卸载用路径片段 `clamicro/bin/` 匹配，而目录结构改过（`app/bin/`）。改成按脚本文件名认 |
| 界面显示「待审批」，可操作其实早执行完了 | 授权在别处放行后（终端弹框、权限规则、`acceptEdits` 模式），Claude Code **不会取消**已发出的 PermissionRequest 请求，连接还开着、close 事件也不触发，记录挂到超时。用 PreToolUse 对账销掉并返回 allow——但对账键**不能用 `tool_use_id`**，见下 |
| 首页 tab 高亮，内容却是另一个 tab 的 | 渲染函数抛异常时 `innerHTML` 保留上一个 tab 的内容，界面看起来正常只是对不上。起因是加变量时替换没匹配上、声明漏了，赋值给未声明变量抛 ReferenceError。已加渲染兜底：出错就显式报错，不要静默留着别人的内容 |
| `npm i` 后 CLI 报 import 失败 | `package.json` 的 `files` 白名单漏了 `install.mjs`。这种错只有真的打包安装才会暴露 |
| 二维码和推送深链全指向一个打不开的域名 | `publicBaseUrl` **落盘持久化**，而 quick tunnel 的地址是**临时**的。隧道进程一没（重启、被杀、Cloudflare 断开），配置里那个地址就作废了，但 `baseUrl` 仍无条件用它。现在以**进程是否存在**为准（`tunnelAlive()` 读 pid 文件 + `kill(pid, 0)`），死了就回落局域网并打一行日志 |
| `networks` 显示「网关 10.x.x.x  网关 10.x.x.x」 | 拿不到 SSID 时 `fp.label` 本身就是 `网关 ${gateway}`，输出又拼了一次网关 |
| 管道输入时安装程序挂死 | `printf 'y\ny\n' \| node install.mjs` 会一次性 EOF，readline 把所有行同时发完，第二行在第二次提问注册前就丢了。要自己缓冲行队列 |
| 删了函数却没删调用点，非法 Host 抛异常走 400 而不是 403 | `node --check` 只查语法，查不出未定义引用。功能上仍然拒绝，但那是碰巧——异常路径不该是安全边界的实现方式。这类只有跑起来才暴露，所以 HTTP 层要有集成测试 |
| 用 fetch 测 DNS rebinding，测了个寂寞 | `Host` 是 forbidden header name，规范要求实现忽略调用方设置的值。头被静默丢弃、请求带着真实 Host 发出去，于是「伪造 Host 被拒」这条断言实际测的是「合法 Host 被放行」。要用 `node:http` 原生请求 |
| 改代码时把页面源码注入进了源文件 | 用 `String.replace` 做代码替换，而替换串里写了 `` ——就是那段注释本身在警告的事。**任何 replace 都用函数式**，替换串里的 `$` 一律不解释 |
| 换网络后手机再也连不上，`status` 显示一切正常 | `bind` 里的 `null` 是「启动时探测局域网 IP」的占位符，而 `saveConfig` 把探测**结果**写回了盘。之后那个地址不属于本机，`listen` 报 `EADDRNOTAVAIL`，服务只剩回环。触发点是 `clamicro trust`——那条**专门用来开放局域网访问**的命令。查了两天 |
| 手机页面停在旧状态，看着像服务卡死 | Mac 换 IP 后，页面还连着旧地址，SSE 断了。原来只把一个小圆点的 `live` class 去掉，手机上根本看不见 |
| 点按钮报 `notify is not a function` | 装配处漏传依赖，解构出 `undefined`。JS 不在那一刻报错，要等真的调用才炸。已加 `requireDeps`，改成启动时就失败 |
| 刘海胶囊代码全对，屏幕上什么都没有 | 见下面「JXA 画窗口」一节，一共四个独立的坑，每一个都单独足以让它彻底不显示，而且**四个都不报错** |

### JXA 画窗口：四个各自足以让它彻底不显示的坑

做刘海 HUD 时连着踩了四个。共同点是 `osascript` 退出码 0、日志正常、`isVisible` 返回 true，**只有肉眼看屏幕才知道没画出来**。

1. **必须跑 `NSApp.run`，不能手动步进 runloop。**
   原来用 `NSRunLoop.currentRunLoop.runUntilDate()` 一帧帧推。窗口建得出来，WindowServer 也分配了 windowNumber，`isVisible=true`——但 `occlusionState` 始终是 8192，不含 visible 位（2）。换成 `NSApp.run` 之后立刻变 8194，画面就出来了。**AppKit 窗口要参与合成，得有 AppKit 自己的事件循环在跑。**
   配套：结束时不能用 `app.stop()`，它要等下一个事件才跳出循环，而这个进程没有任何输入事件 → 实测挂 60 秒不退。一次性进程直接 `app.terminate(null)`。
   还有：`app.run` 不能是 `run()` 的尾表达式，JXA 会把它当返回值求值，实测那样根本不进事件循环。后面随便跟一条语句就行。

2. **`spawn` 不能加 `detached: true`。**
   它会 `setsid()` 把子进程放进新会话，那个会话拿不到 WindowServer。终端里直接跑能弹，从 node 用 detached 起就不弹。

3. **不能用 `$.NSColor.blackColor.CGColor`。**
   返回的是 autorelease 的 CGColor，JXA 不替你持有，等图层真正绘制时已经悬空 → 进程被 SIGKILL，130ms 就没，**stderr 一个字都没有**。用 `$.CGColorCreateGenericRGB(0,0,0,1)`（+1 持有）。

4. **父进程别在 HUD 播完前退出。**
   `showHud` 之前调了 `unref()`，而 `--test-push` 走完 notify 就 `process.exit(0)`。子进程跟着被带走，于是这个**自检命令**打印「提醒通道是通的」，屏幕上什么都没出现过。去掉 unref，并让自检 `await hudDone()`。

方法论上的教训比这四条更重要：**我连着三次拿 `exit=0` 当成「画出来了」**。渲染类的东西唯一有效的验收是截图——`screencapture -x -T 2 -R x,y,w,h` 配合后台跑的进程，几秒就能确认，比读三遍代码可靠得多。凡是「输出到屏幕/网络/文件」的功能，验收标准必须是**从输出端观察到**，不是从调用端返回成功。

### 反复出现的一类：静默失败伪装成正常

这个项目里踩到三次，形态一样——**没有报错，功能就是不工作**：

1. 改名后 statusLine 路径失效 → 那个会话永远不上报额度
2. hooks 指向 npm 缓存目录，路径失效后**所有 hook 静默失败** → 再也收不到通知
3. 渲染函数抛异常 → 页面保留上一个 tab 的内容，看起来正常只是内容对不上
4. 隧道进程死了但 `publicBaseUrl` 还在盘上 → 二维码照常生成，扫了打不开
5. IP 变了但套接字还绑在旧地址上 → 进程活着、healthz 照常回 ok，手机连过来是超时
6. `bind` 绑失败 → 服务照常运行，`status` 显示「运行中 ✓ 已信任」，只有日志里一行 `EADDRNOTAVAIL`
7. SSE 断开 → 页面停在最后一帧，倒计时归零还挂着待审批，看起来像服务卡死
8. 刘海 HUD 写完了、模块注释也写了，但 `notify()` 从头到尾走的是 `display notification` ——**代码在，就是没接线**。日志照打 `[notify] ...`，测试全绿，只有肉眼看屏幕才知道弹错了地方

共同点是**失败路径上没有任何可见信号**。加功能时值得多问一句：这东西坏掉的时候，用户会看到什么？如果答案是「和正常一样」，就得主动加一个信号。

第 8 条是新的一种形态，值得单独记：前七条是**运行时**失败得静悄悄，这条是**根本没被调用**。新写一个模块很容易停在「它自己能跑」，而漏掉「有没有人调它」——单元测试只证明前者。防的办法是把「谁调用谁」也变成断言：`test/notify.test.mjs` 把两个通道做成可注入参数，专门测「样式设成什么就必须走到哪个通道」。凡是新增一条输出路径（通知、日志、上报），都该问一句：**如果我把它整个删掉，有测试会红吗？**

第 4 条还有一层更一般的教训：**持久化的配置引用了临时的资源**。凡是写进 `config.json` 的东西，都要问它的寿命和进程/网络的寿命是否一致——不一致就不能无条件信任盘上的值，得在用之前验一次活性。`bind` 是同一个病的另一种形态：把「每次启动探测」的结果当成「用户的配置」存了下来。

### 排查时先确认「你以为在观察的东西」真的在被观察

第 6 条查了整整两天，中间给出过一个自信但错误的结论：「办公网络禁止设备互通」。它建立在两个对照实验上，**两个都是无效的**：

1. `python3 -m http.server 9999` 也连不上 → macOS 应用防火墙按二进制放行，`node` 在名单里而 `python3` 不在。这个对照组测的是一个被防火墙拦掉的进程
2. 换手机热点也连不上 → 服务仍绑在旧网络的 IP 上（正是第 6 条那个 bug），而且新网络还会被信任闸门挡回回环。**无论网络通不通都不可能成功**

而三天前的对话里就有直接反证：手机曾经拿到过 `{"error":"not found"}`——那是**服务返回的 HTTP 响应**，证明连得上。当时甚至明确写过「客户端隔离的担心可以排除了」，后来却把它当成了结论。

几条可复用的：

- **对照组必须和被测对象走同一条路径**：同一个二进制、同一种绑定方式、同样的信任状态。差任何一项，它就只是另一个未知数
- **先问「服务到底绑在哪」，再问「网络通不通」**。`lsof -nP -iTCP:<port> -sTCP:LISTEN` 一条命令，第三天才想起来跑
- **「昨天还可以」是最强的线索**：它说明有个变量变了，而不是某个东西天生不行。翻历史记录比继续推理有用

---

## 安全边界

局域网内是**明文 HTTP**。同网络的被动嗅探者能拿到 token，进而获得完整控制权。这是设计上接受的边界，不是待修的 bug——修它需要 TLS，而自签证书会让 Safari 报警并破坏「扫码即用」。

缓解手段是网络信任闸门：陌生网络默认只绑回环。真需要在不可信网络上用就装 Tailscale，服务会自动识别 `100.64/10` 并绕过闸门（覆盖网自带加密）。

已实现的防护和各自挡住什么，见 [README 的安全章节](./README.md#security)。加新端点时注意：

- `/hooks/*` 和 `/statusline` **必须**只接受回环来源（它们没有 token）
- 任何新页面都受全局 Host 白名单保护，但新的**未认证**端点要单独想清楚 CSRF
