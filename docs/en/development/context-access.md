# Structured context access

The default installation still composes Runtime, Documents and Memory Spaces: an eager bounded projection, selective document access and a namespace-scoped memory service. Optional plugins extend these access patterns. Core does not maintain a catalog of business record types.

| Boundary | Shared mechanism | Plugin responsibility |
| --- | --- | --- |
| Core contracts | Access kinds, result shapes, effects, resource references, execution status, continuations and decision traces | Resource meaning and actual I/O |
| `dsh-mnemon/source-sdk` | Scoped records, proposals and reviewed revisions; bounded files and assets; reviewed plan comparison; read coverage and cursors | Storage instance, schema, lifecycle and external adapters |
| `dsh-mnemon/extension-sdk` | Pure policies, intersected selection, fair operation budgets and projection allocation | Conditions, thresholds and instructions |
| `dsh-mnemon/client` | Collection, lookup and action panels; access inventory, resource versions, execution status and decision explanations | Specialized task, graph, skill and synchronization interactions |
| DSH Host | Authentication, concrete operation authorization, native skills, session/model lifecycle | Confirmation for external effects |

The compatibility library retains its DSH adapter and business event types. Its former record, file and page helpers forward to the public SDK. Providers remain private extensions of Memory Spaces.

## Operations and resources

A route can declare `access: { kinds: ['browse', 'read'], result: 'resources' }`. An action can declare `operation: { effects: ['execute'], execution: 'deferred', requiresReadGrant: true }` together with a separate `authority`. Descriptors do not grant permissions: Core still validates the live capabilities, offered operations, schemas, pinned grants, Host authorization and budgets.

`management.operations` independently describes human workflows; it neither registers endpoints nor offers model actions. Synchronization and skill publication keep their authenticated management paths. Human actions must declare confirmation.

Runtime has no query grant: its projection and controller-owned mutation checks are its access mechanism. Requiring a query grant for every write would erase that distinction. Proposing an inactive candidate, publishing a version, delivering a message and executing a process likewise retain different lifecycles.

Evidence can carry an exact `reference` with an ID, revision, path and media type. A `continuation` must target an offered route of the same Source, validate against its schema and consume the original call budget. A cursor grants no authority.

The record Source binds cursors to the View, scope, snapshot and query. ID reads may continue at `startCharacter`. `MemoryReadCoverage` merges actual returned ranges for one exact version; a partial or gapped read cannot satisfy reviewed replacement. The original stays active until its revision is adopted.

`assertMemoryOperationPlan` compares canonical JSON: key order is immaterial, while a changed command, argument, workspace, owner or version is rejected. The Source still recomputes the current plan and durably claims work; the helper does not promise exactly-once execution across external systems.

Accepted deferred work must return an execution identity and state. Queued/running work cannot claim committed completion; failed execution cannot claim success. These contracts are also available to non-record Sources.

## Policies without business dispatch in Core

Strategies can opt into `acceptedSourceCapabilities` and `acceptedContributionFormats: ['mnemon-context-policy/v1']`. The original explicit role/slot protocol remains valid. Workspace opts into this format and contains no journal, review, learning or skill timing rules.

`defineMemoryContextPolicy` adds the format to a pure contribution containing optional `selection` and `decisions`. Each decision identifies its Source, readiness, localized reason, required route/action IDs, and optional context demand and instruction. Core rejects invented operations and traces without an originating decision. Independently named extension slots need no Workspace edit; same-slot exclusivity remains enforced.

`composeMemoryContext` intersects Source/write restrictions, distributes operation budgets and records `applied`, `deferred`, `excluded`, `budget` or `unavailable`. Core binds instructions only after optional Source projection succeeds. Unavailable Sources cannot leave behind applied instructions. “Included” in the UI means guidance participated, not that an action ran.

## Compatibility and verification

These SDK additions belong to the upcoming Core minor release, not published 0.5.x artifacts. Use matching workspace builds until release. Existing three-tier configuration and stored record formats remain compatible. Third-party record Sources can supply their own `packageName`.

Tests cover public plugin composition, progressive read/revision fencing, reviewed plans, continuation scopes, execution receipts and shared UI interactions. See `tests/context-contracts.spec.ts`, `tests/source-sdk.spec.ts`, `tests/client-context-access.spec.tsx` and `tests/client-collections.spec.tsx`. Repository checks ensure SDKs cannot reach Core registries or Host services.

For an existing real-model acceptance profile, `scripts/serve-workspace.mjs --reuse --model configured` retains its profile, model settings and data. The isolated development server allows bounded 32 KiB request headers because accumulated loopback cookies and DSH's batch URL can exceed Node's 16 KiB default. Production startup and authentication rules are unchanged.
