# Skill destination acceptance / 技能写入位置验收

Captured on 2026-11-02 from `codex/feat-540-skill-target-scope`, based on `a4ad2d6955172b936ff9328f39cc5873c3ec9c55` (v0.5.38), using the rebuilt local packages and DSH `0.2.1-rc.2` on Node `22.22.0`.

截图来自本分支重新构建的真实 DSH WebUI。使用独立临时 `DSH_HOME`、`DSH_AGENTS_HOME`、Mnemon 数据和工作区；全部技能和会话为合成数据，仅使用回环模型桩，没有付费模型调用或个人配置变更。

```sh
pnpm install --frozen-lockfile
pnpm run verify
MNEMON_E2E_PORT=42640 node scripts/serve-e2e.mjs --docs-demo=en
```

The fixture uses isolated DSH and agents homes, memory data, workspace, and a loopback model stub. The screenshots contain synthetic data and no credentials or private paths. The `project-scope-check` proposal and draft were seeded through the real Skills Source management operations, with `targetRoot: project-dsh`. The Host resolver and model prompt/record agreement are covered separately by the integration tests in `tests/skill-evolution.spec.ts`.

| Evidence | Verified behavior |
| --- | --- |
| [settings-staged.png](settings-staged.png) | Project selected with unsaved changes; Discard then restored User without writing. 项目选择暂存，放弃后恢复用户。 |
| [settings-applied.png](settings-applied.png) | Project saved through Apply; retained through a live package reload. 应用后项目设置持久化。 |
| [draft-project.png](draft-project.png) | The new proposal displays its suggested project destination and the draft adoption selector defaults to Project. 建议与草案目标一致。 |
| [adoption-override.png](adoption-override.png) | Explicit User selection overrides the draft destination at adoption. 采纳时用户手动选择优先。 |
| [adopted.png](adopted.png) | The synthetic proposal appears as adopted. 合成建议显示已采纳。 |
| [adoption-readback.json](adoption-readback.json) | After explicit adoption, the user file exists and the project file does not; the recorded draft still says project. 磁盘读回确认仅写入用户根。 |

Full `pnpm run verify` passed, including documentation checks, TypeScript, deterministic double builds, all workspace suites, the root suite (2,403 passed / 7 existing environment-dependent skips), isolated Headless activation (38 tools / 8 representative Mnemon tools), package contents, public entries, publint and attw. Published DSH source-map and Node experimental warnings remain non-fatal. No DSH dependency or CI changes are included.

Behavior coverage includes old/default configuration, all three destination settings and four storage scopes, catalog-owned project ancestry instead of task cwd, stored proposal destinations after configuration changes, explicit draft/adoption overrides, unavailable and removed projects, unwritable roots, original-root updates, and read-only/staged settings behavior. Tests were observed failing before implementation.

The default deliberately remains `user` to preserve existing writes. `storage` is explicit opt-in. Unavailable destinations fail visibly instead of silently crossing scopes. No skill migration, discovery precedence change, or automatic adoption is introduced. Filesystem permissions can change after preflight; adoption still reports its own write failures.
