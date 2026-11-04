# 已安装 alpha 宿主验证

**简体中文** | [English](./README.md)

2026-11-04 使用 Node 24.22.2、DSH 包的物理规范路径并清除 `NODE_PATH` 验证。安装、profile 与数据均为临时隔离夹具，没有修改上游包源码。调查基于 Mnemon `54cca5fc2e552483ae13e68565564149fd03a1df`；本组改动仅涉及测试、CI 与文档。

## 两类不同故障

从 npm 全新安装 DSH `0.2.2-alpha.2`，实际依赖已不同于 11 月 2 日验收时的安装：

| 依赖 | 早期安装 | 全新安装 |
|---|---|---|
| `@deepseek-ai/cordis` | `4.0.6-alpha.1` | `4.0.6-alpha.2` |
| `@deepseek-ai/cordis-plugin-loader` | `1.0.7-alpha.1` | `1.0.7-alpha.2` |
| `@deepseek-ai/cordis-plugin-include` | `1.0.11-alpha.1` | `1.0.11-alpha.2` |
| `@deepseek-ai/cordis-plugin-timer` | `1.1.8-alpha.1` | `1.1.8-alpha.2` |
| `@deepseek-ai/schemastery` | `3.18.6-alpha.1` | `3.18.6-alpha.2` |

DSH 清单的 `~` 范围允许解析到这些版本。npm 上 Cordis `4.0.6-alpha.2` 发布时间为 `2026-11-03T07:09:41.288Z`，Loader `1.0.7-alpha.2` 为 `2026-11-03T07:09:54.311Z`。两次安装的 `dsh-app-boot@0.2.2-alpha.2`、`dsh-config-editor@0.2.2-alpha.2` JavaScript 制品逐字节相同。

1. **夹具依赖不匹配：**`tests/fixtures/view-management.ts` 从开发安装加载 Loader，而 installed-host resolver 提供被测 Host 的 Cordis。新 Cordis 把 Fiber 作为 `internal/config` 首参传入，不再使用旧的接收者绑定，旧 Loader 因此在 `this.parent.fiber` 失败。夹具改用其他真实宿主测试共用的 `requireDsh`。新 Loader 还以 `commit` 取代 `write`；夹具观察实际持久化方法，不替换其实现，也不放宽“不写入”的断言。
2. **上游宿主真实不兼容：**新 Cordis 向 `internal/update` 提供 `(config, next)`，固定版 alpha.2 app-boot 仍注册 `(config, noSave, next)`，其内嵌 Include 也早于 Loader 的 `commit` 契约。官方 ConfigEditor 路径报 `next is not a function`；直接更新插件可能报 `entry.parent.tree.commit is not a function`。两种错误都不需要加载 Mnemon。最小探针中普通启动成功，因此启动通过不能替代设置更新验证。

[PR #552 CI](https://github.com/omdsh-dev/dsh-mnemon/actions/runs/41637532177/job/125922392789) 与 [PR #555 CI](https://github.com/omdsh-dev/dsh-mnemon/actions/runs/41670139574/job/126035995212) 都有 35 个失败：View management 17、profile reconciliation 9、plugin-manager integration 5、bundle activation 4。仅修改夹具无法解释全部四个 bundle 失败。

## 隔离验证

[纯宿主探针](./host-update-probe.mjs)启动一个合成插件并更新其配置，不导入 Mnemon。既有 `tests/fixtures/bundle-activation.mjs` 的 settings 用例覆盖官方 ConfigEditor、持久化与重启路径。

| 安装 | 纯宿主更新 | ConfigEditor 保存并重启 |
|---|---|---|
| 缓存 alpha.2，早期依赖 | 通过 | 通过 |
| 全新 alpha.2，当前依赖 | 缺少 `commit`，失败 | 缺少 `next`，失败 |
| 隔离 alpha.2，固定上述五个早期依赖版本 | 通过 | 通过 |
| 官方 alpha.3，当前依赖 | 通过 | 通过 |

临时固定版本仅用于诊断，没有作为 override 发布。CI 改用官方 npm `alpha` 目标 `0.2.2-alpha.3`；这**不会**修复已有 alpha.2 安装，也不代表其全新依赖组合可用。

复现时，`DSH_HOST_ROOT` 指向安装的物理目录，`NODE` 指向 Node 24.22.2：

```sh
env -u NODE_PATH "$NODE" --expose-internals docs/pr-assets/issue-554-alpha-host/host-update-probe.mjs "$DSH_HOST_ROOT"
env -u NODE_PATH "$NODE" --expose-internals tests/fixtures/bundle-activation.mjs "$DSH_HOST_ROOT" settings
env -u NODE_PATH DSH_HOST_ROOT="$DSH_HOST_ROOT" "$NODE" node_modules/vitest/vitest.mjs run --config scripts/installed-dsh.config.ts
```

## 旧会话读取与回归覆盖

Alpha.3 已可自行读取合法历史 v2 子 Agent descriptor。repair 测试先使用 Host 的公开 payload validator，再验证 v2 descriptor 原样保留，或旧 Host 的具体拒绝结果。repair CLI 仍须生成精确 v3 副本、保持输入字节不变并满足幂等性；不支持的 descriptor 组合、重复键与坏数据继续测试拒绝。

修改前的 alpha.3 定向运行有五个失败：一个 View catalog 用例与四个 v2 descriptor 用例。修改后，在 DSH `0.2.0-rc.2`、`0.2.1-rc.2`、`0.2.1-rc.3`、`0.2.1-rc.5`、`0.2.2-alpha.3` 上，View management、profile reconciliation、plugin-manager integration、legacy repair 合计 182 项均分别通过。本地默认安装为 rc.2；rc.5 验证明确使用隔离的已安装 Host。根 typecheck、根构建与四个公开 SDK 构建也通过。

随后已安装 alpha.3 的全套根测试通过：**166 个文件通过、2 个跳过；2,463 项测试通过、7 项跳过**。文档链接与 `git diff --check` 也通过。这些证据不能替代组合后兼容 PR 的最终 CI 或打包 Source 所有权验证。
