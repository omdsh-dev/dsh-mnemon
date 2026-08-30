# npm 发布版 Web UI 回归

**简体中文** | [English](../en/testing-npm-regressions.md) | [开发与验证](./development.md)

本轮以 npm `dsh-mnemon@0.3.5` 对应的 `v0.3.5` 源码为基线，不使用 view-based 开发分支（当时标为 0.4.0，现计划于 v0.5 发布）。Host 固定为 npm 的非 alpha 最新版 `@deepseek-ai/dsh@0.1.1-rc.2`；Web UI 使用 `@linxin666/dsh-web-all@0.3.6`，并覆盖原包名 `@linxin666/dsh-web-ui-all@0.3.6`。

修复先在该 npm 基线上完成，再同步仍为 0.3.5 的 `main` 并重新验证 PR 代码。保留原版与补丁版的独立记录，不能将最新 `main` 当作未经修改的 npm 对照版。

## 隔离启动

在独立 worktree 中安装依赖并构建：

```sh
pnpm install --frozen-lockfile
pnpm build
node scripts/serve-web-regression.mjs --cli /absolute/path/to/test-owned/mnemon
```

脚本为每次运行创建独立 DSH_HOME、记忆目录、工作区、随机 loopback 端口及本地模型响应服务。不会修改全局 dsh、用户 profile、真实记忆或已有工作区。会话模型只返回固定测试文本，不调用付费模型；shell 工具与可选的 SSH/PTY/tunnel 安装脚本未参与此回归。`fixture.json` 记录版本、目录、测试开关和所属进程；`dsh.log` 保存本次服务日志。Ctrl-C 只停止本次测试实例，保留目录供审计。

`--package dsh-mnemon@0.3.5` 启动未修改的 npm 对照版；`--package /absolute/path/to/local-pack.tgz` 安装本地构建的补丁包。默认以 `cliPath: mnemon` 和仅对子进程生效的 PATH 验证命令名解析，而不是用绝对 cliPath 绕过问题。可通过 `--cli-name` 指定另一个配置值。

## 页面切换

1. 点击“记忆系统 → 任务看板 → 记忆系统”，每一步检查真正可见的主页面。
2. 重复多轮，覆盖有会话、任务数据、SSH、返回会话、侧栏收起再展开和刷新页面。
3. 检查会话内容、任务数据与记忆页选择仍保留，而不是只检查侧栏高亮。
4. 使用 `--mnemon-first` 覆盖先安装 Mnemon、再安装 Web UI 的顺序。

普通 npm 组合下本轮未直接复现用户报告的卡住现象；不要将其描述为“原版默认环境必现”。代码级测试证实了激活通知缺失时的状态失同步：Mnemon 私有状态仍为打开，再点入口会错误地执行关闭。

为得到可重复的浏览器前后对照，可加 `--panel-event-loss`。该开关安装一个 **仅供测试、不进入发布包** 的插件，丢弃处于打开状态的任务看板的 `dsh-panel-activate` 通知。它不替换任务看板、不修改 npm 插件代码，也不改写页面显示结果。这是明确标记的受控兼容性故障，不能用来声称用户环境确实发生了通知丢失。

对照版第三次点击仍显示任务看板；补丁版可恢复记忆系统。单元测试还覆盖 SSH、程序化 DOM 激活、同步前再次导航，以及旧 Web UI 协议中的后续刷新，防止被隐藏的面板重新抢回前台。

## CLI 检查

1. 确认测试 CLI 可执行且在脚本子进程的 PATH 中。
2. 原版 `cliPath: mnemon` 的状态页误报“未找到 Mnemon CLI”，但版本弹窗能显示 CLI 版本。
3. 补丁版两处一致；没有激活的记忆体时显示“服务就绪”，并不冒充已有健康记忆体。
4. 在测试专属目录内临时移走 CLI，点击“重新检查”应显示缺失；恢复文件后再次检查应恢复，无需重启 DSH。
5. 创建并激活一个测试原生记忆体，验证实际 CLI 状态调用与健康显示。不要操作真实记忆目录。

## 自动化验证

```sh
pnpm typecheck
pnpm exec vitest run --reporter=json --outputFile=/absolute/path/to/test-results.json
pnpm verify:build
pnpm verify:headless
pnpm verify:package
```

截图、浏览器可见状态记录及前后 JSON 测试结果应与运行的 `fixture.json` 一起保存。截图必须标明普通环境还是受控故障环境。

## 2026-08-30 公开验证记录

原版对照为未经修改的 npm 0.3.5。PR 代码提交 `5907523` 已同步 `main` 的 `05c128b`；下表的修复后截图来自该提交打出的本地 tarball，不是已发布的新版本。CLI 为官方 Mnemon 0.2.5（macOS arm64）。

| 场景 | 截图 | 可见结果 |
|---|---|---|
| 原版，普通环境 | [CLI 状态误报](../pr-assets/npm-sidebar-cli/before-cli.jpg) | 已安装 CLI，却显示“未找到 Mnemon CLI” |
| PR 代码，普通环境 | [十轮切换后](../pr-assets/npm-sidebar-cli/after-normal.jpg) | 返回记忆系统；CLI 显示服务就绪，无已激活记忆体 |
| 原版，受控通知丢失 | [返回失败](../pr-assets/npm-sidebar-cli/before-controlled.jpg) | 第三次点击记忆系统后仍显示任务看板 |
| PR 代码，受控通知丢失 | [返回成功](../pr-assets/npm-sidebar-cli/after-controlled.jpg) | 第三次点击后显示记忆系统 |

同步后的 `pnpm run verify`：541 项通过、1 项 Windows 专用测试在 macOS 跳过；106 个构建文件确定性检查、35 个 Headless 工具、10 个 Node 兼容公共入口、publint 与 attw 均通过。上游 rc.2 缺失 source map 的告警保留，不影响测试结果。普通环境再次完成十轮真实页面切换，CLI 版本检查显示 0.2.5，浏览器控制台无 error；受控故障环境确认测试插件确实丢弃通知后仍可返回。

补丁 tarball SHA-256：`0d3757f30a7f1dd79a31bec5d988bbdcdf20a9802f5b75d0e8aa9072b74b68f9`。原始日志、带本机路径的版本弹窗与 fixture 仅保存在本地；公开截图没有凭据或个人记忆。
