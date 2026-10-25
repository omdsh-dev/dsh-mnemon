# Documentation

[简体中文](../zh-CN/README.md) | **English** | [Project home](../../README.md)

dsh-mnemon gives DeepSeek Harness three kinds of memory: **runtime memory** in every turn, **Project Documents** searched when a question needs them, and **Memory Spaces** for durable evidence on the Provider you choose. A main strategy decides how they take part in each turn; you pick it, and any enhancements, on the Plugins page. Start with the default Layered strategy; you never need to manage plugins to use it.

[![The Memory composition board on the dsh-mnemon plugin page](../assets/webui-v0.5.32/en/plugin-composition.jpg)](./guides/ui-guide.md#on-the-plugins-page)

## Use the system

| Task | Guide |
|---|---|
| Install from scratch on the web, the desktop app or the command line, through to the first memory | [Install and start](./guides/installation.md) |
| Store and use the first memories | [Getting started](./guides/getting-started.md) |
| Find your way around the conversation, the Memory System and the Plugins page | [UI guide](./guides/ui-guide.md) |
| Understand what each component and strategy does | [Capability map](./guides/capabilities.md) |
| Choose and connect a long-term backend | [Providers](./guides/memory-providers.md) |
| Manage skills, let them improve from conversations, test them and install more | [Skills](./guides/skills.md) |
| Back up, move storage or troubleshoot | [Operations](./guides/operations.md) |
| Upgrade an existing installation | [Compatibility and upgrades](./reference/compatibility.md) |

## Look up a contract

| Question | Reference |
|---|---|
| Which settings exist, where are they edited and saved? | [Configuration](./reference/configuration.md) |
| What is stored where, shared or archived? | [Storage model](./reference/storage-model.md) |
| When do reads, writes and maintenance run? | [Workflows](./reference/workflows.md) |
| Which tools, commands, RPC channels and UI regions are exposed? | [Interfaces](./reference/interfaces.md) |

## Build an extension

| Task | Developer guide |
|---|---|
| Understand Source, Strategy, View, ownership and the UI regions | [Architecture](./development/architecture.md) |
| Create a Source, Strategy, enhancement or Provider | [Plugin development](./development/extensions.md) |
| Adapt a skin to Mnemon backgrounds and transparency | [Skin development](./development/skin-integration.md) |
| Build, test and capture a real WebUI | [Development and verification](./development/README.md) |
| Version and release independent packages | [Release process](./development/releasing.md) |
| Contribute: the rules, the scripts and the design plans | [CONTRIBUTING](../../CONTRIBUTING.md) · [Scripts](../../scripts/README.md) · [Design plans](../plans/README.md) |

## What is new

[v0.5.35](./releases/v0.5.35.md) improves Skills Trash and text-only evals, preserves Runtime importance and sync overflow, fixes Provider writes and score handling, and exposes workspace identity helpers. [v0.5.34](./releases/v0.5.34.md) adds Skills, an experimental component that manages the DSH skills a workspace loads, improves them from your conversations with backtested drafts you adopt, keeps each skill's test cases, and installs more from skills.sh, GitHub and Agent Skills sites. [v0.5.33](./releases/v0.5.33.md) lets Git sync find its token whatever Git configures, offers gitee.com the user name it takes, keeps memory tasks from leaving empty conversations in DSH's lists, and documents how the desktop app updates from 0.5.30 and earlier on DSH 0.2.1. [All releases](./releases/README.md) · [Roadmap](./roadmap.md) · [Historical evidence](../pr-assets/README.md)

Guides describe the current release. Screenshots and recordings come from the [v0.5.32 gallery](../assets/webui-v0.5.32/README.md) and, for Skills, the [v0.5.34 Skills gallery](../assets/skills-v0.5.34/README.md); the installation steps from the [installation gallery](../assets/install-v0.5.19/README.md); dated PR records establish only their named revisions and environments. Internal Host RPCs are not an external plugin SDK.
