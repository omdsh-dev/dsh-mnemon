# dsh-mnemon-strategy-light-context

Optional additive projection cap for `dsh-mnemon-strategy-default-three-tier`.

```yaml
- id: mnemon-strategy-light-context
  name: dsh-mnemon-strategy-light-context
  config:
    maxProjectionCharacters: 4096
```

The cap is shared by all selected Sources and can only narrow the Host turn budget. It does not change read routes, actions, Source storage, or retrieval-result ceilings. Runtime projection has no automatic expansion route: choosing a very small cap may hide hot context, so benchmark a value appropriate for the workload. Uninstalling restores the original allocation.

## Installation and verification

The default Starter already installs this package as a disabled Entry. Use its switch under **Settings → Memory System → Memory enhancements**; do not add a second copy of the same Entry. The configuration example above is for an explicitly composed custom Profile.

Installing an npm package is not the same as activating a contribution. From a source checkout, run `pnpm verify` with declared public peers installed; use a packed peer for unreleased SDK work.

[Plugin development and independent fixtures](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/development/extensions.md) · [中文指南](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/zh-CN/development/extensions.md)
