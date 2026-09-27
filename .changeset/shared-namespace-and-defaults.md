---
dsh-mnemon: minor
---
让本地管理不再依赖迁移写入：settings 命名空间改为跨 profile 的主机级共享（与默认记忆库不随 profile 变化一致），迁移接受同主机任意 profile 的备份键并在失配时输出诊断而非静默放弃，remoteAccess 默认改为 trusted-host（trusted-host 判定仍由 DSH 把守远程边界）
