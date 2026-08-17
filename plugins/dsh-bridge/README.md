# clamicro-dsh-bridge

把 DeepSeek Harness 的会话状态桥接到 [Clamicro](https://github.com/laosji/clamicro) 手机端。

设计与取舍见 [docs/dsh-bridge.zh-CN.md](../../docs/dsh-bridge.zh-CN.md)。

## 当前状态

| | 状态 |
|---|---|
| 状态镜像（`session/event` → 手机看板） | 已实现，默认开，**真实 DSH 跑通** |
| 手机审批（`approval/request` 答复器） | 已实现，插件里**默认关**、装机器时由 install 开（见下）（bridge↔clamicro 决定往返契约已验） |
| 每次 bash 审批（`tools/pre-execute` ask gate，`askTools`） | 已实现，同上 |
| 完整闭环：DSH 工具调用 → 手机 → 决定传回 | **真实 DSH 会话跑通** |

事件名和字段名来自 DSH 的 `docs/subsystems/session.md` 与 `approval.md`，
并已在真实 headless 会话里跑通状态镜像。`lib/map.js` 里对每个字段都试了几个
可能的名字，认不出的事件一律丢弃——所以最坏情况是「手机上少几行时间线」，不是崩。

### 闭环实测记录

真实会话 `session-66507b96…`（不是构造的测试数据）：

| 环节 | 结果 |
|---|---|
| 工具名翻译 | DSH 的 `bash` → clamicro 的 `Bash` ✓ |
| callId 参数回查 | 命中，`args_known: true`，不是「参数未知」降级 ✓ |
| 风险判定 | `high · 递归/强制删除` —— 规则在真实 DSH 命令上触发 ✓ |
| 决定回传 | `denied · decided_by: phone` ✓ |

**风险判定那条是关键**：在修掉「工具名小写」之前，同一条 `rm -rf` 会因为
DSH 的工具名是小写 `bash`、而 clamicro 的判据写死了 `toolName === 'Bash'`，
导致整套高危规则**一条都不跑** → 判 normal → 10 秒自动通过。
现在判据改成看「参数里有没有 command」，不依赖工具名，这条才拦得住。

**插件代码里审批仍然默认关**：`approve` 不写就是 `false`，只镜像状态。跑通不等于
该默认开——打开它意味着 DSH 的每一条 bash 都要等手机，这是个影响日常手感的决定，
应该由用户显式做，而不是升级后突然变成这样。

**但 `npx clamicro install` 会替你写上 `approve: true`。** 这两句不矛盾：install
接 DSH 之前会单独问一句「要现在接上吗」，并且这一问 `--yes` 也跳不过去
（`wireUp` 里 `optIn=true`），那一次点头就是上面要的那个显式决定。不想要逐条审批、
只想要手机看板，就把 `cordis.patch.yml` 里的 `approve` 改成 `false`。

### 审批触发点（重要，先读再开）

DSH 的 `approval/request` 默认**不是「每条 bash 都问」**。`tools/pre-execute` 的
gate 默认 fallback 是 `{kind:"allow"}`，而「每次工具调用都 ask」的 responder 在
DSH 0.1.0-rc.6 里**尚未实现**（`dsh-tool-bash` 里是一行 TODO）。默认只有
**`approveEscalation`**（bash 请求 `sandbox_permissions: danger-full-access`
越权写文件）才会触发审批。

本插件为了对齐 Claude Code 的体验，**自己注册了一个 `tools/pre-execute`
responder**：`approve: true` 时，`askTools`（默认 `['bash']`）里的工具**每次
调用都走手机审批**，风险分档交给 clamicro（普通命令到点自动通过、高危到点
等人/自动拒绝），和 Claude Code 的 PermissionRequest 一致。

置空 `askTools: []` = 只审批沙箱升级，不逐条问 bash。

（原来关着的理由是「不知道 DSH 的 guard 允许答复器挂多久」。这个问题已经解决：
`dsh-tool-call-timeout-policy` 只包 `tools/execute`，而审批发生在它之前的
`tools/pre-execute` 阶段，所以**框架对审批等待没有任何截止时间**。完整推导见
方案文档 §7。）

## 安装

跟着 clamicro 的 npm 包走，不在 npm 上单独发包（所以 `dsh plugin add` 拉不到）。
`npx clamicro install` 探测到 `~/.dsh` 会问一句，同意后自动装；手动接法见
[../README.md](../README.md#装)。

Clamicro 需要在同一台机器上跑着（上报走回环，端点只认 127.0.0.1）。

## 配置

```jsonc
{
  "origin": "http://127.0.0.1:8765",  // Clamicro 服务地址
  "mirror": true,                      // 状态镜像
  "approve": false,                    // 手机审批：沙箱升级 + askTools 每次问
                                       //（这是插件默认；install 写的补丁层是 true）
  "askTools": ["bash"],                // approve 开启时，这些工具每次调用都问
  "timeoutMs": 600000,                 // 答复器自己的兜底截止时间
  "maxCalls": 200                      // callId 参数表的容量上限
}
```

`timeoutMs` 是**兜底**不是策略（默认 600 秒，见方案文档 §7.1）：它只防 HTTP 请求
本身卡死，必须**比 clamicro 自己的审批时限更长**——真正决定「等多久」的是 clamicro
的审批配置（普通操作到点自动通过、高危到点自动拒绝）。它不是从 Claude Code 的
570 秒抄来的：那个数字是为 fail-open 语义定的（超时会被当成放行），这里语义相反
（超时交回人类），照抄没有依据。

## 三条不能违反的约束

1. **状态上报不能阻塞。** 插件跑在 DSH 主进程内，`await` 一个卡住的本地服务
   就是拖住 DSH 的事件循环。Claude Code 那边的 hook 是独立进程，卡了只卡它
   自己——这个前提在这里不成立。见 `lib/report.js` 的 `send()`。

2. **审批出错必须交回人类，不能返回 `rejected`。** DSH 是 fail-closed：答复器
   抛异常 = `unavailable` = 不授予。把「Clamicro 连不上」判成「用户拒绝了」的
   后果是服务一挂，DSH 的所有待审批工具调用全被静默拒绝。所有错误路径都走
   `next()`。

3. **参数不知道 ≠ 没有参数。** `ApprovalRequest` 不带工具参数，靠 `callId` 回查
   session log 的 `tool/call`。查不到时上报 `args_known: false`，Clamicro 会把
   风险判成高危而不是低危——传空对象进去的话，风险规则一条都匹配不上，会算出
   「普通风险」然后进入自动通过档位，那就是一次没有任何人看过内容的放行。
   这条由 `test/dsh-bridge.test.mjs` 钉住。

## 版本兼容

DSH 是开发预览版，官方明说会有破坏性变更。本插件核对过的是 **0.1.0-rc.6**。

### 不靠版本号判断该不该改

版本号变了**不一定**影响我们：46 个事件类型里只用 7 个，绝大多数改动无关。
反过来，真正会伤到我们的是字段改名——那完全可能发生在一个 patch 版本里。

所以插件在运行时做两件强度不同的事（[lib/compat.js](lib/compat.js)）：

| 信号 | 强度 | 含义 |
|---|---|---|
| 版本号与 `TESTED_DSH` 不同 | 提示一句 | 该回归一遍了，**不代表坏了** |
| 事件形状对不上 | 高声警告，每类事件一次 | **现在就已经在错译了** |

形状检查为什么必要：这个插件所有的翻译错误都是**安静**的。`tool/call.name`
改个名，我们读到 `undefined`，手机上每张卡片显示 `?`，没有任何一处会抛异常。
`arguments` 从字符串改成对象，所有审批变成「参数未知」的高危——安全，
但每条都要手点，而人只会觉得「这东西怎么变傻了」。这类故障不会自己浮出来。

形状对不上时**仍然照常翻译**，只是喊一声。因为 DSH 加字段是最常见的无害变更，
为一次可能的误判让整个会话从手机上消失，比残缺的显示更糟——后者至少还有线索。

### 升级 DSH 之后

1. 跑 `npm test`（`test/dsh-bridge.test.mjs` 钉着所有字段假设）
2. 起一次真实会话，看日志里有没有形状警告
3. 有警告 → 对照 [方案文档 §4.1](../../docs/dsh-bridge.zh-CN.md) 重新核对字段名，
   改 `lib/map.js`，补测试
4. 没警告 → 把 `lib/compat.js` 的 `TESTED_DSH` 和 `package.json` 的
   `clamicro.testedAgainstDsh` 一起改成新版本号

**不追更新**：没有形状警告就不必动。
