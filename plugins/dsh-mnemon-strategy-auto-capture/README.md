# dsh-mnemon-strategy-auto-capture

Optional additive, **in-turn guidance** for `dsh-mnemon-strategy-default-three-tier`.

The default targets ready `durable-evidence` Sources whose selected View exposes the Source-local `remember` Action. Custom Sources must configure the Action ids that actually mean recording:

```yaml
- id: mnemon-strategy-auto-capture
  name: dsh-mnemon-strategy-auto-capture
  config:
    sourceKeys:
      - source:team-notes
    actionIds:
      - append
```

The plugin asks the current LLM to consider at most one qualified durable fact. It starts no background Agent or timer, executes no write during View composition, cannot expose an Action removed by the base Strategy or Host, and cannot bypass ActionOffer authorization. Model compliance and capture quality require task-level evaluation.
