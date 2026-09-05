# Documentation

**English** | [简体中文](../zh-CN/README.md) | [Project home](../../README.md)

Start with the default three-tier workflow. The implementation is composable; you do not need to manage plugins to use it.

## Use the system

| Task | Guide |
|---|---|
| Install and verify the first memory | [Getting started](./guides/getting-started.md) |
| Understand the available behaviors | [Capability map](./guides/capabilities.md) |
| Navigate Sidebar, Documents and settings | [UI guide](./guides/ui-guide.md) |
| Choose a long-term backend | [Providers](./guides/memory-providers.md) |
| Back up, restore or troubleshoot | [Operations](./guides/operations.md) |
| Upgrade an existing installation | [Compatibility and upgrades](./reference/compatibility.md) |

## Look up a contract

| Question | Reference |
|---|---|
| Which settings and scopes apply? | [Configuration](./reference/configuration.md) |
| What is stored, shared or archived? | [Storage model](./reference/storage-model.md) |
| When do reads, writes and maintenance run? | [Workflows](./reference/workflows.md) |
| Which tools and commands are exposed? | [Interfaces](./reference/interfaces.md) |

## Build an extension

| Task | Developer guide |
|---|---|
| Understand Source, Strategy, View and ownership | [Architecture](./development/architecture.md) |
| Create a Source, Strategy or Provider | [Plugin development](./development/extensions.md) |
| Build, test and capture a real WebUI | [Development and verification](./development/README.md) |
| Version and release independent packages | [Release process](./development/releasing.md) |

Source owns memory and its operations; Strategy composes selected Sources; Core validates one immutable View for the executing turn. The default three tiers are one composition, not mandatory Core types. A Memory Spaces Provider is a child module of that Source.

[Release history](./releases/README.md) · [Roadmap](./roadmap.md) · [Historical verification evidence](../pr-assets/README.md)

Current guides describe the current implementation. Dated screenshots, old benchmarks and PR reports establish only their named revisions and environments. Internal Host RPCs are not an external plugin SDK.
