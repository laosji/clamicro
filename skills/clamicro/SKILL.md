---
name: clamicro
description: 管理 Clamicro（在手机上审批 Claude Code 操作的服务）。当用户说到 clamicro 加任意动作时触发，例如「clamicro 二维码」「clamicro QR code」「clamicro 状态」「clamicro 重启」。也响应不带名字的说法：「手机上打不开」「服务挂了吗」「有几条待审批」「Claude 卡住不动了」「换 Wi-Fi 了连不上」。
---

# Clamicro 管理

用户会用「clamicro + 一个动作」的方式调用，动作是自然语言而非固定命令。先把它
映射到下面某一项，执行，然后把结果直接呈现出来。

CLI 是 `npx clamicro`。完整命令表 `npx clamicro help`。

> **这份文件的正本在仓库里**（`skills/clamicro/SKILL.md`），受 `test/docs.test.mjs`
> 覆盖——超时值、自动通过时长、cookie 有效期只要和代码对不上就会让测试变红。
> 改这里之前先确认代码里现在是什么值，别凭记忆写。

## 动作映射

| 用户可能这么说 | 做什么 |
|---|---|
| 手机上打不开 / 连不上 / 装完没反应 / 是不是没装好 | → **先跑 doctor** |
| 二维码 / QR / 扫码 / 登录 / 换手机了 | → **显示二维码** |
| 状态 / 现在怎么样 / 服务挂了吗 / 在跑吗 | → **状态** |
| 待审批 / 有什么在等 / 谁卡住了 | → **待审批与决策** |
| Claude 卡住了 / 命令不动了 / 一直没反应 | → **排查阻塞** |
| 换 Wi-Fi 了 / 信任网络 | → **网络** |
| 停一下 / 关掉服务 | → **启停** |
| 接上 Codex / 接上 DSH | → **接别的后端** |
| 手机丢了 / 令牌可能泄露了 | → **吊销** |
| 日志 / 报错 | → **日志** |
| 别吵 / 静音 / 改提醒方式 | → **设置** |

## 先跑 doctor

「手机上打不开」这类话里**没有足够的信息判断卡在哪一步**，别猜，先取现场：

```bash
npx clamicro doctor
```

它按安装的七步排队检查，只报**第一个**断掉的地方，并给出对应的修法。输出是一段
脱敏过的 markdown（不含令牌、家目录、SSID、IP 主机位、设备名），可以让用户原样贴到
issue 里。

把它的结论直接念给用户，别自己另编一套诊断。

## 显示二维码

```bash
npx clamicro qr
```

加 `--no-cat` 去掉那只猫。

**把终端二维码原样输出给用户**——不要转述、不要截断、不要包在额外说明里，它需要能被
手机相机扫到。下面那行 URL 也保留，方便手输。

出现「备用地址」时一并给出并说明：主地址是 Bonjour 主机名（换 IP 不失效），备用是
裸 IP（主机名解析不了时用）。

登录状态存成 cookie，**30 天**有效，到期再扫一次。

## 状态

```bash
npx clamicro status
```

版本、运行时路径、服务在不在跑、实际监听了哪些地址、hooks 完不完整、当前网络与
信任状态、用量、以及「服务为什么还开着 / 什么时候会关」。

`status` 面向「服务好着没」，`doctor` 面向「我卡住了」。用户描述的是故障就用后者。

## 待审批与决策

```bash
npx clamicro pending              # 列出待审批，含到点会怎么处理
npx clamicro approve <id前缀>     # 批准
npx clamicro deny <id前缀>        # 拒绝
```

**不要自己拼 curl 去读 `~/.claude/clamicro/config.json` 里的令牌。** 那会把主令牌
展开进命令行参数，同机器上任何进程 `ps` 一下就能看到，而主令牌 `forget` 吊销不掉、
还能签发新设备。上面三条命令存在的理由就是这个。

高风险操作在终端批准**必须写明 id**，不能靠「反正只有一条」蒙过去——手机上高危要划
更长的距离，终端这边得有等价的摩擦。

## 排查阻塞

用户说「Claude Code 卡住了 / 命令没反应」时，多半是一条审批在阻塞而他没看见。

1. `npx clamicro pending` 看有没有在等的
2. 有就让他在手机上处理，或者直接 `approve` / `deny`
3. 一条都没有 → 跑 `npx clamicro doctor`，八成是 hooks 或服务出了问题

**默认行为要先说清楚**，不然用户对「卡住」的预期是错的：

- 普通操作等 10 秒，没人管就**自动通过**（不然 `npm run build` 也要等你）
- 高风险操作（`rm -rf`、force push、动 `~/.ssh`）会一直等，**3 分钟**后自动拒绝

所以「卡了很久」基本只可能是高危操作。那个 3 分钟可以在手机设置页改，硬上限是
570 秒——再往上就会撞 hook 自己的系统超时，审批整个失效。

想彻底停掉拦截：`npx clamicro uninstall`（只摘 clamicro 加的 hook，用户自己的配置
原样保留）。这是重手段，先确认前面三步都试过。

## 网络

```bash
npx clamicro networks   # 当前网络 + 已信任列表
npx clamicro trust      # 信任当前网络
npx clamicro untrust    # 撤销（untrust <id前缀> | untrust all）
```

陌生网络下服务只绑回环、手机连不上——**这是有意的**，局域网内是明文传输。用户换了
Wi-Fi 说「连不上了」，先跑 `networks` 看是不是没信任。

网络指纹只剩网段时 `networks` 会警告：多半是 VPN 接管了默认路由，断开再信任会准得多。

## 启停

```bash
npx clamicro stop      # 停
npx clamicro start     # 前台启动（调试用）
```

平时**不需要手动启动**——`SessionStart` hook 会在打开 Claude Code 时自动拉起；所有
后端都退出之后它自己会关。**没有开机自启这个功能**，别去找那个命令。

## 接别的后端

```bash
npx clamicro connect dsh
npx clamicro connect codex
```

`install` 探测到会提一句，但**不会自己接**——那写的是那个产品自己的配置文件
（`~/.dsh/profiles`、`~/.codex/config.toml`），得用户自己点头。

Codex 还差一步手动的：打开一次 Codex，同意它问的「是否信任这份 hooks 配置」。
没点之前它会**静默跳过** hooks——不报错、不提示、一条事件都不来，而其他每一项检查
都显示正常。`status` 和 `doctor` 都会把这个状态单独报出来。

## 吊销

```bash
npx clamicro devices        # 已配对的手机
npx clamicro forget <id>    # 吊销某一台
npx clamicro rotate-token   # 换发主令牌（怀疑泄露时）
```

**一台配对过的手机等于一把能执行任何操作的钥匙**——能批准 `rm -rf`、能让它读
`~/.ssh/id_rsa`。手机丢了就 `forget`；怀疑令牌泄露就 `rotate-token`，所有设备当场
下线，需要重新配对。两者都立刻生效，不用重启服务。

## 设置

**优先让用户在手机网页的「设置」里改**，比命令行直观，而且改完立刻生效。

想看当前生效的完整配置（每项标出来自默认值还是改过）：

```bash
npx clamicro config
```

**不要用 `node -e` 直接写 `config.json`。** 那是非原子写：写到一半被打断，文件会永久
截断，而里面装着主令牌和每一台已配对设备——代价是全部丢失、所有手机重新配对。服务
自己写这个文件走的是临时文件 + 原子替换。

提醒只有 **Mac 本地通知**这一条，完全不联网。远程推送（ntfy 中转、Bark）做过又整个
删掉了，配置里残留的 `push` 段会在下次启动时被自动清掉——**别去改那个字段，它不生效**。
离开电脑后不会有东西叫你，高危操作会等到超时被拒，这是有意的默认。

## 日志

```bash
npx clamicro logs
tail -50 ~/Library/Logs/clamicro.log
```

## 需要知道的几件事

- 服务同时绑 `127.0.0.1` 和局域网 IP，手机需与 Mac 同一 Wi-Fi（或同一 tailnet）
- **statusLine 是会话启动时读取的**：装完之后已经开着的会话不会上报用量，必须新开
  一个会话。用量显示「旧数据」多半就是这个，不是故障
- hooks 是热加载的，改完当前会话即生效；statusLine 不是
- 风险等级是对命令文本做模式匹配，**不是沙箱**。批准之后命令以用户完整权限执行，
  「普通」只代表没有规则命中，不代表安全
- `config.ignoreCwds` 里的目录**完全旁路**，那些目录下 `rm -rf` 直接执行。`status`
  会把它标黄列出来
