# Roadmap

[简体中文](../zh-CN/roadmap.md) | **English** | [Documentation Center](./README.md)

The Roadmap records work beyond the current implementation; it is not a commitment to deliver these capabilities. Data safety, recoverability, and verifiability take priority.

## Release boundaries

- **v0.4: Sidebar-first.** Retain the v0.3 architecture and memory formats. v0.4.0 initially removed builtin presentation; current development restores optional `displayMode: builtin` as entry placement sharing the Sidebar UI, not a separate layout. The [v0.4.0 release notes](./releases/v0.4.0.md) remain the historical release record.
- **v0.5: complete view-based upgrade, planned.** Develop and verify the architecture upgrade separately on top of the shared workbench. This work is not included in v0.4.0; publishing v0.4 does not declare it ready.

## P0: Reliability and Recoverable Scheduling

- [ ] **Persist background-review watermarks**: save activity signals, the latest processed checkpoint, scoring version, and run state by root session; restore unprocessed activity after restart or resume.
- [ ] **Idempotent checkpoints**: assign a stable identifier to each review input to prevent timeouts, retries, or duplicate hooks from producing duplicate Documents.
- [ ] **Backoff, circuit breaking, and manual retry**: apply bounded backoff after consecutive failures, show the reason on the Status page, and allow explicit recovery.
- [ ] **Deterministic sensitive-data defenses**: add secret/credential pattern detection, size limits, and audit receipts beyond LLM admission.
- [ ] **Automated real-WebUI E2E**: isolate DSH_HOME, storageRoot, workspace, and the port; cover light tasks, score-based review, cancellation, and failures without partial writes.
- [ ] **Correct cold-reference paths**: under every storage scope, write resolvable references that match the actual managed path.

## P1: Long-Term Maintenance and Data Operations

- [ ] **Dynamic Memory Space Provider Catalog**: register Provider descriptors, connection schemas, credential redaction, discovery, and Factories together so a new Provider plugin needs no built-in union or WebUI edit.
- [ ] **Kernelize every path and persist Receipts**: converge compatibility-controller flows on Plan/Execute/Receipt and persist bounded Receipts for audit, retry, and comparison across restarts.
- [ ] **Strategy artifact promotion pipeline**: provide schema/type checks, golden replay, shadow, canary, signing, version rollback, and metric comparison so model-generated Strategies reach the active topology only as controlled artifacts.
- [ ] **Long-term organization across sessions**: trigger an independent organization process based on time and the number of new sessions instead of reusing per-turn review.
- [ ] **Mnemon GC / forget review**: generate candidates for decay, conflicts, obsolete content, and orphaned relationships, then present evidence before deletion.
- [ ] **Consistent backup and recovery**: provide unified snapshots, checksums, and recovery rehearsals for the registry, multiple databases, Runtime, and Documents.
- [ ] **Repair and rebuild tools**: detect damaged JSON, missing projections, orphaned Documents, missing databases, and registry/disk inconsistencies.
- [ ] **Schema migration**: add explicit upgrade and rollback strategies for Runtime, the Documents index, and the Memory Space registry.
- [ ] **Compatibility matrix**: document and automatically test supported combinations of DSH, the Mnemon CLI, Node, and data formats.
- [ ] **Cordis / DSH capability contract tests**: add host-integration coverage for service injection, hot reload and disposal, and late-registered tools; in particular, verify that Mnemon's schema-validated one-run result tool remains reachable inside a subagent while `toolFilter` still hides every non-allowlisted capability, using [issue #14](https://github.com/omdsh-dev/dsh-mnemon/issues/14) / [PR #17](https://github.com/omdsh-dev/dsh-mnemon/pull/17) as the regression scenario.
- [ ] **Explicit host capability declarations**: have Cordis / DSH authoritatively expose writability, trusted control-plane access, directory selection, and structured-output support, gradually replacing plugin-side permission inference from loopback state, service names, or transport location.
- [ ] **Explicit Documents workspace ownership**: record the source workspace under shared storage scopes or provide a configurable isolation strategy.

## P2: Observability, Experience, and Release Engineering

- [ ] **Background-review history**: show recent scores, checkpoints, waiting/running/failed states, worker receipts, and resulting changes.
- [ ] **Switch to DSH's shared directory picker** (blocked on [dsh-external/issues#603](https://github.com/dsh-external/issues/issues/603)): custom storage temporarily uses a manually entered Host path because remote `browse` deployments cannot invoke the `native` picker; once DSH exposes a reusable directory-picker service for plugins, move to the provider-selected native / browse flow and retain manual entry only as a fallback if needed.
- [ ] **Complete internationalization**: cover commands, tool cards, Host errors, compatibility default metadata, and confirmation copy.
- [ ] **Multi-Memory-Space E2E**: cover automatic space creation, cross-space recall, one-pass migration routing, multiple relationship types, merge, and controlled forget.
- [ ] **URL-subpath deployment matrix**: add real reverse-proxy E2E for the DSH shell, static assets, plugin assets, RPC/API, and WebSocket under `/prefix/`; keep the dsh-mnemon client transport-neutral through the host `connection`, while the host supplies one coherent base URL so root-relative assets cannot leave the deployment half functional.
- [ ] **Capacity and fault injection**: exercise real USER/MEMORY boundaries, Document LRU, revision conflicts, CLI timeouts, and mid-operation Host restarts.
- [ ] **Documentation consistency checks**: add relative links, external links, bilingual file mirroring, configuration-key matching, and code-block matching to CI.
- [ ] **Release completion**: establish stable versions, a changelog, upgrade/uninstall/data-retention guides, artifact checksums, and a minimum-support policy.

## Explicitly Out of Scope

- Automatically executing code in the Host immediately after a model generates it. The current release provides manifests, permission wrapping, replay, and Kernel-validation primitives only.
- Treating a Cordis isolate as a security sandbox for untrusted plugins. Third-party executors and Strategies must still come from trusted packages.
- A Runtime `daily` target; only `user` and `memory` are currently maintained.
- A proactive notification daemon without explicit delivery semantics; Mnemon remains an on-demand pull system.
- Declaring internal RPC or `MnemonClient` to be a stable public SDK.
- Automatically deleting the source Memory Space database; merge currently preserves the source files.
