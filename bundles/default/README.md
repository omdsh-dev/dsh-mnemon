# Default distribution, not the plugin contract

The root `dsh-mnemon` package remains the one-install DSH distribution. This
directory owns its explicit assembly, legacy settings/storage mapping and Host
adapter. It may depend on first-party plugins; the reverse dependency is forbidden.

- `host.ts`: existing DSH tools, turn lifecycle, settings, RPC and compatibility API.
- `runtime.ts`: workspace-scoped default graphs and legacy API/data-path adapters.
- `contributions.ts`: the old single-Entry shortcut.
- `providers.ts`: the default Memory Spaces Source's explicit Provider children.
- `client/`: default workbench navigation and Source-page assembly, not Source page implementations.
- `../../cordis.patch.yml`: the five-Entry default profile and client discovery anchor.

`dsh-mnemon/core` only publishes `ctx.mnemonMemory`. A Host adapter attaches a
generation, supplies scope/phase policy, and pins turns with
`ComposableMemoryTurnManager`. It does not implicitly install the three Sources,
Providers, legacy settings or UI. Normal DSH users continue to use the default
distribution above; custom hosts can compose only Core and their selected plugins.

The forwarding modules in `src/` preserve existing imports. New Source/Strategy
authors use the public SDK, never this directory or those compatibility modules.

The starter's Source pages use native DSH Slot fallback priority. A separately
installed Source client replaces the fallback and removal restores it. Built-in
Source types also support instance selection; only the starter's reserved
`mnemon-source-*` / `bundled-*` instances receive legacy cross-Source maintenance
callbacks. Additional instances use their own scoped management client.
