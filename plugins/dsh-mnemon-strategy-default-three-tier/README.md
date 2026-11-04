# dsh-mnemon-strategy-default-three-tier

The **Layered strategy** (分层策略 in the Chinese interface), dsh-mnemon's default
main strategy: runtime memory stays resident, while Project Documents and Memory
Spaces are read on demand. It is one ordinary Cordis Strategy plugin that consumes
public Source facts and proposes that View; it imports no Source implementation
and grants no authority. Its type id is `default-three-tier`.

`compose` is pure. `createTurn` owns the executing turn's retrieval policy:
one Documents query (4 results / 6,000 content characters), two different Recall
queries sharing 6 results / 4,800 content characters, duplicate replay,
relevance admission, and one Related traversal from admitted evidence.
Named tools and generic View routes use the same state. Independent child turns
never share quotas, even when they inherit the same immutable View.

Source schemas and provenance are the public read protocol. This plugin formats
the familiar compact model response; Core retains the evidence/authority envelope
for auditing without serializing it again into every model tool result.

This plugin also owns the Layered strategy's instructions and reminders.
They are pinned in `ViewSpec.guidance`, separately from Source projections. The
Host renders them for the selected turn; a different Strategy does not inherit
this plugin's instructions. DSH-assisted write/archival workflows remain Host
adapters over Source operations; Core does not schedule autonomous maintenance.

Its manifest declares `workflows: ['idle-review', 'runtime-capacity']`, the
background work the dsh-mnemon Host runs for the turns it composes: idle review,
and Runtime capacity maintenance, which the Host applies to named tools, generic
View Actions, child writes and browser management. A Strategy built by spreading
this manifest copies the declaration; `workflows: []` keeps it out of both.
`threeTierActionWorkflow` in `./extension-sdk` is kept for existing callers and
deprecated; the Host reads the declaration instead. A maintenance operation
retains its exact Source instance, scope, revision and authority;
archive destinations stay within the selected writable Source and pinned
namespaces. A browser write needs no conversation. One eligible destination
requires no model; routing and local profile compaction use a clean workspace
task Agent when needed. Sources retain their independent storage protocols,
and other Strategies do not acquire this workflow implicitly.

## Additive plugins

The selected complete Strategy still produces one View. Its optional, exclusive
slots are public through `dsh-mnemon-strategy-default-three-tier/extension-sdk`:

| Slot | Value | Optional plugin |
| --- | --- | --- |
| `selection` | Ordered Source keys and an optional writable subset | `dsh-mnemon-strategy-scoped` |
| `projection` | A ceiling within the Host's projection-character budget | `dsh-mnemon-strategy-light-context` |
| `capture` | In-turn recording guidance, explicit recording Action ids and optional Source keys | `dsh-mnemon-strategy-auto-capture` |

Enable these ordinary Cordis Entries alongside this Strategy; no `strategyId`
change is needed. They can coexist because each owns a different slot. Core
rejects duplicate slot owners rather than letting installation order win. Slot
names and value schemas belong to this Strategy, not to Core. External authors
use `defineThreeTierExtension` and `installMemory(ctx, { strategyExtensions: [...] })`.

All Sources share the existing turn's read quotas and one projection budget.
Runtime guidance describes snapshots as budget-limited even without extensions:
metadata on many short entries can exceed the projection budget while stored
content remains within capacity. An omitted entry is not evidence of deletion.
Replay and Related admission include the exact Source instance identity. Writes
still require an offered Action and Host authorization, including implicit
capacity maintenance. Explicit operator management is a separate channel.

With no extensions the Layered strategy's original composition is retained. Disabling
one extension only removes its contribution for new turns; running turns keep
their pinned View. If disabling explicit selection leaves multiple Sources in
the same role, the original ambiguity check applies rather than silently
choosing a Source. Projection limits are not token limits or delta injection;
capture guidance is not a background worker or a guarantee of model behavior.

## Sources with another role

An installed Source whose role is not `working-context`, `narrative` or
`durable-evidence` is not a failure and is not admitted either: the strategy
keeps composing the three tiers and returns one `unsupported-source-role`
entry per such Source in `ViewSpec.diagnostics`. The Host validates those
entries and merges them into `view.diagnostics`, so the turn's
`MNEMON VIEW AVAILABILITY` line and the View inspection name the Source and its
role. A diagnostic is an explanation, never authority: the Source still gets no
projection, Route or ActionOffer. Select the general Strategy to compose it;
an explicit `selection` still rejects unsupported roles. An unavailable Source keeps
the Host's own diagnostic instead.

Its own directory is a standalone project: install its declared dependencies,
then run `pnpm verify`. When developing against an unreleased Mnemon, install a
packed `dsh-mnemon` artifact as the peer instead of linking its source tree.

The Starter or a user's Profile explicitly mounts its Entry. This package has
no auto-activation patch; installing it does not override a configured Strategy.

## Installation and verification

The default Starter already mounts and selects the Layered strategy. In an independent Profile, install the package, mount its Entry and explicitly select `default-three-tier`; another installed Strategy does not win by import order.

Installing an npm package is not the same as activating a contribution. From a source checkout, run `pnpm verify` with declared public peers installed; use a packed peer for unreleased SDK work.

[Plugin development and independent fixtures](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/development/extensions.md) · [中文指南](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/zh-CN/development/extensions.md)
