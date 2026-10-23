# Provider 视图与 OpenViking 官方插件

[English](./README.md)

记忆空间现在可以展示 Provider 在记忆之外保存的内容；Provider 也可以说明厂商自己的 DeepSeek Harness 插件正在它旁边运行。这份记录在真实的 OpenViking 服务端上展示这两点的改动前后，提供中英文截图，并核对官方插件没有任何改变。

## 环境

| | |
|---|---|
| 宿主 | DSH 0.2.1-rc.2 WebUI，浅色模式，无头 Chrome，1440 × 900 |
| 改动前 | dsh-mnemon `main`，`a7e3bc54` |
| 改动后 | 本分支，基于 #463 |
| 服务端 | 实验机上的 OpenViking 0.5.1.1；命名空间为账号 `wp5`、用户 `wp5`；一个 OpenViking 空间 **Lab machines** |
| 官方插件 | 从 npm 安装 `@openviking/dsh-memory-plugin@0.5.29`，只装在第二个配置中，连接同一服务端、账号与用户，保持默认设置 |
| 数据 | 由官方插件捕获的真实 DeepSeek 对话、通过服务端资源 API 保存为资源的一张截图，以及服务端自己的记忆抽取 |

## 改动前后

改动前，卡片只有**编辑**和**断开**，内容页只列出记忆文件。

| | English | 中文 |
|---|---|---|
| 卡片，改动前 | ![](./en-before-card.png) | ![](./zh-CN-before-card.png) |
| 内容页，改动前 | ![](./en-before-content.png) | ![](./zh-CN-before-content.png) |
| 卡片，改动后 | ![](./en-after-card.png) | ![](./zh-CN-after-card.png) |

改动后，**浏览**打开空间的视图，通过空间自己的连接读取：

- **viking:// 层级**：该空间用户的目录，以及账号的 `resources` 和 `agent` 目录。
- **资源**：服务端保存在 `viking://resources` 下的内容及其摘要；图片可以直接预览（#453 的展示部分）。
- **服务端改动**：OpenViking 记忆抽取改了什么，读取自服务端保存在每个会话归档旁的 `memory_diff.json`。这里是服务端在处理资源说明时改写了 `identity.md`。

| | English | 中文 |
|---|---|---|
| 层级 | ![](./en-after-hierarchy.png) | ![](./zh-CN-after-hierarchy.png) |
| 资源 | ![](./en-after-resources.png) | ![](./zh-CN-after-resources.png) |
| 图片预览 | ![](./en-after-resource-image.png) | ![](./zh-CN-after-resource-image.png) |
| 服务端改动 | ![](./en-after-changes.png) | ![](./zh-CN-after-changes.png) |

## 空间旁的官方插件

在运行官方插件的配置中，卡片写明插件的版本以及是否自动捕获。**浏览**中显示完整信息，都是 Provider 从插件运行中的服务读取的：自动召回开、自动捕获开、不跳过任务 Agent 会话、与空间是同一服务端、账号与用户，以及一条陈述其行为事实的说明。

由于插件会把内容捕获进该空间自己的命名空间，而 dsh-mnemon 也仍可能写入那里，卡片建议把空间设为对 dsh-mnemon 只读。在按下**设为只读**之前不会有任何改动；按下后会设置 #463 的写入策略，卡片显示**只读**，建议随之消失。

| | English | 中文 |
|---|---|---|
| 浏览中的插件卡片 | ![](./en-plugin-dialog.png) | ![](./zh-CN-plugin-dialog.png) |
| 按下前的建议 | ![](./en-plugin-suggestion-before.png) | ![](./zh-CN-plugin-suggestion-before.png) |
| 按下**设为只读**后 | ![](./en-plugin-suggestion-after.png) | ![](./zh-CN-plugin-suggestion-after.png) |

## 官方插件没有任何改变

同一个真实提示词在只装官方插件的配置中运行两次，并在官方插件与本分支并存的配置中运行一次。请求体经本地记录器保存，记录器不保存任何请求头。

| 运行 | 首个请求的工具数 | 官方插件的工具数 | 其 schema 字节数 | 其 schema 摘要 | 列出 `openviking-memory` 技能 |
|---|---:|---:|---:|---|---|
| 只有插件，第 1 次 | 49 | 21 | 26,409 | `504563036b1c1669` | 是 |
| 只有插件，第 2 次 | 49 | 21 | 26,409 | `504563036b1c1669` | 是 |
| 插件与本分支并存 | 66 | 21 | 26,409 | `504563036b1c1669` | 是 |

最后一次多出的 17 个工具是 dsh-mnemon 的 `mnemon_*` 工具，与 `main` 相同。

- **配置。** 两个配置的 `dsh --profile headless --dump-config` 中，插件的行都与它自己的 bundle 写入的一致：`id: openviking-memory-runtime`、`name: '@openviking/dsh-memory-plugin'`，没有任何配置项。
- **行为。** 两个配置中，插件为每次运行都提交了会话，服务端 `viking://user/wp5/sessions` 下逐一列出。
- **代码。** Provider 通过 Source 借出的只读视图 `profile.service` 读取七项具名设置。读取密钥、改写设置或调用方法都会使测试失败；另一项测试说明该视图拒绝调用与写入。

## 测试

- 根目录：234 个文件、2,849 项测试；`MNEMON_CLI_PATH=/nonexistent/mnemon pnpm run verify:plugins`：18 个插件仓库与 19 个打包产物；`verify:package` 与 `verify-docs` 均通过。
- `plugins/dsh-mnemon-source-memory-spaces`：30 个文件、323 项测试，其中 `provider-views.spec.ts` 覆盖只读取声明的视图、大小限制、集成状态只保留具名字段，以及只读的 profile；`provider-views-page.spec.tsx` 覆盖浏览、插件卡片，以及只有按下按钮才会设置写入策略。
- `plugins/dsh-mnemon-provider-openviking`：93 项测试，其中 `views.spec.ts` 覆盖起点、拒绝路径穿越、图片与文本预览和服务端改动；`official-plugin.spec.ts` 覆盖只读、命名空间比对，以及没有插件时状态不变。

实验脚本与记录下的请求保留在仓库之外。
