# File search Source

This independently installable Source searches literal content and file names in the current workspace and explicitly configured `roots`. Documents are the default; selecting all types includes source code. Search uses bounded argv-only ripgrep calls, with cancellation and a fifteen-second outer deadline. No file body enters eager context.

Read grants pin canonical directories. File excerpts are bounded, and credential paths and symlinks leaving a registered directory are refused. Saved searches use Source-owned records and the normal proposal, approval, history and archive workflow.

## Installation and configuration

Install `dsh-mnemon-source-files` alongside `dsh-mnemon`. Enable a Strategy supporting `file-search`, such as `dsh-mnemon-strategy-workspace`. Optional configuration: `dataDir`, `roots` (absolute directories), and `rgPath`. An omitted or empty `rgPath` uses the platform binary declared by the workspace utility package; an explicit path or command overrides it. No system ripgrep installation or implicit home-directory scan is required.

The Files page supports content/name search, documents/all types, an optional exact registered directory, cancellation and line-numbered excerpts. Source routes are `find`, `read-file`, `roots`, and the record-library `search`. Management live reads use the `lookup-` prefix. Results report bounds; refine the query when truncated.

Run `pnpm verify` in this package to typecheck, test real file boundaries and build both artifacts.

## 中文

文件检索是可独立安装的 Source。默认在当前工作区和明确配置的 `roots` 内检索文档，也可显式选择所有文件类型。支持文件名、字面正文检索、取消、行号片段和保存检索条件；不会提前注入文件正文。

读授权固定到目录真实路径。读取范围、文件大小、结果数量和执行时间均有上限，禁止凭据路径及指向登记范围外的符号链接。保存的检索条件使用本 Source 的审核、历史和归档流程。

安装本包与 `dsh-mnemon`，启用支持 `file-search` 的策略即可。可选配置为 `dataDir`、绝对目录数组 `roots` 和 `rgPath`。`rgPath` 留空或省略时使用工具包声明的平台程序，显式路径或命令仍可覆盖；无需在系统中另装 ripgrep。此插件不会隐式扫描用户主目录。页面结果出现截断提示时，应缩小范围后继续检索。
