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
