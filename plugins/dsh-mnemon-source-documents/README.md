# dsh-mnemon-source-documents

Owns managed Markdown, search, revisions and local archiving. It requires a workspace identity even when storage is shared globally.

## Use

The `dsh-mnemon` Starter installs and mounts this Source by default. The package alone does not activate an instance or select a Strategy.

For a custom Profile, mount an explicit Entry after the Host's `ctx.mnemonMemory` service is available:

```yaml
- id: personal-documents
  name: dsh-mnemon-source-documents
  config:
    dataDir: /absolute/path/to/personal-memory
```

Choose an existing data authority deliberately. Without `dataDir`, each stable Source instance uses an isolated directory under `~/.mnemon/sources/`; the default Starter supplies the existing product paths. Replacing the default Source or adding a second instance requires an explicit selection Strategy, not a second implicit default role.

Manual management can create a document without a model, but it still needs a workspace in the request scope. Standalone archiving retains content locally; cross-Source LLM distillation is an optional Host workflow.

## Permanent deletion / 永久删除

The detail page offers confirmed deletion for active and archived managed copies. Management uses `delete` with `{ id, fileRevision }`, `confirmed: true`, and the displayed index `expectedRevision`. It removes the managed Markdown file and index entry under the existing queue and store lock, releases active capacity, and restores the exact file bytes if committing the index fails. The file digest comes from the detail read, so edits made directly to the Markdown also reject stale confirmation. Unsafe paths, shared index paths and symlinks are rejected. This is not an archive: it runs without an Agent or a Memory Space write, and leaves project source files and existing Memory Space entries intact. There is no trash or undo; existing backup/sync retention rules are unchanged. The index stays at version 1 and needs no migration. As with existing multi-file mutations, process termination or a second disk failure during rollback is not a crash-atomic transaction.

The Source `manage` Action additionally accepts `action: "delete"`, `id`, `confirmed: true`, `expectedRevision`, and the target `fileRevision`. The target must belong to the execution's pinned active or archived ReadGrant. A Documents search returns its post-search index revision as `metadata.indexRevision` and each matched file digest as `items[].provenance.fileRevision`; a changed index or file rejects deletion rather than retrying automatically. Create-only workers cannot delete. The page client's optional `deleteDocument(id, expectedRevision, fileRevision)` callback preserves compatibility with custom pages that only implement create/update/archive.

详情页支持确认后永久删除活跃或归档的托管副本。管理操作为 `delete`，输入 `{ id, fileRevision }`，并提供 `confirmed: true` 与页面所示索引的 `expectedRevision`。操作沿用队列与存储锁，移除托管 Markdown 和索引记录、释放活跃容量；索引提交失败时恢复原文件的完整字节，文件摘要取自详情读取，直接编辑 Markdown 也会使旧确认失效；同时拒绝不安全路径、索引共用路径与符号链接。删除无需 Agent，也不写入记忆空间；项目源文件与已有记忆空间条目保持原样。没有回收站或撤销，已有备份与同步保留规则不变。索引仍为版本 1，无需迁移。与现有多文件修改一样，进程中断或回滚期间再次发生磁盘故障不属于崩溃原子事务保证。

Source `manage` Action 新增 `action: "delete"`、`id`、`confirmed: true`、`expectedRevision` 与目标的 `fileRevision`，只允许删除该执行固定 ReadGrant 中的活跃或归档条目。档案检索在 `metadata.indexRevision` 返回检索后的索引修订，并在 `items[].provenance.fileRevision` 返回命中文件的摘要；索引或文件变化时拒绝删除，不自动重试。仅创建档案的工作 Agent 无权删除。页面客户端的 `deleteDocument(id, expectedRevision, fileRevision)` 为可选回调，原有仅支持创建、更新和归档的自定义页面可继续使用。

## Workspace ownership / 工作区归属

Conversation tools use the session workspace (`agent.session.header.cwd`) as the Documents request scope. A shell `cd`, a Source file path, or a delegated task's initial command directory does not rebind that session workspace. Ordinary DSH subagents inherit the parent session's workspace, and delegated memory work retains the parent's pinned workspace authority.

For example, a conversation opened in project A that delegates work with an initial command directory in project B still creates Documents in A's configured storage. To create a Document for B, start a conversation in B's DSH workspace, or select B in Memory System and use its manual Project Documents management. Check the selected workspace before writing; the command's current directory is not the destination selector.

`workspace` and `workspaces` storage modes isolate data by that workspace identity. `global` and `custom` may share the physical directory, but Documents operations still require a workspace. This documents the current behavior; it adds no `workspace` argument to the conversation tool and requires no migration.

对话工具以会话工作区（`agent.session.header.cwd`）作为项目档案的请求范围。Shell 中的 `cd`、来源文件路径或委派任务执行命令时的初始目录，都不会重新绑定会话工作区。普通 DSH 子代理继承父会话工作区，委派记忆任务也保留父级固定 View 的工作区权限。

例如，在项目 A 的会话中委派任务，即使命令初始目录设为项目 B，新建档案仍进入 A 对应的存储。要为 B 建档，请在 B 的 DSH 工作区新开会话，或在记忆系统中选择 B 后使用项目档案的手动管理。写入前核对所选工作区；命令当前目录不是档案目标选择器。

`workspace` 与 `workspaces` 按该工作区身份隔离数据；`global` 与 `custom` 可能共用物理目录，但档案操作仍要求工作区身份。本说明不增加对话工具的 `workspace` 参数，也不涉及数据迁移。

## Create-only Action / 仅创建操作

The `create` Action accepts `title`, `content`, and optional `description`, `sourcePaths`, and `sessionIds`. It always creates a separate document, rejects mutation selectors such as `action` or `id`, and fails at capacity without updating or archiving existing documents. The existing `manage` Action remains available for create/update workflows. Mnemon idle review receives only the create-only document tool and skips already-covered candidates. No document format migration is required.

`create` Action 接收 `title`、`content`，以及可选的 `description`、`sourcePaths`、`sessionIds`。它始终新建独立档案，拒绝 `action`、`id` 等 mutation 选择字段；容量不足时失败，不更新或归档已有档案。原有 `manage` Action 继续支持创建和更新。Mnemon 后台审查只获得仅创建档案工具，已有内容覆盖候选时跳过。本变更无需迁移档案格式。

## Storage files

The `./contracts` entry names this Source's directory, index and lock under a storage root (`documents/`, `index.json`, `.index.lock`; each document lies in `active/` or `archived/` by its status) and exports `parseDocumentIndex`, which reads an index as a backup or sync carries it, and `summarizeDocumentIndex`, which counts one for an inventory. They are pure and browser-safe. The `dsh-mnemon` Starter's backup, sync and storage inventory use them instead of keeping copies.

## Source-owned UI and tests

The optional `./client` entry is an ordinary DSH Client plugin. This package owns its pages and `presentation/` resources and uses `dsh-mnemon/client` for the shared frame and scoped management client. It never receives a Host Context, credentials or another Source's controller.

From a source checkout, install the declared dependencies and run `pnpm verify` to check Host behavior, Source-backed page interactions and Host/browser artifacts. Unreleased SDK work consumes a packed `dsh-mnemon` peer, not repository aliases or copied root tests.

[Plugin development](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/development/extensions.md) · [中文指南](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/zh-CN/development/extensions.md)

## Editing a document created in the same execution

With dsh-mnemon 0.5.40 or later, an authorized `manage` Action can immediately update a document successfully created by `create` or `manage` in that same execution. The create-only Action itself still cannot update. This does not expand the pinned search/read grant or admit documents created by management, another workspace or another delegated execution, even when executions share the same View. Saved documents and indexes need no migration.

使用 dsh-mnemon 0.5.40 及以后版本时，获准的 `manage` Action 可立即更新同一次执行中由 `create` 或 `manage` 成功新建的档案；仅创建 Action 本身仍不能更新。读取与检索范围保持固定，不接纳管理页面、其他工作区或其他委派执行新建的档案，即使执行共享同一个 View。已有档案与索引无需迁移。
