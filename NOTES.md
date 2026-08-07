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
  risk/           风险判定。规则表与逻辑分开，见下
  routes/         按职责分的路由（hooks / pages / api）
  *.mjs           领域与基础设施（approvals / state / config / …）
ui/               页面
test/             不进 npm 包
```

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

`config.ignoreCwds` 里的工作目录跳过阻塞审批。开发本项目时把项目目录放进去，否则每跑一条命令都在等自己审批。

注意匹配的是**会话的 cwd**，不是命令里 `cd` 到哪。曾经填了 `.../clamicro` 而会话 cwd 是它的父目录，等于没填。

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

### 反复出现的一类：静默失败伪装成正常

这个项目里踩到三次，形态一样——**没有报错，功能就是不工作**：

1. 改名后 statusLine 路径失效 → 那个会话永远不上报额度
2. hooks 指向 npm 缓存目录，路径失效后**所有 hook 静默失败** → 再也收不到通知
3. 渲染函数抛异常 → 页面保留上一个 tab 的内容，看起来正常只是内容对不上
4. 隧道进程死了但 `publicBaseUrl` 还在盘上 → 二维码照常生成，扫了打不开
5. IP 变了但套接字还绑在旧地址上 → 进程活着、healthz 照常回 ok，手机连过来是超时

共同点是**失败路径上没有任何可见信号**。加功能时值得多问一句：这东西坏掉的时候，用户会看到什么？如果答案是「和正常一样」，就得主动加一个信号。

第 4 条还有一层更一般的教训：**持久化的配置引用了临时的资源**。凡是写进 `config.json` 的东西，都要问它的寿命和进程/网络的寿命是否一致——不一致就不能无条件信任盘上的值，得在用之前验一次活性。

---

## 安全边界

局域网内是**明文 HTTP**。同网络的被动嗅探者能拿到 token，进而获得完整控制权。这是设计上接受的边界，不是待修的 bug——修它需要 TLS，而自签证书会让 Safari 报警并破坏「扫码即用」。

缓解手段是网络信任闸门：陌生网络默认只绑回环。真需要在不可信网络上用就装 Tailscale，服务会自动识别 `100.64/10` 并绕过闸门（覆盖网自带加密）。

已实现的防护和各自挡住什么，见 [README 的安全章节](./README.md#security)。加新端点时注意：

- `/hooks/*` 和 `/statusline` **必须**只接受回环来源（它们没有 token）
- 任何新页面都受全局 Host 白名单保护，但新的**未认证**端点要单独想清楚 CSRF
