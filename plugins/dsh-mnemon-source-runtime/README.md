# dsh-mnemon-source-runtime

An ordinary, self-contained Source plugin. It owns its configuration, storage,
projection, read/write semantics and tests; Core supplies no private controller.

Install declared dependencies, then run `pnpm verify`. For unreleased SDK work,
install the packed `dsh-mnemon` artifact as the development peer. This directory
has no dependency on the parent repository's tsconfig, test helpers or source.

Configure `dataDir` explicitly to reuse existing data. Otherwise storage is scoped
to the stable Source instance id under `~/.mnemon/sources/`. The default Mnemon
bundle supplies the legacy storage paths without changing existing user data.

The package's patch mounts one instance. A Profile may mount the same module
again with another Entry id and configuration. No default Strategy is installed.

## Source-owned Client

The optional ./client entry is a normal DSH Client module. This package owns
its pages, browser API adapter, Host management operations, and tests. It only
imports the public dsh-mnemon/client helpers; it never receives a Host Context,
raw RPC transport, credentials, or an LLM View grant.

The default distribution reuses these same components and supplies its legacy
coordination callbacks. An independent install uses Source-scoped read/mutate
operations. Agent-assisted cross-Source maintenance is provided by a Host
adapter, not silently installed by the Source. The default client's fallback
registration yields to an explicitly installed Source client through DSH Slots.

pnpm verify checks Host behavior and real Source-backed page interactions, then
builds both Host and browser artifacts plus their public declarations. Client
tests load the installed Core's browser artifact using dsh-mnemon/testing; they
have no dependency on Core's repository sources or configuration files.
