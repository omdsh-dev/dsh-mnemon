# dsh-mnemon-source-memory-spaces

Memory Spaces owns its Provider contracts and private child-Fiber host. Provider authors depend on `dsh-mnemon-source-memory-spaces/provider-sdk`, never on the main repository's controllers or global registry.

The Source owns its storage registry, scoped native command transport, recall policy, routing, receipts and management operations. It imports **no Provider implementation** and defines no extra Context service. Each mount defaults to a separate data directory; set `dataDir` explicitly to select an existing authority.

Install the chosen Provider packages and configure them explicitly on the Source entry:

```yaml
name: dsh-mnemon-source-memory-spaces
config:
  dataDir: /absolute/path/to/memory
  providers:
    - use: dsh-mnemon-provider-holographic
      instanceId: local-facts
```

The host must already provide `ctx.mnemonMemory`; a Strategy decides how this Source enters the LLM View. For programmatic composition, import `installMemorySpaces` and pass explicit typed child modules. Omitting the child list is an error, not automatic dependency discovery. The default `dsh-mnemon` bundle supplies the existing nine Providers and old storage settings separately.

Run `pnpm install && pnpm verify` in this directory. Its own tests mount real Cordis Fibers and exercise Source isolation, scoped management, View actions/routes, persistence and failed-child cleanup. Provider authors can use `createMemorySpaceProviderFixture` from the public `/testing` entry for driver-level tests, then test their child inside this Source.

## Source-owned Client

The optional ./client entry is a normal DSH Client module. This package owns
its pages, browser API adapter, Host management operations, and tests. It only
imports the public dsh-mnemon/client helpers; it never receives a Host Context,
raw RPC transport, credentials, or an LLM View grant.

The default distribution loads these same Client plugins through DSH. Each page
uses Source-scoped read/mutate operations. Optional Agent-assisted cross-Source
maintenance is advertised by the Host through the same scoped page client; it
is not silently installed by a Source. There is one Slot owner per Source page,
not a second fallback registration or copied default implementation.

pnpm verify checks Host behavior and real Source-backed page interactions, then
builds both Host and browser artifacts plus their public declarations. Client
tests load the installed Core's browser artifact using dsh-mnemon/testing; they
have no dependency on Core's repository sources or configuration files.
