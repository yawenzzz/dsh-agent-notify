# DSH Agent Notify

使用发布并固定版本的官方 DSH 包；不修改或打包 DSH 运行时源码。所有应用通过官方 dsh CLI 与独立 profile 启动。通知和设置必须持久化，身份来自宿主上下文，凭据不得进入仓库或发布包。

修改后运行受影响测试、typecheck 和 build；发布前执行干净临时 home 中的 packed-install smoke，使用临时端口并等待进程清理。UI 以用户提供的通知原型为基准。输出简洁中文，每个文件一个末尾换行。
