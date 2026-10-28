# 安装与使用

## 环境

- Node.js 24.9 或更新版本。
- 官方 `@deepseek-ai/dsh@0.2.1-rc.3`。
- DSH 插件安装命令使用 pnpm。
- 一个启用 Web UI 的 DSH profile。

插件使用 Node 内置的 `node:sqlite`。该接口在 Node 24.9 仍处于 Active development，安装验收覆盖固定的 DSH 基线；升级 Node 或 DSH 后应重新运行测试。

## 在已有应用中安装

```sh
dsh --version
dsh plugin --profile web add https://github.com/yawenzzz/dsh-agent-notify/releases/download/v0.1.1/yawenzzz-dsh-agent-notify-0.1.1.tgz
dsh --profile web
```

将 `web` 替换为目标 profile。若使用自定义数据目录，在这些命令前设置实际使用的 `DSH_HOME`。安装保存插件组合，运行中的应用需要在任务空闲后重新启动。

## 新建独立应用

以下初始化命令仅用于不存在的新 profile：

```sh
dsh --profile notify --from-default-profile web --dump-config
dsh plugin --profile notify add https://github.com/yawenzzz/dsh-agent-notify/releases/download/v0.1.1/yawenzzz-dsh-agent-notify-0.1.1.tgz
dsh --profile notify --port 0
```

端口 `0` 自动选择空闲端口。终端输出带认证信息的本地应用地址；该地址用于自己的浏览器，不应公开。

没有全局 DSH 时，用以下形式替换 `dsh`：

```sh
npx --yes --package=@deepseek-ai/dsh@0.2.1-rc.3 dsh --profile notify
```

在原生 DSH 设置中配置自己的模型后，可以正常使用 Agent。插件的“发送测试通知”可独立验证通知存储和界面，不需要模型。

## 主动通知与定时任务

Agent 获得 `notify_user` 工具，可在执行期间主动通知。发送人和来源 Session 使用真实调用上下文，通知正文只支持安全文本、加粗、内联代码及列表。

默认 Web profile 已包含官方调度服务。让 Agent 调用 `schedule_create` 创建任务，并在任务指令中要求“有有用结果时调用 notify_user”。任务到期后由 DSH 恢复对应 Session 并运行。仅在聊天中承诺“稍后提醒”不会创建任务，请在原生“自动化任务”页面检查记录。

DSH 进程关闭时不会执行检查；重新启动后，官方循环调度只补最近一次错过的发生点。调度回执代表提醒进入 Agent 收件箱，不代表通知已经发给用户。

## 通知设置

打开铃铛 → 查看全部 → 通知设置。设置通过官方 Settings 服务写入该 profile，重启后保持。

- 关闭主动通知：拒绝新提交，暂停领取后续批次；已开始投递的批次可能完成，历史记录保留。
- 静默时段：按照浏览器本地时间抑制弹出提示，消息仍入站。
- 保留期：仅清理超过保留期的已读且已发送记录；清理会同时移除相应历史投递和去重记录。
- “重试”：只适用于明确失败或等待重试的站内投递，不重新运行 Agent。
- 同时编辑设置出现冲突时，取消草稿、重新读取后再保存。

通知栏约每 2 秒同步一次版本；仅版本变化时重新读取列表。隐藏页面降低检查频率，重连或重新聚焦时立即同步。离线期间保留已经加载的内容，修改操作必须得到宿主确认。

## RSI 和多个 profile

插件只覆盖安装它的 DSH Host。RSI 项目各有自己的 profile 与进程，需要分别启用插件。当前版本不会自动改写 RSI 项目配置，也不提供管理端跨进程汇总。

## 更新与卸载

使用官方 `dsh plugin --profile <name> add <新版本 tarball>` 更新，并在空闲时重新启动。数据库版本不兼容或损坏时拒绝打开，保留原文件。

停用或移除插件后，原生会话和通知数据库继续保留。使用官方插件管理界面或 CLI 移除依赖；不要删除仍被运行进程使用的数据目录。备份时停止对应 Host，再保存完整的 `agent-notify/<profile-scope>/` 目录。

## GitHub Release 校验

每个 Release 附带 `.tgz` 和 `SHA256SUMS`，可在下载目录执行：

```sh
shasum -a 256 -c SHA256SUMS
```
