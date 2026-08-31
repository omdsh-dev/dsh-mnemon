# dsh-mnemon-strategy-scoped

Optional additive Source selection for `dsh-mnemon-strategy-default-three-tier`.

Enable the plugin alongside the default Strategy. With no configuration it includes every ready Source whose role is `working-context`, `narrative`, or `durable-evidence`, in deterministic role/key order. Configure exact `sourceKeys` to express priority; configure `writableSourceKeys` to make the remaining selected Sources read-only in the View.

```yaml
- id: mnemon-strategy-scoped
  name: dsh-mnemon-strategy-scoped
  config:
    sourceKeys:
      - source:global-runtime
      - source:project-runtime
    writableSourceKeys:
      - source:project-runtime
```

Keys name already installed Source instances; this plugin does not create or migrate storage. Uninstalling it removes only its selection contribution. If duplicate roles remain installed, the unextended default Strategy will correctly report ambiguity rather than choose by load order.
