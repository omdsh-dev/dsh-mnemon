# Sidebar and Conversation UI Guide

[简体中文](../zh-CN/ui-guide.md) | **English** | [Documentation hub](./README.md)

This guide follows the v0.4.0 Sidebar-only experience and a real user path. The builtin workspace and display-mode selector are removed; the existing Sidebar workflow remains. Compatible screenshots were captured from a live v0.2.0 1600×900 WebUI, while v0.3 Layer controls retain their labeled historical screenshots. The [Sidebar-only settings screenshot](../assets/screenshots/settings-sidebar-only.png) shows the current selector-free layout. Names, counts, and content vary with local data.

## Watch the complete interaction first

[![dsh-mnemon v0.2.0 live Memory System demo poster](../assets/media/dsh-mnemon-memory-system-demo-poster.jpg)](../assets/media/dsh-mnemon-memory-system-demo.mp4)

[Play the 1600×900 MP4](../assets/media/dsh-mnemon-memory-system-demo.mp4) · [Open the GIF](../assets/media/dsh-mnemon-memory-system-demo.gif)

The roughly 55-second recording leaves a clear pause on page transitions, dialogs, button-state changes, and the Agent answer. It scrolls all four primary pages, switches active/archive Documents, applies and clears Provider content filters, opens creation and strategy dialogs, selects multiple AI-metadata targets, changes and restores background model routing, and completes a real read-only Agent Query. Every confirmation that could mutate data stops before submission.

## Interaction model

The Memory System sidebar entry always opens its workspace, including after visiting Task Board or SSH. Clicking it again keeps the current page open; use Back to conversation to close it.

Primary pages remain **Status, Runtime, Documents, Memory Spaces**. Memory Spaces adds **Overview, Recall, Content, Entities**, with **Remember** and **Distillation strategy** at the top right.

| Visible action | What happens after the click | Independent task Agent? |
|---|---|---|
| Refresh status, synchronize now, click a Memory Space card | The Host reads asynchronously; one region spinner or the card's state dot shows progress | No |
| Direct search, browse Content, inspect Entities | Provider-native read contracts run concurrently and render progressively | No |
| Agent query | Recall runs first; bounded evidence goes to a clean top-level task Agent | Yes, read-only |
| Remember / Save to memory | An editable confirmation precedes qualification, deduplication, distillation, routing, and writing | Starts after confirmation |
| AI metadata | Each space samples quickly and generates independently; one failure remains on its card | Yes, isolated per space |
| Archive | A searchable cold reference is created before the Host moves the original | Starts after confirmation |

## 1. Status: establish readiness

[![Status for dsh-mnemon, Mnemon Native, and external Providers](../assets/screenshots/status-overview.png)](../assets/screenshots/status-overview.png)

The top Memory Engine area shows only dsh-mnemon. Mnemon Native has its own status bar; its failure does not become a global banner. External Providers appear below with enabled, health, and connection state.

The page loads concurrently and progressively. Only one region-level spinner remains while work is pending; returned data appears immediately. Status also summarizes Runtime, Documents, Memory Spaces, storage root, and dsh-mnemon / Mnemon versions.

### Check versions

[![Check dsh-mnemon and Mnemon versions](../assets/screenshots/version-check.png)](../assets/screenshots/version-check.png)

Checking is read-only. Update actions appear only for supported installation sources with a newer release. Restart `dsh web` after updating dsh-mnemon.

## 2. Runtime: maintain every-turn context

[![Runtime capacity, filters, and unified memory cards](../assets/screenshots/runtime-memory.png)](../assets/screenshots/runtime-memory.png)

The header summarizes User Profile (`USER.md`) and Working Memory (`MEMORY.md`). A shared card style lists items below. Filter by source, text, category, and importance; clicking the current filter again never breaks the page. Long fields truncate within their own block and reveal the complete value on hover.

[![Add Runtime Memory](../assets/screenshots/runtime-memory-add.png)](../assets/screenshots/runtime-memory-add.png)

Runtime items should be compact, independent, and repeatedly useful. Working Memory items can carry an optional branch scope (comma-separated git branch names in the add and edit forms): scoped items show a branch badge and are projected into the model context only while the session workspace is checked out on a listed branch; leaving the field empty keeps an item visible on every branch. The scope never affects this page or the on-disk `USER.md`/`MEMORY.md` projections. Identity, preferences, and explicit collaboration rules belong in User Profile. Project facts, environment, decisions, and tool lessons belong in Working Memory. Temporary progress and raw logs do not.

## 3. Documents: preserve complete project narratives

[![Document directory, capacity, and Markdown reader](../assets/screenshots/documents-markdown.png)](../assets/screenshots/documents-markdown.png)

Switch between active and archived directories. Repeatedly clicking the selected entry keeps it selected; it never closes the reader. The right pane preserves title, retrieval description, provenance, revision, hash, size, and full Markdown, and resets to the top when selection changes.

Before active capacity is exhausted, an independent task Agent creates a Mnemon cold reference for the least-recently-used Document. The Host moves the original to archived only after verification. Failure or revision conflict preserves the active original.

[![Create a managed Document](../assets/screenshots/document-create-dialog.png)](../assets/screenshots/document-create-dialog.png)

Title and retrieval description determine discoverability, source path preserves provenance, and the body keeps Markdown structure. Source project files remain read-only; the workbench creates a managed copy.

## 4. Memory Spaces: one replaceable third tier

### Overview and live snapshot

[![Snapshot visibility and the live multi-memory relationship graph](../assets/screenshots/overview-memory-graph.png)](../assets/screenshots/overview-memory-graph.png)

Read the live snapshot in two layers from top to bottom:

- Each **Snapshot visibility** card represents one active Memory Space and declares the read surface, projection mode, and observable count its Provider can actually supply. `Real graph`, `Content projection`, and `Query only` are capability boundaries, not quality levels.
- The **Live multi-memory snapshot** merges those readable results into one relationship graph. Edge colors distinguish space ownership, temporal, semantic, causal, and entity-association links, while Provider and Memory Space labels preserve provenance.
- The lower left reports total spaces, memories, and entities; the lower right reports currently rendered elements and connections. A value such as `60 / 129` is an interactive rendering window, not missing data.
- Select a Memory Space, entity, or memory node to inspect its exact context on the right. Natural layout, dragging, and even reset change presentation only; they never rewrite Provider data.

Each card represents a real space. Provider tags use color without duplicating icons inside tags; `Mnemon Native` appears as `mnemon` in the catalog. Click a card to reconnect only that Provider + ID. During reconnect, its state dot becomes an equal-size spinner; no global synchronization runs.

The first Overview visit performs one full synchronization. Later refreshes are on demand. **Synchronize now** remains at the top right beside elapsed time since the last full sync.

Snapshot visibility declares the read surface each space can actually honor before rendering the combined graph:

- Mnemon Native supplies full typed relationships;
- Hindsight and Holographic contribute their real graphs;
- providers without edges contribute content projections only;
- query-only providers such as ByteRover wait for an explicit query.

The UI never fabricates unsupported relationships, entities, deletion, or browse capability.

### Create a Memory Space manually

[![Create Memory Space with vertical fields and Provider selection](../assets/screenshots/memory-space-create-dialog.png)](../assets/screenshots/memory-space-create-dialog.png)

Clicking Create always asks the user to choose a Provider explicitly. Only services enabled in Settings appear. Provider-specific fields use a vertical layout to avoid alignment drift. The new instance enters catalog, activation, and recall only after creation.

### Distillation strategy: manual or smart

[![Manual and smart Provider placement strategy](../assets/screenshots/distillation-strategy.png)](../assets/screenshots/distillation-strategy.png)

Distillation strategy routes later Agent writes; it does not change manual creation:

- **Manual** uses an explicitly constrained target;
- **Smart selection** treats data boundary and required capabilities as hard rules, then uses local/shared preference and a prompt as soft policy. A model runs only when several candidates remain eligible.

The receipt keeps decision source, confidence, and reason. Provider credentials never enter model context.

### AI metadata

[![AI metadata across Providers with multi-select isolated tasks](../assets/screenshots/ai-metadata-dialog.png)](../assets/screenshots/ai-metadata-dialog.png)

Select several active spaces. Each task uses that Provider's fastest native query to fetch a small sample, then follows system-prompt length and capability constraints for title and description. Tasks share no state; a failure appears only on its card. If a model-generated title or description fails the local length check, that card keeps its previous metadata while valid results still update. The dialog stays open and each card plays a rightward same-tone refresh animation before updating in place.

Generated title and description are local catalog metadata and survive ordinary reconnects. Disabling a Provider clears mapping and metadata. Re-enabling rebuilds them from Provider data, using the closest default only for unmapped fields.

### Remember

[![Remember candidate and optional manual constraints](../assets/screenshots/remember-dialog.png)](../assets/screenshots/remember-dialog.png)

Normally, provide only a candidate. Confirmation starts a clean task Agent to qualify, choose the narrowest space, deduplicate, distill, and write. Manual advanced options are for genuinely required target, category, or importance constraints.

### Recall and Agent Query

[![Real Agent Query result and multi-provider recall scope](../assets/screenshots/recall-agent-answer.png)](../assets/screenshots/recall-agent-answer.png)

- **Direct search** returns raw evidence without an Agent.
- **Agent query** uses the same evidence, then starts an evidence-only top-level task Agent.
- Providers return concurrently; one connection failure never hides other sources.
- Rank fusion orders providers while retaining engine-native score, ID, space, Provider, and category.
- Related, Link, Browse, and Forget appear only when genuinely supported.

Focused questions are usually more reliable than broad keywords.

### Content and Entities

| Content | Entities |
|---|---|
| [![Memory content, Provider filters, and progressive loading](../assets/screenshots/memory-content.png)](../assets/screenshots/memory-content.png) | [![Real entity indexes and related memory](../assets/screenshots/entities-context.png)](../assets/screenshots/entities-context.png) |

Content distinguishes enumerable, query-only, and unavailable surfaces. A Provider tag both applies a filter and clears it when clicked again. Entities aggregates only real indexes—currently Mnemon Native, Hindsight, and Holographic—rather than inferring capability from ordinary text.

## 5. Settings: services are not Memory Space instances

[![Memory System settings for display, scope, Provider services, and backup](../assets/screenshots/settings-memory-system.png)](../assets/screenshots/settings-memory-system.png)

Settings owns reusable **service configuration** only:

- Memory Layer cards come from the live Catalog. Runtime, Documents, and Memory Spaces each have one master switch, with no additional participation-mode controls;
- every external Provider has its own switch and is off by default;
- endpoint, API Key, and Provider-specific fields appear only after enabling;
- API Keys use a conventional password field whose eye button toggles visible/hidden; there is no clear-credential checkbox, dedicated Remove row, or saved-secret caption;
- Save updates service configuration without waiting for discovery or recall; health belongs on Status and instances belong on Overview;
- global / workspace / custom tags show effective scope; Providers with the same scope semantics reuse Mnemon's configuration framework.
- User profile scope is independent: **Global user profile** combines global USER.md with workspace/custom MEMORY.md without moving either source.

The screenshot below comes from an isolated installation of `dsh-mnemon@0.3.0`. Each default Layer has exactly one master switch. “On” permits on-demand use; it does not force Recall on every turn.

[![Runtime Memory, Project Documents, and Memory Spaces master switches in the actual English v0.3 settings page](../assets/screenshots/settings-memory-layers-en.jpg)](../assets/screenshots/settings-memory-layers-en.jpg)

Mnemon-specific custom directory, backup, and migration remain in Mnemon's own expandable area. Custom is an explicit-path global scope.

### Mnemon Native embedding bridge

[![DSH-managed Mnemon embedding endpoint, model, and successful status check in an isolated latest-code Web profile](../assets/screenshots/settings-native-embeddings.jpg)](../assets/screenshots/settings-native-embeddings.jpg)

**Manage embedding settings in DSH** makes the saved Ollama endpoint and model authoritative for Mnemon child processes, including Desktop launches that do not inherit shell startup files. The endpoint rejects credentials, queries, and fragments, and the warning explains that memory and query text leave the Host for that service. **Test status** uses the saved runtime, not an unsaved draft; the isolated profile above shows a successful Mnemon v0.2.5 connection and zero-memory coverage without exposing credentials or personal memory.

Disabling a Layer does not delete data. Its Sidebar tab remains visible with an Off badge and opens a reversible disabled-state explanation without reading the data plane; re-enabling restores the existing data. A newly contributed extension Layer starts disabled. The current runtime generation keeps serving until the candidate validates and swaps, so a rejected candidate never leaves a partial configuration active.

[![The actual English Sidebar keeps the Documents tab visible and explains its reversible disabled state](../assets/screenshots/sidebar-layer-disabled-en.jpg)](../assets/screenshots/sidebar-layer-disabled-en.jpg)

### Background task Agent model route

[![Background task Agent follows main route or uses a selected Provider and model](../assets/screenshots/settings-task-agent-routing.png)](../assets/screenshots/settings-task-agent-routing.png)

**Follow main route** uses DSH's default for a new session. **Choose model provider** stores a complete Provider + Model route. It affects AI metadata, Agent Query, Remember, smart Provider selection, and Document archive only; it never changes the current main conversation model. Reasoning strength depends on both selected Provider capability and DSH route support.

On DSH 0.1.1-rc.2, model capabilities flow into this picker. Image-capable routes carry an **Image input** label, including the first-party `deepseek-official/deepseek-v4-flash-vision-exp` model. The label describes model capability; current Mnemon background jobs still send text-only prompts.

Switches, radio options, and eye buttons tolerate repeated clicks—including clicking the already-selected value—without unmounting or blanking the page.

## 6. In-conversation interaction

### Turn memory

Turn memory appears only on completed turns with memory activity. Expand or collapse it repeatedly. Clicking an exact tool opens its matching Recall, Content, Entities, or Documents page.

### Save to memory

Save to memory sits in the native action strip for finalized replies. The first click only reads that reply and opens an editable dialog. Cancel has no data effect. Only **Confirm and send to independent task Agent** starts distillation.

Both conversation controls are on by default and can be changed independently under **Settings → Memory System → Conversation interface**. Saving applies live.

## Workspace mode: inspection and execution are distinct

| Concept | Selected by | Affects |
|---|---|---|
| **Inspected workspace** | Workbench header selector | Which `<workspace>/.mnemon` the UI displays and maintains manually |
| **Effective workspace** | Current conversation / Agent cwd | Which root conversation tools, commands, and lifecycle hooks use |

You may inspect project B while staying in project A's conversation. The conversation Agent remains on A; AI metadata, Agent Query, Remember, and Document archive launched from the workbench create clean task Agents explicitly scoped to B. This works even when no main session is selected.

Remote Provider workspaces, users, banks, projects, containers, and URIs are independent namespaces and never change implicitly with the DSH workspace. `global` and `custom` resolve to one explicit root and need no inspection/execution alignment.

## Common rules

- Solid blue means primary action; blue outline usually means Edit; red is reserved for Delete, Disconnect, Archive, or Forget; neutral actions are View, Copy, and Cancel.
- A Memory Space toggle controls only whether dsh-mnemon includes it in read routing. It is not the Mnemon CLI default Store.
- Mnemon Native physical deletion requires confirmation. External spaces use Disconnect and leave Provider data untouched.
- Pages load by region; a local error never blocks unrelated data or creates a wall of spinners.
- The workbench always opens through Sidebar; Turn memory and Save to memory remain conversation shortcuts.

Next: [Capability map](./capabilities.md) · [Getting Started](./getting-started.md) · [Provider guide](./memory-providers.md) · [Configuration](./configuration.md)
