# DeepSeek Harness 插件

这两个插件让 Clamicro 和 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 配合工作。
它们**不随 clamicro 的 npm 包发布**（`npm pack` 里没有 `plugins/`），需要单独装进 DSH 的 profile。

| 插件 | 作用 | 默认 |
|---|---|---|
| [`dsh-bridge`](dsh-bridge/) | 把 DSH 的会话状态和审批请求桥接到手机 | 状态镜像开、审批**关**（要审批得配 `approve: true`） |
| [`dsh-pet-cat`](dsh-pet-cat/) | Web UI 上的像素猫；点一下打开手机看板 / 配对二维码 | 联动开 |

两个可以单独装，装一个也能用。

## 装

```bash
dsh plugin --profile web add <包名>
```

然后在 `~/.dsh/profiles/web/cordis.patch.yml` 里插一条：

> **多数情况下你不用读这一节。** `npx clamicro install` 探测到 `~/.dsh` 会问一句，
> 同意后这两个插件和下面这段配置都是自动写的，卸载时一并摘除。
> 下面是手动接法，以及 install 认不出你的 `cordis.patch.yml` 格式时要贴的内容。

```yaml
- insert:
    - id: clamicro-bridge
      name: clamicro-dsh-bridge
      config:
        origin: http://127.0.0.1:8765
        # 关键：approve 默认 false（只镜像、不审批）。要手机审批必须显式开，
        # 并指定哪些工具每次调用都问（默认 bash）。
        approve: true
        askTools: ['bash']
    - id: pet-cat
      name: dsh-pet-cat
```

## 版本号

两个插件的 `version` 始终等于 clamicro 自己的版本 —— 它们随 clamicro 一起发布，
不单独发 npm、也不单独打 tag。各自维护一个号只会制造假信息：包里写着 0.2.0，
而它其实是 2.15.0 那次发出去的东西，拿这个号去翻变更记录什么也找不到。

发版前跑 `node scripts/sync-plugin-versions.mjs` 对齐，`test/plugin-versions.test.mjs`
会盯着有没有漂。

## 为什么分成两个

`dsh-bridge` 是**功能**：它拿得到会话事件、能挂住工具调用等你在手机上批准，
出问题会影响 DSH 的运行（所以它的三条硬约束单独写在自己的 README 里）。

`dsh-pet-cat` 是**入口**：纯浏览器端，一个字节的后端逻辑都没有，
最坏情况是它自己不显示。

两者唯一的联系是那条 `origin`。桥接不装，猫照样能把你带到手机看板；
猫不装，桥接照样工作。合成一个包会让「我只想要审批」的人被迫接受一只猫。

## 版本兼容

DSH 是开发预览版，官方明说会有破坏性变更。桥接插件在运行时做**字段形状检查**
（对不上就高声警告，而不是安静地错译），详见它自己的 README。
猫只用 `ctx.slots`，那是最稳定的那层。
