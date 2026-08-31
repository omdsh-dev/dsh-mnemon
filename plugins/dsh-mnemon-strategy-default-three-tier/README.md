# dsh-mnemon-strategy-default-three-tier

One ordinary Cordis Strategy plugin. It consumes public Source facts and proposes
a three-tier View; it imports no Source implementation and grants no authority.

`compose` is pure. `createTurn` owns the executing turn's retrieval policy:
one Documents query (4 results / 6,000 content characters), two different Recall
queries sharing 6 results / 4,800 content characters, duplicate replay,
relevance admission, and one Related traversal from admitted evidence.
Named tools and generic View routes use the same state. Independent child turns
never share quotas, even when they inherit the same immutable View.

Source schemas and provenance are the public read protocol. This plugin formats
the familiar compact model response; Core retains the evidence/authority envelope
for auditing without serializing it again into every model tool result.

The default plugin also owns the existing three-tier instructions and reminders.
They are pinned in `ViewSpec.guidance`, separately from Source projections. The
Host renders them for the selected turn; a different Strategy does not inherit
this plugin's instructions. DSH-assisted write/archival workflows remain Host
adapters over Source operations; Core does not schedule autonomous maintenance.

Its own directory is a standalone project: install its declared dependencies,
then run `pnpm verify`. When developing against an unreleased Mnemon, install a
packed `dsh-mnemon` artifact as the peer instead of linking its source tree.

The Starter or a user's Profile explicitly mounts its Entry. This package has
no auto-activation patch; installing it does not override a configured Strategy.
