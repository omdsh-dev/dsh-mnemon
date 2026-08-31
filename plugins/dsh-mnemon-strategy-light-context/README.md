# dsh-mnemon-strategy-light-context

Optional additive projection cap for `dsh-mnemon-strategy-default-three-tier`.

```yaml
- id: mnemon-strategy-light-context
  name: dsh-mnemon-strategy-light-context
  config:
    maxProjectionCharacters: 4096
```

The cap is shared by all selected Sources and can only narrow the Host turn budget. It does not change read routes, actions, Source storage, or retrieval-result ceilings. Runtime projection has no automatic expansion route: choosing a very small cap may hide hot context, so benchmark a value appropriate for the workload. Uninstalling restores the original allocation.
