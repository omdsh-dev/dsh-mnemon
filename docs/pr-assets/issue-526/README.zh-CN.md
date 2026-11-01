# Issue 526：隐藏记忆页面的读取

截图来自一次性 DSH 0.2.1-rc.2 WebUI，在 macOS Chromium 156 中运行本分支。模型端点为本地 loopback stub；会话与记忆内容均为合成数据。

- `chat-after-aba.png`：打开记忆系统、返回聊天后，进行了三轮 A/B/A 切换。切换期间没有发送 Mnemon RPC。
- `runtime-refreshed.png`：运行时记忆页隐藏期间通过真实 Source 写入，再次打开后新合成条目已经可见。

同次浏览器验收中，首次打开读取一次 Runtime snapshot；相同 revision 重开读取零次；点击刷新后读取一次；隐藏期间写入改变 revision 后重开读取一次。每次打开的 catalog、dashboard、status-summary 各刷新一次。读数只描述此夹具场景，没有复现 issue 所报 Windows 时延。

无头 Chromium 打开另一标签页时，原标签页的 document visibility 仍为 visible。浏览器隐藏、空闲调度、请求合并、晚到写入与恢复重试由客户端回归测试覆盖，不能由这两张截图单独证明。截图不含 bootstrap 凭据、个人数据或原始通信日志。
