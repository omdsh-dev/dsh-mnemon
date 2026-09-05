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

## Source-owned UI and tests

The optional `./client` entry is an ordinary DSH Client plugin. This package owns its pages and `presentation/` resources and uses `dsh-mnemon/client` for the shared frame and scoped management client. It never receives a Host Context, credentials or another Source's controller.

From a source checkout, install the declared dependencies and run `pnpm verify` to check Host behavior, Source-backed page interactions and Host/browser artifacts. Unreleased SDK work consumes a packed `dsh-mnemon` peer, not repository aliases or copied root tests.

[Plugin development](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/development/extensions.md) · [中文指南](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/zh-CN/development/extensions.md)
