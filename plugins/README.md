# DeepSeek Harness 插件

这两个插件让 Clamicro 和 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 配合工作。
它们**不随 clamicro 的 npm 包发布**（`npm pack` 里没有 `plugins/`），需要单独装进 DSH 的 profile。

| 插件 | 作用 | 默认 |
|---|---|---|
| [`dsh-bridge`](dsh-bridge/) | 把 DSH 的会话状态和审批请求桥接到手机 | 状态镜像开、审批**关** |
| [`dsh-pet-dolphin`](dsh-pet-dolphin/) | Web UI 上的像素海豚；点一下打开手机看板 / 配对二维码 | 联动开 |

两个可以单独装，装一个也能用。

## 装

```bash
dsh plugin --profile web add <包名>
```

然后在 `~/.dsh/profiles/web/cordis.patch.yml` 里插一条：

```yaml
- insert:
    - id: clamicro-bridge
      name: clamicro-dsh-bridge
      config:
        origin: http://127.0.0.1:8765
    - id: pet-dolphin
      name: dsh-pet-dolphin
```

## 为什么分成两个

`dsh-bridge` 是**功能**：它拿得到会话事件、能挂住工具调用等你在手机上批准，
出问题会影响 DSH 的运行（所以它的三条硬约束单独写在自己的 README 里）。

`dsh-pet-dolphin` 是**入口**：纯浏览器端，一个字节的后端逻辑都没有，
最坏情况是它自己不显示。

两者唯一的联系是那条 `origin`。桥接不装，海豚照样能把你带到手机看板；
海豚不装，桥接照样工作。合成一个包会让「我只想要审批」的人被迫接受一只海豚。

## 版本兼容

DSH 是开发预览版，官方明说会有破坏性变更。桥接插件在运行时做**字段形状检查**
（对不上就高声警告，而不是安静地错译），详见它自己的 README。
海豚只用 `ctx.slots`，那是最稳定的那层。
