# Composable workspace services

[简体中文](../../zh-CN/guides/workspace-services.md)

The optional workspace composition combines 16 Sources: the existing Runtime, Documents and Memory Spaces, plus 13 independently installable workspace Sources. The Starter installs their packages with optional entries disabled. Enable the Sources you need and select `workspace` explicitly. The existing three-tier composition remains the default.

## Ownership and composition

A Source owns its store, revisions, proposals, queries, mutations, lifecycle and management UI. Memory Spaces owns its Provider children. Workspace is a complete Strategy that selects public Source capabilities and budgets a single View. Its six independent enhancements are Journal capture, Review cycle, Prompt schedule, Team coordination, Focus and Learning cycle. Enhancements contribute pure policies through `dsh-mnemon-strategy-workspace/extension-sdk`; they cannot run commands, write files, send messages or borrow another Source's authority.

`dsh-mnemon-workspace-kit` publishes reusable record, file, asset and DSH adapter utilities. Plugins declare these dependencies and import published exports. The Host authenticates and routes generic operations, owns shared budgets and renders registered Source pages. It has no new business-plugin allowlist. Unloading one Source removes its capabilities while retaining its data.

## Composition settings

Open **Settings → Memory system → Memory plugins** to search installed capabilities and filter Sources, complete Strategies, or enhancements. **Discover** lists inactive optional components. Before applying a change, the manager lists requirements, Strategy switches and affected enhancements. Deactivation preserves Source data. Ambiguous providers require an explicit choice.

**Install another plugin** inspects an exact npm name, version, and actual Core/DSH peer ranges. Incompatible packages cannot be installed. Starter-registered modules can be updated directly; a new plugin needs a loadable DSH bundle. Installation uses the CLI belonging to the active Profile and reports the required restart before refreshing and activating the package.

Open **Settings → Memory System → Composition settings**. Choose the main Strategy, then use each enhancement’s row to change its switch or expand its parameters. Fields come from the installed package’s public descriptor. Preview shows source, read, action and context counts; expand a source only when its operation details are needed. Save applies the exact previewed draft. Any further edit requires a new preview. **Reload configuration** discards this editor’s draft.

## Capability map

Project notes and Playbooks support reviewed revisions. Use **Propose revision** to edit a copy while the original remains active. Compare both versions in the pending queue before approval. Model revisions require a complete read of the exact original in the current View. Approval archives that original atomically; a changed original rejects the proposal until it is reviewed again. Batch approval, rejection and archiving accept up to 50 selected, version-fenced records and never apply only part of the selection.

Learning and reviewer proposals use idempotent handoffs. An existing skill with the same reusable name receives a pending revision, preserving the active method until approval. Linked learning follows destination approval, rejection, archiving and implicit replacement. Conversation-review reminders and experience extraction have separate schedules; the independent reviewer controls its own execution interval.

| Work | Owning component | Behavior |
|---|---|---|
| Preferences and working context | Runtime | Separate user profile, scope, revision history and explicit writes |
| Project decisions and facts | Project context | Branch scopes, candidate review, repeated-signal deduplication, archive and restore |
| Searchable narratives and long-term recall | Documents; Memory Spaces | Existing document lifecycle and independent Provider-backed stores, including the actual Mnemon CLI |
| Progress, daily results and feedback | Journal | Dated and branch-attributed entries, exact feedback provenance, result capture and durable write reminders |
| Personal, work, project and daily tasks | Tasks | Review, priority quadrants, deadlines, status history, combined filters and paging |
| Reusable instructions and skills | Playbooks | Native skill discovery, configured Markdown file editing, enablement, summaries, tags and scoped category changes |
| Prompt use | Playbooks; Prompt schedule enhancement | Variable preview, reviewed authoring, one-time use, continuous/interval schedules, explicit immediate wake, usage and stop history |
| Local information | Files | Explicit roots, file-name/content search, bounded reads, cancellation and real-path checks; instruction files can be inspected through this Source |
| Conversation history | Sessions | Visible-message search, configured JSONL imports, exact bookmarks with neighboring text, completed-turn forks and aliases |
| Ordinary conversation operations | Sessions; public DSH adapter | Create, fork, rename, send, explicitly wake/steer, read native presets/models and retain request receipts |
| Team collaboration | Collaboration | Rooms, membership, directed messages/images, read receipts, presence, archives and file/service/note reservations |
| Background execution | Agent Jobs | Configured CLI adapters, frozen prompts/context/image copies, reviewed execution, queue/logs/statistics, cancellation, timeout, retry/resume and retention |
| Conversation review | Review; Review cycle enhancement | Persistent independent reviewer, visible transcript only, layered constraints, question/reset/history, severity and attributed feedback; suggestions transfer into the receiving Source's pending queue |
| Temporary notes and materials | Canvas | Durable freeform notes, referenced files and copied uploads; media preview, drag/resize/pan/zoom, scoped views, stable references and bounded model reads |
| Notifications and channel messages | Notifications | Personal inbox, draggable bell, attachments, exact reviewed targets and channel receipts through configurable HTTP bridges or typed transport adapters |
| Cross-device data | Sync | Explicit project/global export tracks, separate Git snapshots, three-way conflicts, local/remote/both decisions and separately reviewed push |
| Context and interface settings | Sessions; DSH UI | Public capacity hints, native model/preset settings and session navigation; responsive Source pages |
| Installed versions and updates | Existing Host and DSH plugin management | Independent package metadata, profile-owned updates and explicit activation |

Categories are derived from saved records. Rename/removal changes only the selected category's own project or global scope and keeps content/history. Creating an item with a new category makes that category available. Prompt filters combine name, exact category, tag and description; full text remains available through search. Immediate use always uses once; an interval of zero also means once. Date/time variables use UTC at invocation.

## Start an isolated development instance

From a clean checkout with published DSH dependencies and a local Mnemon executable:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm build:plugins
node scripts/serve-workspace.mjs --state-dir ../services --mnemon /absolute/path/to/mnemon --port 5279 --workspace-plugins
```

The supervisor copies the selected Mnemon binary, isolates `DSH_HOME` and `MNEMON_DATA_DIR`, and retains the profile, logs, database and synthetic workspace below `--state-dir`. It also writes `workspace.code-workspace`, containing this checkout and the synthetic workspace. Add the actual checkout using DSH's Add workspace button to work with the isolated Git branch. Open the exact URL printed by `dsh web` to establish browser authentication; opening the bare address first can return “authentication required”. The printed authenticated URL is local access information; keep it out of commits and screenshots.

The fixture model and CLI worker validate orchestration. Explicit test markers drive reviewed tool calls and synthetic token-usage readings. They do not validate model quality, external provider billing or third-party account delivery. `--model configured` uses the caller's configured model environment without storing credentials in the repository. Mnemon Native runs the real CLI on demand; it does not require a permanent daemon. Embedding service configuration is independent.

Send `SIGUSR2` to the printed supervisor PID to restart DSH and retain state. Stop the supervisor to stop its child services; retained data remains. Full supervisor restart reloads fixture/profile generation. The development patch explicitly enables the full composition and uses a larger shared View budget; production configurations should choose their own Sources and budget.

## Data, authority and recovery

Model memory suggestions remain pending until accepted. Session, prompt, process and external-message actions have distinct authority and exact-plan/version checks. Filesystem roots and channel origins are configured explicitly. Cross-session messages and reviewer advice preserve plugin attribution. Execution claims are persisted before effects; uncertain jobs or deliveries require inspection and are not silently replayed.

In Global and Custom storage, project context follows the current conversation. Workspace and centralized Workspaces storage expose a separate inspection selector with an alignment indicator. Store placement and project identity are distinct. Saved drafts and asynchronous responses cannot cross a changed workspace binding.

Turning off a Source retains its store. Export or back up data before changing roots; switching a root does not migrate data. Sync transfers declared tracks, keeps history, rejects foreign project identity and never pushes automatically. Interrupted schedules retain their reservations. Cleanup is explicit and preserves live jobs and recent unreferenced assets.

Native renderer integration uses public slots and services. Bookmarks use an exact Source-owned reader and a separate native conversation navigation action. The native renderer is not replaced. CLI adapters and notification bridges are explicit integration points; configure the desired installed executable or channel service. The retained local acceptance profile connects only synthetic recipients.

## Verification

```sh
pnpm verify
pnpm verify:plugins
pnpm release:intent
```

The first command validates documentation, types, deterministic builds, all package/root tests, a real Headless profile and published contents. The artifact gate installs every independent tarball without workspace links and exercises an external consumer, Starter upgrade and optional Strategy activation in real DSH. See the [retained WebUI evidence](../../workspace-context-validation.md) for actual outcomes, screenshots and limitations, and the [implementation inventory](../../plans/composable-workspace-context.md) for ownership criteria.

## Learning and feedback

Enable **Learning** and **Learning cycle** from the plugin manager when you need periodic improvement. The Source owns evidence, reviewed candidates, transfers and explicit feedback; the enhancement owns scheduling. Defaults remain the original three tiers. In the Learning page, inspect pending evidence, edit and adopt candidates, then record helpfulness or concerns after use. Reads and model-reported use are shown separately. Capture and automatic-adoption switches persist, and failed or interrupted reviews remain outstanding. Global preference adoption requires two independent human observations. Transfer to another Source creates one pending destination record and retains a durable link; it does not silently activate both copies.

Review input preserves Source-owned execution status, exit codes, severity and attribution. Assistant reports are unverified claims; failed, blocked and cancelled work does not establish a successful outcome. A zero exit code establishes process completion only. These outcomes and explicit feedback have separate counters and do not add human rounds. A reviewed replacement archives the original and resolves its review flag only after approval, retaining the correction and history.

Optional pages share host-theme surfaces, notices and metrics from `dsh-mnemon/client`; custom plugin layouts should use these browser SDK primitives. Strategy configuration supports typed boolean switches.
