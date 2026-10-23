# Design plans

[Documentation](../en/README.md) · [文档中心](../zh-CN/README.md)

Plans written before a larger change, kept for the reasoning behind it. The guides and references describe what ships; where a plan and the documentation differ, the documentation is current. The plans are in English.

计划在较大改动之前写成，保留下来说明当时的考虑。实际发布的行为以指南与参考文档为准；两者不一致时以文档为准。计划只有英文版。

| Plan | Status |
|---|---|
| [Hermes-aligned memory providers](./hermes-aligned-providers.md) | Planned on 2026-10-23: one primary Provider with Hermes-named verbs, vendor DSH plugins bridged, automation off by default; step 0 is the adapter fixes for #452, #454 and #455 |
| [Gaps from the October 2026 review](./review-gaps-2026-10.md) | Planned; item 12 is done ([record](../pr-assets/neutral-vector-note/README.md)), and the [roadmap](../en/roadmap.md#next-gaps-from-the-october-2026-review) lists the others |
| [Skill management and self-evolution](./skill-management.md) | Implemented (experimental): the Skills page, self-evolution, evidence, evals, and a market of skills.sh, GitHub repositories, Agent Skills sites and catalogs |
| [Git repository sync](./git-sync.md) | Shipped with Git sync ([#335](https://github.com/omdsh-dev/dsh-mnemon/pull/335)); [Operations](../en/guides/operations.md#git-repository-sync) describes it. Its open questions for maintainers, such as where the credentials live and how long remote history is kept, remain open |
| [Seeing every machine's backup, and merging through review](./memory-review-flow.md) | Shipped in [v0.5.26](../en/releases/v0.5.26.md) |
| [Plugin-first interface](./plugin-first-ui.md) | The direction the plugin page and the Memory System follow. Memory Spaces contributes its own settings ([record](../pr-assets/spaces-owns-settings/README.md)); some moves for the shipped components remain, such as the Sources contributing their own Status cards |
| [Memory space media refresh](./memory-space-media-refresh.md) | Completed; see its closing section |
| [Memory space terminology](./memory-space-terminology.md) | Completed; see its closing section |
| [Status version maintenance](./status-version-maintenance.md) | Implemented and verified on 2026-09-06 |
