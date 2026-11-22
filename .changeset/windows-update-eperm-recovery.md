---
"dsh-mnemon": patch
---

Guard Windows panel plugin updates against `ERR_PNPM_EPERM` empty-shell failures by probing directory replaceability before invoking pnpm, auto-recovering an empty shell with a clean `install` retry, rolling back `package.json`, `pnpm-lock.yaml`, and the prior package directory if recovery fails, and reporting actionable quit-and-update instructions.

加固 Windows 面板插件更新对 `ERR_PNPM_EPERM` 留空壳故障的防护：进入 pnpm 前先探测目标目录是否可替换，若安装中途失败并留下空壳则自动清理空目录并重跑 `install` 自愈，自愈再失败时完整回滚 `package.json`、`pnpm-lock.yaml` 与旧包目录，并输出明确的恢复步骤与数据安全提示。
