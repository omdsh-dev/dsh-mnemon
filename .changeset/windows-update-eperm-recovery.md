---
"dsh-mnemon": patch
---

On Windows, back up the installed plugin before an in-app update, retry installation when `ERR_PNPM_EPERM` leaves an empty package directory, and restore the old package and profile metadata when the empty shell cannot be repaired. Keep nonempty directories and surface the repair command and available backup.

Windows 面板更新前备份旧插件及 profile 元数据。`ERR_PNPM_EPERM` 留下空壳时重试安装，重试失败且目录仍为空时恢复旧包与原有元数据。保留非空目录，提供恢复命令和可用的备份位置。
