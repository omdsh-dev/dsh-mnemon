# Issue #601：恢复含只读文件的 Git 镜像

[English](./README.md)

2026-11-10 验证，基于 main `e9da7d1d717737defc088ac9afd32c4ca99ff9ef`，Node 24.22.2。所有仓库和记忆均为临时合成数据。

`pnpm run verify` 通过：根测试 2678 项通过、8 项条件跳过，工作区测试、类型检查、构建及包检查通过。[英文记录](./README.md)中的定向命令共通过 7 项检查。

三个真实 Git 场景先推送 Runtime 记忆，再用 `git gc` 生成 pack 并设为只读，随后分别模拟来源标记缺失、`.git` 被部分删除、改用另一个远端。恢复后新增内容可以推送，原始本地记忆保留；切换远端时验证旧仓库历史不会被带入新仓库。

另覆盖不存在的目录、只读 pack/idx/rev、嵌套和根目录链接。外部链接目标的字节及权限保持不变，清空镜像保留设置。

本地运行环境为 macOS；PR 将定向套件加入 Windows CI 的 Node 22.19.0 与 24，请以当前 CI 结果确认原生 Windows 验收。兜底只处理 Windows EPERM/EACCES/ENOTEMPTY/EBUSY，不跟随符号链接或 junction，有限重试仍失败则明确报错。没有存储格式或页面改动。

另有可移植的权限故障回归：只读 pack 持续触发 Windows EPERM。原递归删除实现会失败，修复后清理成功且不修改链接外部目标的权限。
