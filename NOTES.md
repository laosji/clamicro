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

### npm 包只是安装器

运行时必须复制到 `~/.claude/clamicro/app/`，hooks 指向那里。

hooks 里存的是**绝对路径**，而 `npx` 跑在会变的缓存目录、全局安装路径随 node 版本 / nvm / homebrew 变化。指向 npm 包意味着某天路径失效，**所有 hook 静默失败**——不报错，只是再也收不到通知。

验证方式：装完删掉 `node_modules`，服务和 hook 应该照常工作。

### hooks 热加载，statusLine 不

改 hooks 当前会话立刻生效；statusLine 是**会话启动时读一次**。

所以改名或换安装路径之后，**已经开着的会话 statusLine 会静默失效**——表现是那个会话再也不上报额度，而且没有任何报错。只能新开会话。

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
| 界面显示「待审批」，可操作其实早执行完了 | 终端那边放行后，Claude Code **不会取消**已发出的 PermissionRequest 请求，连接还开着、close 事件也不触发，记录挂到超时。用 `tool_use_id` 和 PreToolUse 对账，销掉并返回 allow |
| `npm i` 后 CLI 报 import 失败 | `package.json` 的 `files` 白名单漏了 `install.mjs`。这种错只有真的打包安装才会暴露 |
| 管道输入时安装程序挂死 | `printf 'y\ny\n' \| node install.mjs` 会一次性 EOF，readline 把所有行同时发完，第二行在第二次提问注册前就丢了。要自己缓冲行队列 |

---

## 安全边界

局域网内是**明文 HTTP**。同网络的被动嗅探者能拿到 token，进而获得完整控制权。这是设计上接受的边界，不是待修的 bug——修它需要 TLS，而自签证书会让 Safari 报警并破坏「扫码即用」。

缓解手段是网络信任闸门：陌生网络默认只绑回环。真需要在不可信网络上用就装 Tailscale，服务会自动识别 `100.64/10` 并绕过闸门（覆盖网自带加密）。

已实现的防护和各自挡住什么，见 [README 的安全章节](./README.md#security)。加新端点时注意：

- `/hooks/*` 和 `/statusline` **必须**只接受回环来源（它们没有 token）
- 任何新页面都受全局 Host 白名单保护，但新的**未认证**端点要单独想清楚 CSRF
