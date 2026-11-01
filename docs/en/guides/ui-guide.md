# UI guide

[简体中文](../../zh-CN/guides/ui-guide.md) | **English** | [Documentation](../README.md)

You meet dsh-mnemon in three places. The conversation shows what each turn read and wrote, and lets you save a reply to memory. The **Memory System** is where you browse, search and edit what is stored. The `dsh-mnemon` page under **Plugins** is where you compose memory and change settings.

| Where | What you do there | How to open it |
|---|---|---|
| [In a conversation](#in-a-conversation) | See the memory and skills a reply used, and open them in one click; save a reply to memory | Under each finished reply |
| [The Memory System](#the-memory-system) | Check status; browse, search and edit runtime memory, documents and memory spaces; manage skills | **Memory System** in the sidebar, or a session tab |
| [On the Plugins page](#on-the-plugins-page) | Choose strategies and enhancements; set up components, storage and the interface | **Plugins → dsh-mnemon**, or the gear in the Memory System header |

The recordings and screenshots come from the [v0.5.32 gallery](../../assets/webui-v0.5.32/README.md): a real DSH 0.2.1 WebUI in light appearance with a seeded, fictional project, Lumen. The live DeepSeek model wrote every answer, write and receipt; waits for the model play at 4x or 6x, marked in the lower right corner. A local Ollama served embeddings at Mnemon's default endpoint, with the Mnemon Native embedding settings at their default, so every memory has a vector. The Skills screens come from the [v0.5.34 Skills gallery](../../assets/skills-v0.5.34/README.md), on the same project with a scripted model.

Two rules hold everywhere. **Switches and selectors apply as soon as you change them**; if a write fails, the control shows the saved value again next to the reason. **Typed values wait for their group's Apply**, which appears once something changed, together with a note on what applying will do.

## In a conversation

![Ask a question, expand the turn memory bar, and open the document it read in Project Documents](../../assets/webui-v0.5.32/en/recall.gif)

### Turn memory bar

A reply that used memory ends with a **Turn memory** line: the Memory System's brain mark, then how many recalls, document searches and writes the turn made. Expanded, it has one row per tool. On the left, the tool says in plain words what it did, such as **Document search** or **Memory Spaces recall ×2**; hover to see the tool's own name. On the right are the items it read or wrote.

![An answer drawn from working memory and Project Documents; the expanded bar lists three documents and one more](../../assets/webui-v0.5.32/en/chat-recall.jpg)

- Select a tool to open its page in the Memory System.
- Select an item to open it where it lives: a document is selected in **Project Documents**; a memory runs as a query on the **Recall** page; a runtime entry is highlighted and scrolled to in **Runtime memory**.
- Each tool lists up to three items and counts the rest; an item known only by its id stays out. On a phone, the items sit below their tool.
- Turns without memory activity show no bar.

When you correct a fact, the Agent replaces the runtime memory entry and the bar reports the write; select it to see the replaced entry. Here the Agent also updated the checkout LCP investigation in Project Documents, whose latest measurement no longer meets the target, so the bar lists a runtime memory write and a document update. [Watch the correction](../../assets/webui-v0.5.32/en/correct.mp4).

| A correction and its writes | Its runtime item opens the entry, highlighted |
|---|---|
| ![The reply to a new checkout target; the turn memory bar lists a runtime memory update with the new target and a document update to the checkout LCP investigation](../../assets/webui-v0.5.32/en/chat-correction.jpg) | ![Runtime memory with the replaced checkout target entry highlighted](../../assets/webui-v0.5.32/en/memory-runtime.jpg) |

Temporary progress, guesses and secrets are not written.

### Save to memory

![Select the brain mark under a reply, edit the candidate, send it to the task Agent, then view the new memory from the receipt](../../assets/webui-v0.5.32/en/save.gif)

Each finished reply has a brain-shaped **Save to memory** in its action strip, the same mark as the Memory System; the database icon beside it is DSH's usage, not memory. Selecting it reads that reply and opens a dialog:

- The title is **Save to memory**, with one line on what happens to the text. **Task Agent ready** means the task Agent can take it.
- **Candidate (editable)** starts with the whole reply; usually you keep only the sentence worth remembering. **Cancel** changes nothing.
- **Save to** picks where it goes:
  - **Let the Agent decide** is the default while a task Agent can write. **Send to task Agent** hands the text to an independent task Agent, which decides whether it is worth keeping, picks the right Memory Space, removes duplicates, distils and writes, outside the conversation.
  - **Working memory (MEMORY.md)**, **User profile (USER.md)** or an active Memory Space by name: **Save** writes the text there at once, through the same write as that place's page; no task Agent decides where it goes. Working memory and the user profile keep it as one line. Before saving, the dialog says when the text is too long for one entry or for the file, and when the file is full: working memory then keeps part of its entries and moves the rest out, and a task Agent condenses the user profile, which needs one.
  - A place is listed while its layer is on, its component runs and its writes are not switched off.
  - Without a task Agent, or without a Memory Space Provider, the dialog starts on **Working memory** while it is listed. With no place open at all, it says so and sending stays closed.
- A receipt follows: the outcome (**Saved**, **Updated**, **Submitted; the Provider confirms later**, **Skipped**, **Partly saved**, **Not finished** or **Failed**), a summary of where the text went, and a link to it: **View in Memory Spaces**, or Runtime Memory for working memory and the user profile. A memory saved without a vector gets a line saying so: semantic matching misses it until the vector is filled in from the Mnemon Native embedding settings on [Memory Spaces' page](#memory-spaces-page), and keyword search still finds it. While **Manage embedding settings in DSH** is off, as it is by default, the line is a plain note that no embedding service is available; while it is on, the line is a caution that the embedding service set up there did not produce a vector. **Cancel** becomes **Close**. Sending the same text to the same place again needs an edit, and with **Let the Agent decide** the task Agent takes the edited text as a new candidate; another place, or a send that failed, takes it as it is.

| Edit the candidate | Choose where it goes | The task Agent's receipt |
|---|---|---|
| ![Save to memory with Task Agent ready and the candidate cut down to one fact](../../assets/webui-v0.5.32/en/chat-save.jpg) | ![Save to open: Let the Agent decide, Working memory (MEMORY.md), User profile (USER.md), and the Lumen project and Team conventions Memory Spaces](../../assets/webui-v0.5.32/en/chat-save-target.jpg) | ![Receipt: saved in the Lumen project Memory Space and linked to the earlier note on the synchronous SDK, with View in Memory Spaces](../../assets/webui-v0.5.32/en/chat-save-receipt.jpg) |

**Save to memory** at the top of Memory Spaces opens the Memory Spaces dialog, without the conversation's **Save to** choice. The turn memory bar and the Save to memory button are on by default and can be turned off under [Interface](#interface). In the conversation-tab placement, these entries open the Memory System tab of the conversation they came from; with several eligible tabs in split panes, open the intended one yourself.

### Turn skills line

![A turn that used release-notes, with the Turn skills line: release-notes, suggested 1](../../assets/skills-v0.5.34/en/chat-skills.jpg)

A turn that used a skill, or earned a review, ends with a **Turn skills** line: the skills the turn used, then **Reviewing** while self-evolution reviews the conversation, and **suggested** with a count once the review left suggestions. Each item opens on the [Skills page](#skills). The line is on by default; **In the conversation** on Skills' page under Plugins turns it off. See [Skills in a conversation](./skills.md#in-a-conversation).

## The Memory System

![Status, runtime memory, a document, the Memory Spaces overview and graph, then an Agent answer with citations](../../assets/webui-v0.5.32/en/memory.gif)

The Memory System has five pages, named by the components that provide them: **Status**, **Runtime memory**, **Project Documents**, **Memory Spaces** and **Skills**. An installed Source adds its own page the same way. Turning off a Source or its memory layer hides its tabs; turning it back on restores them. If the open page is turned off, the view returns to Status. The configuration entry stays available, and an enabled Source that fails to run keeps its diagnostic tab. The header shows the connection and the composing main strategy, for example *Connected · Layered strategy*, the storage scope, **Refresh** and a gear that opens the Plugins page. **Refresh** reloads the open page, so pages carry no refresh or sync buttons of their own.

By default the Memory System is a sidebar entry that keeps its page when you come back. Opened from a turn's item, a page lands on that item; a tab in the header opens the page fresh. Under **Interface → Memory System opens in**, choose **Conversation tab** to open it inside a conversation instead; the pages are the same. **Back to chat** and Escape return to the conversation.

### Status

![Status: the engine, one card per memory component, the running Provider and the storage areas](../../assets/webui-v0.5.32/en/memory-status.jpg)

The top row has one card per component: the engine with its version, then each Source with what it holds. **Memory providers** lists only the running Providers with their spaces' connection state and sums up the rest in one line, *N more Providers are off*, with **Open configuration** beside it; the storage areas follow. Regions load independently; one failure never hides the rest.

A notice with **Open configuration** appears only when memory needs attention:

- **Memory not in use**: no main strategy runs, so conversations continue without memory.
- **The selected main strategy is not running**: another strategy composes memory for now.
- **The latest component change did not take effect**: the previous composition keeps serving.

**Check versions** is read-only. It tells whether the Mnemon CLI is missing, current or out of date, with the npm command to copy, and lists each subpackage's installed, published and pinned version. When a newer dsh-mnemon exists, **Update** installs it through DSH's own plugin installer, in the desktop app too. Restart DSH after updating packages; until then, a notice above every page names the installed version. [Version checks and updates](./operations.md#version-checks-and-updates) explains each case.

### Runtime memory

Runtime memory is the compact context injected into every turn. **User profile** (`USER.md`) holds who you are, your preferences and collaboration rules. **Working memory** (`MEMORY.md`) holds project facts, environment, decisions and lessons. Each card shows its size against its limit. Opened from a turn, the entry that turn wrote carries a highlighted border; see [the correction above](#turn-memory-bar).

- Entries are newest first, with filters for target and text. Editing an older entry keeps its place. **Add memory** opens the dialog for a new runtime entry.
- Keep entries short, independent and repeatedly useful; temporary progress and raw logs do not belong here.
- A working-memory entry can be limited to git branches. It is then injected only while the session's workspace is on one of them; the page and the files on disk are unaffected.
- When working memory reaches its limit, the Host archives its entries into a memory space, keeps the most important ones that fit in about 70% of the limit, and adds the new one. With no memory space that can take them, for example without the Mnemon CLI or another Provider, the entries it does not keep move to the local archive `runtime/archived/MEMORY.md` in the data directory instead.

<details>
<summary>Editing, capacity and branch details</summary>

Edit and Remove match an entry's full content within its target, so a short entry such as `X` can change without touching `EGO_LINUX_CHROME`. Identical entries in one target are ambiguous and are rejected without changing data.

Capacity archiving moves the exact original entries. If a routing batch fails or returns an invalid proposal, that batch goes to the eligible default memory space, or the first eligible one, and the summary records why. Spaces created or activated during the current turn can receive the archive once they are active and support it. If a memory space could take the archive but this turn cannot write to it, existing entries stay intact and the pending add is not saved; retry it in a new turn after fixing the cause. With no memory space that could take it at all, the entries that are not kept move to the local archive instead.

When the Agent writes the user profile, `branches` must be omitted or empty. For working memory, `branches: []` on replace clears the scope; omitting it keeps the scope. The model-facing snapshot adds each entry's importance and age in days for the new turn; stored text is unchanged. See [projection format and limits](../reference/storage-model.md#source-of-truth-and-projections).

</details>

### Project Documents

![Project Documents opened from a turn, with “Decision: queue event ingestion” selected](../../assets/webui-v0.5.32/en/memory-documents.jpg)

Documents hold complete narratives: designs, investigations, procedures and handoffs. Select a DSH workspace first; documents belong to a workspace even when storage is global.

- Switch between **Active** and **Archived**. The reader keeps the title, retrieval description, provenance, revision, hash, size and full Markdown.
- Search matches the title, description and body. Lists are newest first; updating an older document does not move it.
- Source files in your project are never modified; a document is a managed copy.
- Archiving indexes the document in a memory space before moving the original, so the cold copy stays findable. The destination must be active and support exact writes and safe forget. With no such memory space at all, the document is archived locally without an index and stays readable under **Archived**.

<details>
<summary>Archiving and idle review details</summary>

When a memory space can take the index, for an explicit archive or capacity maintenance, an independent task Agent without memory tools proposes a summary and one eligible memory space. A local archive needs no task Agent: the Host moves the original and notes why there is no index. The Host validates it, adds the exact cold path and content hash, writes the index and records lineage before moving the original. An invalid proposal changes nothing. If the move fails, the Host removes only the index it just created; existing verified indexes are reused and never deleted. If cleanup fails or the Provider outcome is uncertain, inspect the reported destination before retrying.

Idle review never edits existing documents. It searches first, skips what is covered, and creates a separate supplementary document only for substantial new knowledge; with no capacity left, it skips creation. It reuses evidence already in the finished conversation and cannot reopen files.

</details>

### Memory Spaces

![The Memory Spaces overview: two active spaces and one inactive](../../assets/webui-v0.5.32/en/memory-spaces.jpg)

A memory space is one named scope of long-term evidence on one Provider. **Overview** lists the spaces as cards; the switch on a card decides whether dsh-mnemon reads it, and the tag names its Provider, such as Mnemon Native. Clicking a card reconnects only that space. **Save to memory** and **Provider for new spaces** sit at the top right, with **Recall**, **Content** and **Entities** beside Overview.

![The graph of the active spaces with the ClickHouse entity selected](../../assets/webui-v0.5.32/en/memory-graph.jpg)

Below the cards, the graph merges what the active spaces can show: memories, entities, and the links between them. Select a space, entity or memory to see its context on the right, here the ClickHouse entity with **Recall around this**. Layout, dragging and reset only change the picture. The footer counts spaces, memories and entities, and how many elements are drawn.

Each space declares what its Provider can really supply. Mnemon Native gives typed relationships; Hindsight and Holographic give their own graphs; Providers without edges contribute content only; query-only Providers such as ByteRover wait for a question. Nothing unsupported is invented.

- **Create Memory Space** always lets you pick the Provider, with ready Providers first; turn more on from [Memory Spaces' page](#memory-spaces-page).
- **Provider for new spaces** matters only when a task Agent creates a space. **Fixed Provider** always creates it on the Provider you choose; **Smart selection rules** let the Host enforce data and capability rules first, then the task Agent chooses among the eligible Providers. Existing spaces are still chosen by name and description.
- **Tidy names and descriptions** samples each selected active space and gives it to an independent task Agent for a title and description. Each space runs on its own; a failure stays on its card.
- **Rediscover** asks every enabled third-party Provider again for namespaces created on its side since its settings were saved. The Host also asks once, a little after it starts. A new space shows **New** and stays inactive until you switch it on. A line above the cards says what was found and which Provider could not finish, until you dismiss it; a page opened while the Host is asking shows it when the Host is done. A space you disconnected stays disconnected.

#### Recall

| Direct search | Ask Agent |
|---|---|
| ![Direct search across the active spaces, with scores and provenance](../../assets/webui-v0.5.32/en/memory-recall.jpg) | ![An Agent answer drawn from five memories, with its citations listed by content](../../assets/webui-v0.5.32/en/memory-agent.jpg) |

**Direct search** returns raw evidence from every active space without an Agent, with each Provider's own score, space and category. **Ask Agent** runs the same search, then gives the evidence to a read-only task Agent for an answer. The answer speaks in terms of the evidence, and **Cites** below lists the memories it used by their content, never by id. Providers answer concurrently, so one failure never hides the others. **View related** and **Forget** appear only where the Provider supports them. Opening Recall with a query, from a turn's item, **Recall around this** or **View related**, runs it right away. Focused questions work better than bare keywords.

#### Content and Entities

| Content | Entities |
|---|---|
| ![Content: the memory just saved appears in the list](../../assets/webui-v0.5.32/en/memory-content.jpg) | ![Entities: ClickHouse selected, with the memories that mention it](../../assets/webui-v0.5.32/en/memory-entities.jpg) |

**Content** lists memories where the Provider can enumerate them; query-only Providers show content once you enter a query. **Entities** uses only real entity indexes, currently Mnemon Native, Hindsight and Holographic. Each entity's count is the number of memories that carry it across the active spaces, and the list shows every entity. Selecting one lists exactly those memories, most important first, at once. Below them, **Find related memories** runs recall for the entity among memories that do not carry it. Recall takes longer, so it runs only when asked for: once opened, it stays open for the next entities until you hide it, for the rest of the browser session. When no memory carries a name you entered, related memories show by themselves.

#### Save to memory

![Save to memory on the Memory Spaces page](../../assets/webui-v0.5.32/en/memory-remember.jpg)

**Save to memory** here works like the conversation's dialog with **Let the Agent decide**: write the candidate, send it to the task Agent, and view the result under **Content** from the receipt. Open **Advanced options** only when a target, category or importance is genuinely required.

### Skills

![Skills: every skill by where it lives, one shadowed; release-notes with an improvement waiting](../../assets/skills-v0.5.34/en/skills-library.jpg)

**Skills** is the page of the experimental Skills component, with five tabs of its own: **Skills** to switch, use, edit and restore the DSH skills a workspace loads; **Evolution** for what self-evolution suggests, its drafts and their evidence; **Evals** for every skill's test cases and backtests; **Market** to search skills.sh and install from GitHub repositories, Agent Skills sites and catalogs; **Trash** restores or permanently deletes removed skills. With **Sidebar entry** on, the page becomes a sidebar entry of its own and leaves the Memory System. The [Skills guide](./skills.md) walks through each tab, with a screen for each.

### On a phone

| Conversation | Memory Spaces | Configuration |
|---|---|---|
| ![A conversation at 390 px: the turn memory bar's items sit below each tool](../../assets/webui-v0.5.32/en/narrow-chat.jpg) | ![The Memory Spaces page at 390 px](../../assets/webui-v0.5.32/en/narrow-spaces.jpg) | ![The Memory composition board at 390 px](../../assets/webui-v0.5.32/en/narrow-plugin.jpg) |

At 390 px the sidebar becomes DSH's icon rail and the pages stack. Long names truncate. These captures do not establish complete phone support; see [known limits](../reference/compatibility.md).

## On the Plugins page

![Open Plugins, find dsh-mnemon under Installed plugins and open it, open the main strategy menu, visit the Layered strategy's and Memory Spaces' pages, then scroll to Storage and Interface](../../assets/webui-v0.5.32/en/plugins.gif)

| DSH's Plugins page | The dsh-mnemon page |
|---|---|
| ![DSH's Plugins page: built-in plugin settings, experimental plugins, and dsh-mnemon under Installed plugins](../../assets/webui-v0.5.32/en/plugins-list.jpg) | ![The dsh-mnemon page under Plugins: header, Memory composition and component rows](../../assets/webui-v0.5.32/en/plugin-composition.jpg) |

On DSH 0.2.1, the **Plugins** page lists built-in plugin settings and experimental plugins, then **Installed plugins**, where dsh-mnemon has its switch; DSH 0.2.0 groups plugins as official and installed. The name opens dsh-mnemon's page. DSH keeps a plugin's configuration on its own page under **Plugins**. The `dsh-mnemon` page (可组合记忆 in Chinese) has **Memory composition**, **Storage** and **Interface**, then DSH's list of the components the Starter includes. **Open Memory System** at the top leads back. Each component's own settings live on its own page.

| Where | Contains | Applies |
|---|---|---|
| Memory composition | Main strategy; one switch per memory source and enhancement | At once, to future turns |
| Storage | Storage scope, data directory, backup and migration | Scope and directory with their **Apply**; ZIP import and export at once |
| Interface | Memory System entry, turn memory bar, save to memory | At once |
| Runtime memory's page | User profile scope; capacity limits | Scope at once; capacities with **Apply** |
| Memory Spaces' page | Memory providers and the Mnemon Native embedding | Switches at once; typed connections with **Apply** |
| Layered strategy's page | Task Agent model and idle review | Choices at once; review limits with **Apply** |

A change saved from another window, or an edit of the profile, shows up without a reload. After **Sync now**, **Merge here only**, a ZIP import or an applied **Memory reconciliation** plan here, the Memory System reads its open page again, so going back to it shows what they brought in. An automatic sync runs in the background; use **Refresh** in the Memory System header to see what it brought in.

### Memory composition

![The main strategy selector: Layered strategy and General strategy](../../assets/webui-v0.5.32/en/plugin-strategy-menu.jpg)

- **Main strategy** is one selector listing each installed main strategy with its description. The **Layered strategy** keeps runtime memory resident, reads Documents and Memory Spaces on demand and runs the background maintenance. The **General strategy** offers every available source in one budget and lets the model decide, without automatic review or capacity maintenance.
- **Memory sources** and **Enhancements** follow, one row per component with its state, a switch, and a gear when it has settings. Chips name the components a row needs or that depend on it; each opens that page.
- A problem line appears only while memory is not composed as chosen, with the one switch that fixes it.

Every switch applies to future turns; a turn that already started keeps its View. Turning a component on also turns on what it needs and turns off what cannot run beside it; turning one off also turns off what depends on it; choosing a main strategy turns the others off. The last running source stays on. When a switch moved other components or changed what composes memory, a toast says so with **Undo**.

### Component pages

![The Layered strategy's page with its background tasks](../../assets/webui-v0.5.32/en/plugin-layered.jpg)

The gear on a row, the gear beside **Main strategy**, and a component's name anywhere open its page. It shows the component's state and switch, whether it ships with dsh-mnemon or came from an installed package, what it needs, what depends on it and what cannot run beside it, its declared options and its own settings. A related name opens in place with **Back**. Options are checked against the Host's limits; **Apply** appears once one changes, and **Reset to default** restores one.

<a id="memory-spaces-page"></a>

![Memory Spaces' page with Mnemon Native and the third-party Providers](../../assets/webui-v0.5.32/en/plugin-spaces.jpg)

- **Runtime memory's page**: **User profile scope** and **Capacity limits**. *Shared globally* combines a global `USER.md` with workspace or custom `MEMORY.md`, without moving either. Set each capacity in bytes and choose **Apply**, or **Discard changes** to restore the saved values. Lowering a limit does not delete existing entries; see [Runtime Memory budgets](../reference/configuration.md#runtime-memory-budgets).
- **Memory Spaces' page**: the **Memory providers**. Mnemon Native comes first and, expanded, holds only its embedding settings. Every third-party Provider has its own switch and is off by default; its endpoint, key and fields appear once it is on. The Global or Workspace tag shows its effective scope. OpenViking's **User key owner (skip admin)** field selects one user namespace for keys without admin access; see [its limits](./memory-providers.md#operational-boundaries).
- **Skills' page**, tagged **Experimental**: **Self-evolution**, and while it is on, independent **Suggest new skills** and **Suggest skill improvements** switches, **Backtest drafts** and the folded **Review parameters**; **In the conversation** for the line under each turn; **Sidebar entry**. Switches apply at once, the parameters with **Apply**; see the [Skills guide](./skills.md#settings).
- **Layered strategy's page**: **Background tasks**. **Task Agent model** chooses the model of the task Agents behind Save to memory, Ask Agent, Tidy names and descriptions, smart selection for new spaces and document archiving, never of the main conversation: **Follow global**, **Follow the conversation** or **Custom**. [Configuration](../reference/configuration.md#background-task-agent-model-route) explains each choice. **Idle review**, **Write runtime memory**, **Keep review limits after reopening** (off by default), its method and Agent Teams compatibility apply at once; **Review limits** apply with **Apply**. With **Write runtime memory** off, review only creates Documents. With persistent limits enabled, the workspace shows attempts for this parent session, restored usage and its next earliest review time. Persistence errors pause automatic review and show recovery guidance; regular conversation and manual actions remain available. Review runs only after turns the Layered strategy composed; see [configuration](../reference/configuration.md#provider-requirements).

![Skills' page under Plugins: Self-evolution, Backtest drafts, Review parameters, In the conversation and Sidebar entry](../../assets/skills-v0.5.34/en/plugin-skills.jpg)

<details>
<summary>Mnemon Native embedding</summary>

Expand the Mnemon Native card. **Manage embedding settings in DSH** makes the saved endpoint, model, protocol and optional key authoritative for Mnemon child processes, including Desktop launches that do not read shell startup files. While it is on, those fields apply together with their **Apply**. Automatic protocol selection treats an endpoint ending in `/v1` as OpenAI-compatible; other endpoints need an explicit protocol. The URL rejects embedded credentials, queries and fragments. Memory and query text are sent to the configured service. **Test status** checks saved values, not an unsaved draft. It requires Mnemon CLI 0.2.13 or newer; older or unrecognized binaries show an upgrade instruction. The status reports model usability, so a reachable service with a missing model reads **Embedding model unavailable**, even when existing vectors have 100% coverage. It counts the vectors of every Mnemon Native space and lists each one under the total, an inactive space included; a space that cannot be read shows the reason and stays out of the total. A space that lacks vectors is marked, since memories without a vector are left out of semantic matching. While the selected embedding model is available, its **Fill in** creates them through the Host, with the storage root and embedding settings DSH uses, which a terminal `mnemon embed --all` may not share. A fill runs for at most a minute, in steps no longer than one Mnemon call (`timeoutMs`, at most ten seconds), so other memory work goes on between them, and Mnemon keeps every vector it wrote. The line under the list then says how many it filled in, how many are still missing, in which case **Fill in** goes on, or that the service returned none, as when it does not serve the model. See [embedding configuration](../reference/configuration.md) before turning it on.

</details>

### Storage

![Storage: the scope, the default data directory, backup, and the Interface settings](../../assets/webui-v0.5.32/en/plugin-storage.jpg)

**Storage** names the components that keep their data in its directory; each name opens that component's page.

- **Storage scope**: **Global** shares one directory across workspaces; **Workspace** keeps each workspace's memory in its own `.mnemon`; **Centralized · isolated by workspace** keeps each workspace in `workspaces/<workspace-path-hash>/` under one root. [Storage scopes](../reference/configuration.md#storage-scopes) describes each, the custom directory included.
- **Memory reconciliation** merges what two machines wrote differently; **Check remote** under **Git sync** leads here. **Reconcile** asks an agent for a plan, **What to accomplish** states your goal, and only an accepted plan is applied, all of it or the operations you tick. [Memory reconciliation](./operations.md#memory-reconciliation) explains each step.
- **Data directory**: **Default** or **Custom**, and the row shows the one directory memory uses. Default is `MNEMON_DATA_DIR` or `~/.mnemon`. Custom opens a field for an absolute path or one starting with `~/`; under Centralized it sets the root. An empty field waits for a path; choosing **Default** is how you return to the default. On hosts with a native DSH chooser, **Choose directory** fills the same draft; cancellation changes nothing, and saving still requires **Apply**. Other hosts keep the manual field.
- Scope and directory apply together with **Apply**, which states the consequence: memory reads and writes the new location, and existing data is never moved, merged or deleted.

![Backup and migration: an exported ZIP previewed before a safe import](../../assets/webui-v0.5.32/en/plugin-backup-preview.jpg)

**Backup and migration** exports the current data directory as a ZIP, with the components Storage names, and never includes third-party Provider data or credentials. Importing first shows a verified preview of what the ZIP contains; **Safe import** merges it into the current directory. See [backup and recovery](./operations.md#backup-and-recovery).

**Git sync** publishes that same payload to a Git repository and pulls it on another machine. Its switch sits under **Storage** and is off by default; switched on, the row opens one card in the order it is set up: **Repository**, a GitHub sign-in or an address; **Sync**, with **Sync now** and **Check remote**; **Automatic sync**; **Backup history**; and **Advanced**. [Git repository sync](./operations.md#git-repository-sync) explains each part, and [seeing every machine's backups and differences](./operations.md#seeing-every-machines-backups-and-differences) covers **Check remote** and the history.

### Interface

- **Memory System opens in**: **Sidebar** (default) or **Conversation tab**.
- **Turn memory bar** and **Save to memory action** turn the conversation controls on or off.

### DSH's component list

![DSH's component list: each component named as it declares itself](../../assets/webui-v0.5.32/en/plugin-rows.jpg)

Below the configuration, DSH lists the components the Starter includes under the names and descriptions they declare. DSH 0.2.1, pictured, lists no row for the Starter's group entry; DSH 0.2.0 adds it as `mnemon-bundle`, shown as `dsh-mnemon/bundle`, and its "Off" state does not affect anything. A component's name opens DSH's page for it, which carries the same component page as the board.

![DSH's own page for the Layered strategy](../../assets/webui-v0.5.32/en/plugin-row-page.jpg)

## Inspected and effective workspace

| Concept | Selected by | Affects |
|---|---|---|
| **Inspected workspace** | The Memory System header | Which `<workspace>/.mnemon` the pages show and edit |
| **Effective workspace** | The current conversation's working directory | Which root conversation tools, commands and lifecycle hooks use |

You can inspect project B while talking in project A. The conversation stays on A; Save to memory, Ask Agent, Tidy names and descriptions and document archiving started from the Memory System run as task Agents scoped to B. Remote Provider namespaces never change with the DSH workspace. Global and custom storage resolve to one root and need no alignment.

<a id="theme-skin-overrides"></a>

## Theme and skin overrides

Skin authors can start with [Skin development and Mnemon integration](../development/skin-integration.md) for an example, migration from generated classes and verification in a real WebUI. This section defines the supported contract.

The sidebar and the conversation tab expose one workspace root: `[data-dsh-plugin="dsh-mnemon"][data-dsh-part="mnemon-view"]`. Set these custom properties directly on that element; values on an ancestor are shadowed by the workspace defaults. Generated CSS-module class names are not public selectors.

| Property | Accepted value and purpose | Default |
|---|---|---|
| `--mn-bg` | CSS color for the base surface | `var(--dsw-alias-bg-base)` |
| `--mn-backdrop` | CSS color behind the base in the default layered surface | `var(--dsw-alias-bg-overlay, var(--mn-bg))` |
| `--mn-surface` | CSS `background` value for the workspace, header and canvas | Base gradient over backdrop gradient, backed by the base color |
| `--mn-block-fill` | CSS background for large informational blocks, excluding badges, selected states and capacity bars | `var(--mn-fill)` |

The default surface is `linear-gradient(var(--mn-bg), var(--mn-bg)), linear-gradient(var(--mn-backdrop), var(--mn-backdrop)) var(--mn-bg)`. The layered backing keeps text readable when a skin makes the host base transparent; the official theme stays opaque. A skin can replace the composition, for example:

```css
[data-dsh-plugin="dsh-mnemon"][data-dsh-part="mnemon-view"] {
  --mn-bg: rgb(232 241 249 / 74%);
  --mn-backdrop: var(--mn-bg);
  --mn-surface: var(--mn-bg);
}
```

Use the paired selector in an unlayered stylesheet. Its specificity `(0,2,0)` beats the defaults `(0,1,0)` whether the skin loads before or after Mnemon. A lone `[data-dsh-part="mnemon-view"]` ties the defaults and depends on load order, and a declaration inside `@layer` ranks below them. Add your skin's own ancestor selector when it needs an activation scope. Dialogs portaled to the body and other plugins' roots are outside this scope. Replacing `--mn-surface` is the skin's choice of readability and transparency; it changes no settings, memory or Provider behavior.

## Interaction conventions

Memory surfaces follow one set of conventions everywhere:

- **One mark**: the turn memory bar, Save to memory and the Memory System in the sidebar share the brain mark; DSH's database icon means usage, not memory.
- **One name, one receipt**: writing to long-term memory is called **Save to memory** everywhere, and the task Agent, or the place you choose in a conversation, answers with the same receipt.
- **Names over identifiers**: memories are referred to by title, content and space name, never by raw id or path; **Copy ID** stays on the cards for when you need one.
- **The same controls**: search boxes, choices, switches and dialog buttons use DSH's input, selector, switch and outlined Cancel; menus and tooltips open above dialogs.
- **Refresh lives in the header**: **Refresh** reloads the open page; pages carry no refresh or sync buttons of their own.
- **Weight of an action**: primary actions use DSH's primary button and secondary ones such as Edit an outlined button; red is reserved for Delete, Disconnect, Archive and Forget.
- **One-line descriptions**: each page and group describes itself in one line; the details live in these guides.
- **Status shows what runs**: Status lists the running Providers and sums up the rest in one line with Open configuration.

Also: a memory space's switch controls only whether dsh-mnemon reads it, not the Mnemon CLI's default store; deleting a Mnemon Native space asks for confirmation, while external spaces use Disconnect and leave Provider data untouched; repeated clicks, including choosing the value already selected, never blank a page.

Next: [Capability map](./capabilities.md) · [Getting started](./getting-started.md) · [Providers](./memory-providers.md) · [Configuration](../reference/configuration.md)
