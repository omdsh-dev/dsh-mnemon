# dsh-mnemon Documentation

[简体中文](../zh-CN/README.md) | **English** | [Project home](../../README.md)

This hub is organized by what you need to accomplish. New users should follow Getting Started, then use the visual guide for the interface. Existing v0.2.x users can go directly to the v0.3.0 release notes; reference documents are for deployment, integration, and development work.

## New-user path

1. [Capability map](./capabilities.md): understand the three tiers, nine Providers, and which clicks start independent task Agents in 30 seconds.
2. [Roughly 55-second widescreen live demo](../assets/media/dsh-mnemon-memory-system-demo.mp4): see paced full-page scrolling, Provider and dialog interactions, and a completed read-only Agent Query.
3. [Getting Started](./getting-started.md): install Mnemon and the plugin, choose storage, and complete first-run verification.
4. [Sidebar and conversation UI guide](./ui-guide.md): learn Status, Runtime, Documents, Memory Spaces, and in-conversation entry points.
5. [Project overview](./project-overview.md): understand the three-tier model, cross-agent sharing boundary, read/write boundaries, and complete flow.

## Find a task

| I want to… | Document |
|---|---|
| Grasp the current product scope and v0.3 architecture | [Capability map](./capabilities.md) · [v0.3.0 release notes](./releases/v0.3.0.md) |
| Decide which tier should retain something | [Storage and the three-tier model](./storage-model.md) |
| Choose, configure, or compare a Memory Space provider | [Long-term memory providers](./memory-providers.md) |
| Share durable memory between DSH and other Mnemon-enabled agents | [Project overview: Cross-agent sharing](./project-overview.md#cross-agent-sharing-boundary) · [Configuration: Sharing scope](./configuration.md#choose-a-cross-agent-sharing-scope) |
| Learn when injection, recall, remembering, and archiving happen | [Lifecycle and workflows](./workflows.md) |
| Configure global / workspace / custom storage, entry placement, and visibility | [Configuration reference](./configuration.md) |
| Understand workspace inspection versus the Agent's effective directory | [UI guide: Workspace mode](./ui-guide.md#workspace-mode-separating-inspection-from-execution) |
| Check or update Mnemon and dsh-mnemon | [Operations: Version checks and updates](./operations.md#version-checks-and-updates) |
| Back up, restore, or migrate the complete memory root | [Operations: Backup and recovery](./operations.md#backup-and-recovery) |
| Publish the WebUI behind a cloud hostname | [Operations: Cloud-hosted WebUI](./operations.md#cloud-hosted-webui) |
| Troubleshoot empty recall, misalignment, CLI, or provider errors | [Operations and troubleshooting](./operations.md#troubleshooting) |
| Use model tools, `/mnemon` commands, or internal RPC | [Interface reference](./interfaces.md) |
| Understand Host, workers, control plane, and data plane | [Architecture](./architecture.md) |
| Build a Layer, Adapter, Strategy, Guard, or MemorySource plugin | [Building Memory Extensions](./extensions.md) |
| Modify code, screenshots, tests, or releases | [Development and verification](./development.md) |
| Upgrade from the previous release | [v0.4.7 release notes](./releases/v0.4.7.md) |
| See planned work | [Roadmap](./roadmap.md) |

## Core terms

| Term | Code / alternate name | Meaning |
|---|---|---|
| Memory System | 记忆系统 | The complete dsh-mnemon entry in DSH |
| Runtime Memory | USER / MEMORY | Hot memory projected into every turn |
| Project Documents | Documents / 档案 | Managed, searchable project knowledge that keeps full Markdown structure |
| Memory Space | 记忆体 | An independent, activatable, on-demand long-term-memory instance backed by Mnemon or an external Provider |
| Cross-agent memory sharing | 跨 Agent 共享 | Mnemon-enabled agents use the same root and Store to share durable memory, not the complete DSH context |
| Remember | Distill / 沉淀 | Start an independent task Agent for qualification, dedupe, and writing |
| Recall | 召回 | Retrieve bounded evidence from active Memory Spaces |
| Archive | 归档 | Create a cold reference before moving an infrequently used Document out of active storage |

## Documentation boundaries

- User documentation describes the Sidebar-first workbench, optional shared Builtin placement, and composable three-tier topology.
- Architecture diagrams describe stable execution boundaries, not live monitoring. Use Status for current counts and versions.
- RPC is an internal Host-to-client protocol, not a promised stable external API.
- There is no formal fixed DSH / Mnemon version matrix yet. Back up and validate in an isolated root before upgrading.
