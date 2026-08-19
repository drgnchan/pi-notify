# pi-notify

为 [Pi](https://pi.dev) 提供低打扰、可配置的手机与桌面通知。适合 Pi 在后台执行长任务时，在真正需要关注的时刻通过 Telegram 提醒你。

## 功能

- Pi 完全停下并等待输入时通知
- assistant 中途提问或请求确认时通知
- Telegram HTML 卡片：项目、会话、耗时、回复摘要和当前状态
- 短任务过滤，默认运行不足 20 秒不发送完成通知
- 隐私模式：仅状态、摘要或较完整内容
- Telegram 请求失败自动重试（2、5、15 秒）
- 清理 Markdown，并在摘要中隐藏代码块
- 支持桌面通知、终端响铃、OSC、声音、KDE Connect
- 支持 ntfy、Bark、Server酱和 PushPlus webhook
- Bot Token 不在状态信息中显示；配置文件权限自动设为 `0600`

## Telegram 推送示例

```text
✅ Pi 已完成 · ⏱ 1分42秒

📁 pi-notify · 🧵 通知体验优化

💬 回复摘要
已完成通知格式优化，测试全部通过。

🟢 正在等待你的输入 · 🕒 23:28
```

## 安装

从 GitHub 安装：

```bash
pi install git:github.com/drgnchan/pi-notify
```

临时试用：

```bash
pi -e git:github.com/drgnchan/pi-notify
```

安装后重新启动 Pi，或在现有会话执行：

```text
/reload
```

## 配置 Telegram

1. 在 Telegram 中联系 [@BotFather](https://t.me/BotFather)，使用 `/newbot` 创建机器人并取得 Bot Token。
2. 给新机器人发送一条消息。
3. 使用 [@userinfobot](https://t.me/userinfobot) 查询你的 `chat_id`。
4. 在 Pi 中执行：

```text
/notify webhook telegram <BOT_TOKEN> <CHAT_ID>
/notify webhook test
```

> Telegram Bot API 必须能从运行 Pi 的机器访问 `api.telegram.org`。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `/notify` | 查看当前配置 |
| `/notify test` | 测试全部已启用通道 |
| `/notify on\|off` | 通知总开关 |
| `/notify mode settled\|message\|both` | 设置触发时机 |
| `/notify min-duration <秒>` | 设置完成通知的最短任务时长 |
| `/notify privacy status\|summary\|full` | 设置发送到手机的内容级别 |
| `/notify retry on\|off` | 开关网络失败重试 |
| `/notify webhook test` | 只测试 webhook |
| `/notify desktop on\|off` | 开关桌面通知 |
| `/notify bell on\|off` | 开关终端响铃 |
| `/notify osc on\|off` | 开关终端 OSC 通知 |
| `/notify sound on\|off` | 开关提示音 |

### 触发模式

- `settled`：Pi 完全停止并等待输入时通知，默认值。
- `message`：assistant 发来问题或请求确认时通知。
- `both`：以上两种场景都通知。

### 隐私模式

- `status`：只发送完成/关注状态，不包含 assistant 内容。
- `summary`：发送清理后的摘要，最多 220 字，默认值。
- `full`：发送清理后的较完整内容，最多 1800 字。

## 其他手机推送服务

```text
/notify webhook ntfy <TOPIC_OR_URL>
/notify webhook bark <BARK_KEY_OR_URL>
/notify webhook serverchan <SENDKEY>
/notify webhook pushplus <TOKEN>
```

## 配置与安全

配置保存在：

```text
~/.pi/agent/assistant-notify.json
```

该文件包含 webhook 凭据，插件会将其权限设置为 `0600`。请勿提交、复制或公开这个文件。仓库的 `.gitignore` 也明确排除了本地配置和环境变量文件。

Pi 扩展拥有当前用户的系统权限。安装第三方扩展前应先检查源码。

## 开发

本地加载：

```bash
pi -e ./index.ts
```

无 LLM 调用地检查扩展是否可加载：

```bash
pi -e ./index.ts --list-models
```

## License

MIT
