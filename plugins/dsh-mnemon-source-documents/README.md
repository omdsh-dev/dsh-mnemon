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
