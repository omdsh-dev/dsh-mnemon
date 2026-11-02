# 当前 DSH 兼容验证证据

**简体中文** | [English](./README.md)

2026-11-02 在 macOS arm64 上核验。生产代码冻结于 `e130786085dfb93d006c8769ccaaff72c6b0764e`，叠加在独立的 [#541 修复 PR #545](https://github.com/omdsh-dev/dsh-mnemon/pull/545)（`eea8c306c9e7cb5fb2408696b7dc6bfa52a86ef9`）之上；其 main 基线为 `a4ad2d6955172b936ff9328f39cc5873c3ec9c55`。后续改动只补充验证、文档和 CI 运行时版本，不改变已冻结的生产代码。[validation.json](./validation.json) 记录精确版本、数量与限制；[artifacts.json](./artifacts.json) 固定 19 个候选 tarball 的 SHA-256 和大小。这些本地候选仍沿用现有版本号，不代表发版或发布到 Registry。

## 上游与契约

[npm 元数据](https://registry.npmjs.org/@deepseek-ai%2Fdsh) 的 `latest`、`next` 均指向 `0.2.1-rc.5`（10 月 29 日发布），`alpha` 指向 `0.2.2-alpha.2`（10 月 27 日发布）。两者仍为预发布版本。官方说明：[rc.5](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.5)、[alpha.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-alpha.2)。RC 成为新的开发基线，alpha 是额外的精确版本验证目标。

已发布 alpha 的 `ToolRuntime` 提供 `setExecutor()`，接受 `{ calls: [{ type: 'tool-call', id, name, arguments }], agent, signal }`，其中 `arguments` 是 JSON 文本。Mnemon 用该公开能力判别 API，要求 `results` 恰好包含一项、`callId` 匹配请求且 `result.isError` 为布尔值。调用抛错或结果不完整时拒绝准入，不会再用另一种 API 形状重试。真实 native/PTC 测试还检查权威的内外层结果、guard 与执行前后策略。测试组合加载已发布的 native/PTC 插件；真实 Web profile 另行验证生产组合。

无副作用的准入探测不传入伪造的模型步骤日志。PTC 仍会写自己的审计事件，因此必须配合 [PR #545](https://github.com/omdsh-dev/dsh-mnemon/pull/545)，让准入留在真实回合内并在 `turn/end` 前完成。本 PR 不修复独立的 [#542](https://github.com/omdsh-dev/dsh-mnemon/issues/542) View 缺失情形。

## 已完成检查

| 检查 | 结果 |
|---|---|
| 完整 `pnpm run verify`，rc.5 / Node 22.22.0 | Root：2,417 通过、7 跳过。组件：745 通过、3 跳过。文档、类型、两次确定性构建、组件构建、Headless、包检查、publint、attw 均通过。 |
| 已安装 0.2.0-rc.2 / Node 22.22.0 | 2,414 通过、10 跳过；保留原有仅 0.2.1 功能的跳过。 |
| 已安装 0.2.1-rc.3、rc.5 / Node 22.22.0 | 各 2,417 通过、7 跳过。 |
| 已安装 0.2.2-alpha.2 / Node 24.9.0、24.22.2 | 两个运行时的根测试各 2,417 通过、7 跳过。较低版本结果不代表完整 macOS Source 兼容性。 |
| Alpha 准入与持久化回合回归 | 适配前：16 失败、4 通过。适配后：20 通过，包含 #545 的 14 个准入、排空和重读场景。适配契约：11 通过。 |
| 独立打包制品，rc.5 / Node 22.22.0 与 alpha.2 / Node 24.22.2 | 两组均通过全部 18 个独立插件仓库、19 个制品的构建、类型、测试、外部消费者、真实 Headless 安装与可选 Strategy 组合检查。 |
| 公开入口 / Node 20.20.0 | 15 个 Node 入口、37 个公开类型依赖、22 个浏览器侧声明及 1 个可执行 help 入口通过；不代表 Host 可在该版本运行。 |
| 延迟官方模型目录 | rc.3、rc.5、alpha.2 均通过合成的 3.6 秒首个响应，未发送外部模型请求。[回执](./model-directory-alpha2.json) 记录实测路径。 |

打包升级检查在隔离的旧版本安装中写入合成 Runtime 记忆，先证明旧 Host 会将它发送给模型，再升级并确认新 Host 仍发送同一条目、Runtime 文件逐字节不变。已有设置、保留备份恢复与重启检查也通过。从 `0.5.37` 的升级覆盖 rc.5 / Node 22.22.0 及 alpha.2 / Node 24.9.0、24.22.2，均使用 [artifacts.json](./artifacts.json) 中相同的 Node 22 构建包。完整 alpha 制品验收还覆盖带合成记忆的 `0.5.29` 升级。

官方 Web profile 在 [rc.5](./stock-web-rc5.json) 与 [alpha.2](./stock-web-alpha2.json) 上，用链接的已构建 Starter 成功运行随 Host 发布的 `standard`、`ptc` 预设。[打包 alpha 回执](./packed-web-alpha2.json) 进一步在 Node 24.22.2 中安装冻结的 Node 22 构建 Starter。每个预设都收到 Mnemon 指南和记忆快照，完成真实 `mnemon_status`、`mnemon_document_search` 读取且没有工具错误，并在三次脚本模型请求后结束回合。未调用真实推理服务。

## Node 24 限制与解决结果

Alpha Host 声明 Node `>=24.9.0`，但这不等于完整 macOS 工具链的实测下限。Node 24.9.0 的独立安装选择 tsdown 0.22.2，三个 Source 的类型检查拒绝当前 `neverBundle` 类型；当前 tsdown 在 24 系列需要 Node `>=24.11`。Node 24.11.0 的类型检查通过，但三个 Source 测试在删除或替换目录符号链接时失败，涉及 Runtime archive、Memory Spaces 原生包和 Skills Trash 恢复。

最小 [Node 复现脚本](../../../scripts/observe-node-symlink.mjs) 只在临时路径调用 `mkdirSync`、`symlinkSync(target, link, 'dir')` 与 `rmSync(link)`。[结果](./node-symlink.json)：Node 22.22.0、24.22.2 仅删除链接；Node 24.9.0、24.11.0 抛出 `ERR_FS_EISDIR`；四组都保留目标目录。没有给 Source 添加规避逻辑。Node 24.22.2 通过完整独立制品和 Source 测试，因此作为 macOS alpha 建议版本及 alpha CI 的精确锁定版本。

## 复现与限制

先构建，再对每个目标使用独立的已发布 DSH 安装：

```sh
pnpm run verify
DSH_HOST_ROOT=<installed-dsh-package> pnpm run test:installed-dsh
MNEMON_E2E_DSH=<installed-dsh-package>/lib/bin.js node scripts/verify-plugin-artifacts.mjs --skip-build --keep
node scripts/verify-web-profile.mjs <installed-dsh-package> <receipt.json>
node scripts/verify-web-profile.mjs <installed-dsh-package> <receipt.json> file:<starter.tgz> <candidate-registry>
node scripts/observe-node-symlink.mjs
```

Alpha 命令使用 Node 24.22.2。打包 Web 形式需要提供冻结组件 tarball 的临时候选 Registry；Headless 制品验证器会自行创建回环 Registry。全部 profile、设置和记忆都是临时合成夹具。DSH 会打印临时回环认证 URL，因此原始日志只保留本地；已提交回执不含 token、私有路径、私有数据或模型凭据。检查结束后销毁夹具。

这些是协议与包验收，不是浏览器视觉/UI 操作验收。Web 夹具关闭无关的原生目录选择器和自动空闲审查；真实 guard 准入与 PTC 历史另由完整 Host 测试覆盖。Headless 冒烟关闭无关 shell、权限、PTC 入口，不能代替 Web PTC 检查。未使用个人 Desktop profile、付费推理或第三方 Provider 账号。提交后的 PR head 仍须通过远程 GitHub Actions；本记录不证明未来 alpha 或其他未测平台的兼容性。
