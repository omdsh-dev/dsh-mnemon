# dsh-mnemon-source-runtime

An ordinary, self-contained Source plugin. It owns its configuration, storage,
projection, read/write semantics and tests; Core supplies no private controller.

Install declared dependencies, then run `pnpm verify`. For unreleased SDK work,
install the packed `dsh-mnemon` artifact as the development peer. This directory
has no dependency on the parent repository's tsconfig, test helpers or source.

Configure `dataDir` explicitly to reuse existing data. Otherwise storage is scoped
to the stable Source instance id under `~/.mnemon/sources/`. The default Mnemon
bundle supplies the existing storage paths without changing existing user data.

This package does not auto-mount a default instance. The Starter or a user's
Profile explicitly mounts its Entry. The same module can be mounted again with
another Entry id and configuration; no default Strategy is installed here.

## Source-owned Client

The optional ./client entry is a normal DSH Client module. This package owns
its pages, browser API adapter, Host management operations, and tests. It only
imports the public dsh-mnemon/client helpers; it never receives a Host Context,
raw RPC transport, credentials, or an LLM View grant.

Business copy and layout live in `presentation/`. The Client bundles its own
assets; the public data-only paths also let the Starter preserve existing
page-kit exports. Updating this page does not require editing Starter resources.

The default distribution loads these same Client plugins through DSH. Each page
uses Source-scoped read/mutate operations. Optional Agent-assisted cross-Source
maintenance is advertised by the Host through the same scoped page client; it
is not silently installed by a Source. There is one Slot owner per Source page,
not a second fallback registration or copied default implementation.

pnpm verify checks Host behavior and real Source-backed page interactions, then
builds both Host and browser artifacts plus their public declarations. Client
tests load the installed Core's browser artifact using dsh-mnemon/testing; they
have no dependency on Core's repository sources or configuration files.
