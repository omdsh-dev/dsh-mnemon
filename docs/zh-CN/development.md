# 开发与验证

**简体中文** | [English](../en/development.md) | [文档中心](./README.md)

## 环境与命令

插件的 Node engine 下限为 20；锁定的完整 DSH 开发 Profile 为 0.1.1-rc.2，需要 Node `^22.19.0 || >=24.0.0`，建议开发使用 Node 24。CI 另在 Node 20 冒烟导入公开 Node 入口。

```sh
pnpm install --frozen-lockfile
pnpm run verify
pnpm run verify:plugins
```

`verify` 包含类型检查、根包确定性构建、独立插件构建、完整测试集、真实隔离 DSH Headless 和包出口/内容验证。独立插件检查在所有公开制品构建完成后分阶段执行。不要用 `pnpm -r verify` 同时清理重建制品和运行读取它们的测试；整个工作区使用 `pnpm verify`。`verify:plugins` 在工作区**外部**，基于 semver 安装的 tarball 重复验证，并测试外部 Source/Strategy/Provider/Client 消费者；还向真实 DSH 仅安装根包 tarball，从 loopback registry 解析全部默认插件，不使用工作区链接或改写 manifest。

## 仓库归属

```text
src/
  core/       contracts, View compilation, generations, turn leases
  sdk/        installMemory, validation, test fixtures
  host/       DSH lifecycle, settings, tools, RPC, worker coordination
  client/     shared workspace, settings, Source-page SDK
plugins/
  dsh-mnemon-source-runtime/
  dsh-mnemon-source-documents/
  dsh-mnemon-source-memory-spaces/
  dsh-mnemon-strategy-default-three-tier/
  dsh-mnemon-provider-*/
tests/        Host/Core/UI composition and boundary tests
scripts/      reproducible build, artifacts, Headless and Web fixtures
cordis.patch.yml   default Starter composition
```

根包拥有 Core/SDK、DSH Host 和默认 Starter，不拥有 Source 存储实现。`plugins/` 下每个目录都是可独立发布的项目。默认发行包按公开 semver 依赖它们；Source/Strategy 通过 peer 使用 Core SDK，Provider 使用 Memory Spaces SDK。peer/开发依赖会产生包管理器环依赖提示；生产代码导入边界另有独立检查。

不再保留私有工作区包、控制器转发文件、业务 binding 或 compatibility 目录。兼容指用户配置、数据与使用流程，不是延续历史内部符号。

插件 Client 测试需要根包的公开浏览器制品时，先构建根包：

```sh
pnpm build
pnpm --workspace-concurrency=1 -r build
pnpm --filter dsh-mnemon-source-runtime verify
```

声明的 peer 版本可用后，任意插件可复制到新仓库，运行自己的 `pnpm install && pnpm verify`。未发布开发使用打包制品及本地 registry 验收，不以仓库源码路径代替公开依赖。

## 测试归属与覆盖

| 边界 | 测试 |
|---|---|
| Core/SDK | 不可变 View、预算、Strategy 校验、并发回合、grant、租约、换代、清理与性能 |
| Source | 自己的控制器/存储、修订、快照、JSON 操作、Client 点击与实例隔离 |
| Provider | 驱动、凭据、真实能力与故障响应 |
| Memory Spaces | Provider 子节点生命周期、跨 Provider conformance、合并/路由/召回质量、Native 进程串行化 |
| Host | 默认组合、配置/数据范围、工具、监督流程、RPC 权限、回执与体验 |
| 制品 | 所有公开入口、独立安装/构建/测试、外部组合与浏览器制品 |

远程 Provider 使用可控 HTTP 响应；Native 进程测试使用可控命令 runner，另有可选 Windows 二进制冒烟。额外的 opt-in 测试接受经过官方 checksum 校验的 Native 二进制，创建临时记忆体，通过 View 写入、召回并删除：

```sh
MNEMON_NATIVE_TEST_CLI=/absolute/path/to/mnemon pnpm --filter dsh-mnemon-source-memory-spaces exec vitest run tests/native-integration.spec.ts
```

该测试不会发现个人数据根或安装二进制。这些检查不等于验证过所有真实远端服务或账号配置。Provider Lab 是需要明确启动的独立集成环境。

性能回归对 100 次三 Source View 组合约束 wall/CPU 时间；确定性构建比较所有生成文件 hash。二者不承诺生产网络延迟或 LLM 质量。

## 真实 WebUI

```sh
pnpm build
pnpm --workspace-concurrency=1 -r build
pnpm e2e:serve
```

夹具输出临时工作区及 loopback URL，隔离 `DSH_HOME`、`MNEMON_DATA_DIR`、工作区和模型端点。会话选择 **Mnemon E2E**：该测试自有 preset 去除 Shell 依赖，保留 Host 记忆工具。模型固定回复，因此这里只检查 UI/传输，不评价真实模型沉淀质量。Ctrl-C 停止并清理合成测试数据。

检查无会话 Sidebar、所有一级/二级页面、Runtime 增改删与清空分支、Documents 创建/搜索/读取、Provider 设置与发现、激活、故障态、取消弹窗、存入记忆、布局切换、locale、返回聊天后交互恢复。读写/删除使用临时 Provider 或受控夹具，不能对个人记忆做实验。

另检查 `displayMode` 实时切换：Sidebar 与 Builtin 不得同时挂载，二者使用同一组 Source 页面。Builtin 的全局/工作区/自定义范围读写及任务遵循所属会话，隐藏范围控件，切换会话时清理旧数据与编辑器。验证旧 `buildin` 规范化，以及原生 Sidebar 皮肤和已支持布局插件下的折叠图标。

[2026-08-31 main rebase 验证记录](../pr-assets/main-rebase-20260831/README.md)列明精确 revision、完整测试、独立制品和真实双入口验证及其限制。

已发布 Taskboard/SSH 组合、CLI 命令名解析、安装顺序与受控面板通知丢失，使用独立的 [npm WebUI 回归夹具](./testing-npm-regressions.md)。夹具同时支持当前本地 Starter 与十三个插件的组合，以及已发布对照包。

DSH rc.2 对 Bundle 变化的 Client 卸载并不完整；修改 Client 包/locale 注册后刷新页面。Mnemon 普通设置仍实时生效。区分上游 Profile/传输告警与 Mnemon 故障，不隐藏控制台。

## DSH 源码验证

CI 还构建源码版 `dsh-v0.1.2-alpha.1`。已有 Harness 构建目录时：

```sh
DSH_SOURCE_ROOT=/absolute/path/to/deepseek-harness pnpm dsh:link-source
pnpm_config_verify_deps_before_run=false pnpm verify
pnpm dsh:restore-registry
```

Harness 先运行自己的 `pnpm install --frozen-lockfile && pnpm build:lib`。链接仅更改生成的 `node_modules`，不改提交的依赖版本。本次调用关闭 pnpm 的运行前依赖验证，避免嵌套脚本自动恢复 registry 链接。rc.2/alpha RPC 与服务协议有专项测试；CI 有 alpha 任务，不代表当前本地运行已经使用 alpha。

## 成组 beta 发布

`pnpm release:check` 只读检查根包与十三个官方插件、精确内部依赖/peer 版本、Release tag 和 `publishConfig.tag`。成组版本约束只针对官方发行组合，不限制第三方仓库。Beta 依赖显式固定已验证的预发布版本；`^0.4.0` 无法安装 `0.5.0-beta.1` SDK。

`node scripts/release.mjs --pack` 将所有已构建制品打包到输出的临时目录，不执行发布。GitHub Release 流程先执行 `verify` 与外部制品验证，全部打包成功后，依次发布十三个插件，最后发布 Starter。预发布要求 GitHub prerelease 标记，并显式使用 npm `alpha`、`beta` 或 `rc` tag；正式版要求 `latest`。直接发布也继承包内显式的 `publishConfig.tag`。不能只发布根包。

`--publish` 是显式 registry 写操作，要求 `RELEASE_TAG` 和 `RELEASE_PRERELEASE`。npm 发布不是事务：任何失败都会停止流程，不再发布剩余包。保留日志/制品，确认已发布的不可变版本，然后准备新的完整成组版本，不能覆盖或撤销已发布版本。所有包均可获取后，才算发布完成。开发验证不会创建 Git tag、GitHub Release 或 npm 发布。

## 文档、存储与历史证据

保持中英文页面一致、公开示例可执行。Mermaid 表达归属和流程；真实截图位于 `docs/assets`。不保留空目录占位或历史转发文件。

没有明确迁移方案与测试前，保留持久格式及配置键。存储改动须验证锁、原子 rename、修订、损坏输入和复制数据根上的升级/回退。

v0.3 benchmark 是冻结的历史结果，不是本架构的性能证明。失效的可执行评估框架已移出工作树；[发布记录](./releases/v0.3.0.md) 链接到固定版本历史源码。当前验收入口为上述脚本。
