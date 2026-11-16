# Lifecycle and Core Workflows

[简体中文](../../zh-CN/reference/workflows.md) | **English** | [Documentation](../README.md)

This page describes the **Layered strategy**, the default. The **General strategy** offers every available Source in one shared budget and leaves routing to the model: named tools serve their own Sources, and every other route is read with `mnemon_view_route` and changed with `mnemon_view_action`. When a profile mounts another Source of one type beside the Starter's, such as a second runtime track, the named tools serve the Starter instance and the other keeps its exact routes and offers. The Layered strategy composes one Source per role, so a second Source of one role there needs **Scoped composition** switched on, which by default admits every eligible Source; without it every turn fails with "found ambiguous … Sources". It has no recall envelope beyond each route's own limits, no Runtime capacity maintenance or archival, and no idle review. See [Strategies and enhancements](../guides/capabilities.md#strategies-and-enhancements).

## Per-Turn Context

The Layered strategy provides stable routing guidance, a static Runtime Memory protocol, and a Wake snapshot message updated when needed:

- `mnemon:routing`: a system prompt section that, when `routingGuidance=true`, provides concise boundaries for tiered queries;
- `mnemon:runtime-memory-protocol`: a system prompt section containing the invariant Runtime Memory semantics and write rules. It is present only while the eager Runtime source participates in automatic projection and remains byte-identical across memory writes;
- Wake snapshot: rendered from the immutable View pinned for the current root turn, carried by an own message with `source.plugin=dsh-mnemon` and `form=recall`. Runtime Memory contributes a complete revisioned USER/MEMORY state snapshot without repeating the static protocol; Documents and Memory Spaces contribute bounded covers rather than their complete catalogs.

The Host appends a new user-role plugin message only when the Wake changes; it does not resend other plugins' shared context. Snapshots remain complete states rather than patches that depend on earlier messages. The static protocol stays in the system prefix, and Source text is transmitted literally without template interpolation. See [Architecture](../development/architecture.md#lifecycle-and-failures) for turn, child-Agent and generation ownership.

The lifecycle pins before the Host assembles the System Prompt, then keeps the same View for every model step in that turn:

```text
turn/start
  -> enter system-prompt/assemble hook
  -> beginTurn(root turn + operation scope)
  -> Source facts → Strategy ViewSpec → validation → Source projection
  -> pin Source revisions/digests and Host-only authority
  -> build bounded Wake
  -> continue the actual Host prompt assembly
  -> align the static protocol section with the pinned Runtime source
  -> append the changed Wake as this plugin's own complete snapshot message

agent/pre-step(step=1)
  -> cancel pending/running idle review for a new turn
  -> mark Prime once
  -> append at most one short recall/writeback cue per session
  -> main Agent decides whether to call a memory tool
```

Source snapshotting does not run semantic recall. Prime only initializes routing state and does not run asynchronous CLI status queries.

A child captures and retains its live parent's pinned View and runtime at `agent/created`, before its driver starts. Its own turns pin that retained View, even after the parent finishes or moves to a newer generation. The delegation is released when the child activation is disposed. A cold resume receives a new delegation; an explicitly Host-created background child with no parent model turn snapshots a fresh scoped View. Children have their own turn authority without root-only cues or idle review. See [the authority lifecycle](../development/architecture.md#lifecycle-and-failures).

### Attended hot-memory capture

The main conversation uses the same conservative admission boundary as idle review: capture explicit, durable user-authored identity/preferences and compact rules needed for future work. Project designs, one-off decisions, configuration/account snapshots, investigations and progress belong in Documents when substantial and writable; otherwise skip them. A generic “remember this” request does not promote a project record into every-turn context. An explicit choice of Runtime, USER.md or MEMORY.md still works through the existing write tools and permissions. Lower importance and branch scope do not make transient records eligible.

These are model-facing routing instructions, not a content classifier or a storage rejection rule. Existing entries, manual edits, correction/removal, branch scoping and capacity handling are unchanged. The model still decides whether a candidate qualifies; the tool description, Layered protocol and short reminders now agree.

### Delegated child sessions

Every task dsh-mnemon delegates to a child Agent starts with one line of its own, `[dsh-mnemon:delegated <operation>]`, and the task follows on the next line: `review` for idle review, `write` for writes and Save to memory, `skill` for skill reviews, drafts, backtests and eval cases, and `answer`, `placement`, `migration`, `compaction`, `document-archive`, `metadata-maintenance` and `reconcile` for the others. Later releases may add operations, so match the pattern rather than this list. DSH records the task as a user message (`source.kind: "user"`) in the child's session, whose header carries `origin: "subagent"` and `parentSession`.

That whole session is dsh-mnemon's own work, not something the user wrote. A plugin that reads sessions, such as one that collects a workspace's work, can leave out a session with `origin: "subagent"` whose first user message after any inherited turns has a first line matching `^\[dsh-mnemon:delegated [a-z-]+\]$`. A forked child starts with a copy of its parent's turns (`isSeeded: true` in its header, ending at `session/end-seed`), and the task follows them. A task that runs outside a conversation, such as Save to memory, Ask Agent and the other tasks started from the Memory System page, runtime memory capacity maintenance and memory reconciliation, runs in a task Agent session of its own with no user message. Its header carries `origin: "subagent"` but no `parentSession` and no `delegationDepth`, so a reader that groups subagents under their parent finds none for it, and it holds no work to collect. Its child carries the line and has that session as its `parentSession`. dsh-mnemon 0.5.32 and earlier stored the task Agent session without `origin` ([#435](https://github.com/omdsh-dev/dsh-mnemon/issues/435)). Sessions recorded before this line existed start with the task itself, for idle review `Bounded completed checkpoint (untrusted evidence; …`, which this contract does not cover. Mnemon's other user-role messages, recall and reminders among them, carry `source.kind: "dsh-mnemon"` ([Compatibility](./compatibility.md#dsh-017-settings-recovery)).

DSH starts a child in its parent's working directory; dsh-mnemon's start request has no directory of its own. dsh-mnemon relies on it too: with a per-workspace storage scope, a child no longer bound to its parent's runtime, such as one resumed after a restart, finds its workspace's memory through it.

## Agent Recall

```text
Root or child Agent calls mnemon_recall(query, optional memoryBodyIds)
          |
          v
resolve the executing Agent's own turn pin and retained runtime
          |
          v
read the pinned Memory Space Source state on the Host
          |
          v
validate requested IDs are a subset; otherwise use every pinned active ID
          |
          v
Memory Spaces Source searches granted Provider namespaces concurrently
          |
          v
quality normalization + reciprocal-rank fusion
          |
          v
drop low relevance and admit at most 4 initial results / 3,600 characters
          |
          v
LLM judges whether the evidence is sufficient
          | yes                         | no
          v                             v
answer without more Recall       explicitly submit one different query
                                        |
                                        v
                              search once, deduplicate, and close Recall
          |
          v
both attempts share at most 6 results, 1,200 characters each,
and 4,800 total content characters for this executing Agent turn
```

This admission envelope is the Layered strategy's per-turn policy; the General strategy applies only each route's own limits and call budget.

The model-facing tool deliberately exposes no `category`, `source`, or `intent` filter: a guessed filter must not hide exact evidence. Recall is not forced: a root turn normally issues zero Provider queries. If the LLM calls it, the Host permits one initial query and at most one LLM-chosen, materially different refinement after evidence inspection. Same-query and concurrent repeats join or replay; a third distinct query runs nothing and says so, without reaching a Provider. One Related traversal may follow, but only from a `memoryBodyId + id` admitted by either Recall attempt; the same traversal again replays its result, and a different one runs nothing.

Recall, Related and the single Documents search slot are budgeted per executing Agent turn. Parallel calls share that turn's state; sibling tasks, later turns and cold-resumed activations do not share cached evidence or consume each other's budget. A child Agent runs its task, from its prompt through its last step, as one turn with one budget; a later message that continues the child starts another turn with a fresh budget. Repeating a Recall or Related read that already ran in the turn replays its own evidence, restricted to the requested Memory Space subset. A different read past the budget, a second Documents search included, runs no query and returns `notRun: true`, `budgetExhausted: true` and an empty `results` under its own query, never another read's evidence; a parallel call first waits for the reads in flight, since a failed one gives its place back. A Related traversal from an insight the turn's Recall did not admit also returns `notRun: true`. Document search is separately bounded to four records, 2,600 query-local characters per record, and 6,000 content characters total. The model-facing Memory Space catalog is capped at 16 entries, and `mnemon_status` returns only a compact health aggregate. Full records, provider settings, paths, and per-Space statistics remain available to Web/RPC control-plane surfaces, not conversation history.

If the user has already supplied current facts, or the repository can answer directly, the Agent should not recall merely to “show memory.”

## Web Retrieval and Agent Queries

The Web “Recall” page follows a different path from model tools:

```text
Direct search
  -> RPC read channel
  -> Source-scoped management search
  -> raw evidence

Agent search
  -> the same deterministic direct search
  -> spawn a worker with no Mnemon tools
  -> answer only from supplied evidence
  -> Host filters citations to actual memoryBodyId/id pairs
```

The Entities and Content pages also use deterministic Source management reads, without a second model. Content uses the Provider browse contract, not semantic recall.

## Explicit Long-Term Writes

The long-term write flow for the root Agent or `/mnemon remember` is:

```text
durable candidate
       |
       v
spawn write worker
       |
       +-- list Memory Spaces
       +-- the named space, or the narrowest suitable active scope
       +-- recall when duplicate/conflict checking is useful
       +-- create a new scope only for a recurring distinct domain
       +-- remember / link / forget / merge as requested
       v
structured receipt
```

The first Memory Space created in an empty storage root uses Mnemon's native `default` ID; the Host generates later IDs. A successful write to an inactive target activates it. This activation affects only DSH routing, and merging a source database is non-destructive.

When `mnemon_remember` names a Memory Space, the worker writes there or nowhere. The Host checks the named space before the worker starts: an unknown space, one whose Provider is off or takes no writes, and one that is switched off fail at once with the reason. A model that wants a switched-off space back switches it on first with `mnemon_memory_body_update`; a space the user picks on the Memory Spaces page comes back on with the write. A guard DSH attaches to the worker before it runs refuses `mnemon_remember` or `mnemon_link` into any other space, and any creation or change of spaces.

Without a named space, the worker chooses among active spaces and those it creates; the guard refuses a write or a link into a space that was switched off when the run started, and switching such a space on. Saving a memory never merges spaces. Save to memory follows the same rules, so with every space switched off it saves nothing unless the worker creates a space. The result's `memoryBodyIds` are the spaces the Source receipts name, including a write inside a Code Mode program that failed afterwards; a worker that reports a write no receipt shows ends as `unknown`. `activatedMemoryBodyIds` lists a switched-off space the write switched on. A worker from a provider that runs no local child runs unguarded, as before; a local worker DSH publishes out of the guard's sight fails the write instead. Once its run has ended, a delegated worker is refused memory tools: DSH 0.2.1 resumes a finished worker from its saved state when another Agent sends it a message, and that worker cannot write again.

Mnemon Native saves a memory without a vector when embedding does not succeed, the service down or its model missing, and says so in its receipt (`embedded: false`). A write through the task Agent lists such memories in `unembedded`, with a `hint`: semantic matching misses them until their vectors are filled in, from **Test status** in the Mnemon Native embedding settings once the embedding service answers, while keyword, link and recency recall still reach them. That runs through the storage root and embedding settings DSH uses, which a terminal `mnemon` command may not share. `/mnemon remember` adds a line that says so, and so does the receipt of **Save to memory**, in a conversation or on the Memory Spaces page, whether the task Agent wrote the memory or the text went straight to a space; the line appears only when the write put a memory somewhere. Its wording follows the `embedding` setting alone. While DSH does not manage it (`enabled: false`, the default), DSH sets up no embedding service, and the line is a neutral note that adds that keyword search still finds the memory. The note is the same when a service that DSH does not manage produced no vector, such as one set up only in the environment the Mnemon CLI inherits, or an Ollama at Mnemon's default endpoint that is down or lacks the model. While DSH manages it, the line says embedding did not succeed, in the receipt's caution colour. The `hint` the model reads is the same either way.

Runtime `add` / `replace` / `remove` and Document `create` / `update` do not need a model to perform storage I/O; they enter the deterministic control layer through the coordinator. Only capacity maintenance and archiving start dedicated workers.

## Runtime add: Normal Path

```text
request
  -> normalize content
  -> acquire in-process queue and file lock
  -> reload memories.json
  -> validate unique match / duplicate / capacity
  -> write temporary JSON and Markdown projections
  -> rename projections
  -> rename memories.json as the commit marker
  -> return compact receipt
```

`replace` and `remove` prefer a unique full-content match through `old_text` within the requested target; only when no exact match exists do they use a unique substring. Duplicate exact entries remain ambiguous. Capacity maintenance is triggered only when the requested add or size-increasing replacement would exceed the target limit.

## USER.md Capacity Maintenance

Capacity maintenance and the MEMORY.md archival below are part of the Layered strategy. With the General strategy, a write that would exceed a Runtime limit is rejected instead.

```text
USER add exceeds 4 KiB
          |
          v
snapshot revision + committed entries
          |
          v
spawn no-tool local compactor
          |
          v
return compacted entries + sourceIndexes
          |
          v
Host validates:
  - every source index appears exactly once
  - no duplicate or out-of-range index
  - importance is not lowered
  - candidate fits the Host byte budget
  - revision is still current
          |
          +-- invalid/conflict -> preserve original data
          |
          v
deterministic UTF-8 packing
          |
          v
retry pending add
```

The user profile is never sent to Memory Spaces. The worker has no tool permissions.

## MEMORY.md Archival and Compaction

```text
Layered strategy: pending MEMORY mutation exceeds the configured limit (10 KiB by default)
          |
          v
snapshot revision + committed entries eligible for archival
(exclude the pending add and the entry being replaced or removed)
          |
          v
Host selects existing active writable Memory Spaces within this operation's Source and namespace scope
          |
          +-- none anywhere (layer off or no automatic writes, no ready Provider,
          |   no active space with exact writes and safe forget)
          |     -> Runtime Source appends the entries compaction leaves out to
          |        runtime/archived/, then commits the compaction and the pending
          |        mutation under the same lock; no model and no Provider writes
          |
          v
One destination: Host routes directly
Several destinations: independent no-tool worker returns source-index routes only
  On model execution failure, Host falls back within eligible destinations
          |
          v
Host validates exact source coverage, destinations, authority, and source revision
          |
          +-- invalid/revision changed -> no Provider writes; preserve Runtime
          |
          v
Host writes each original entry exactly to its planned existing Space
  - committed receipt -> bind destination digest
  - skipped -> require exact Recall evidence
          |
          v
Host retains exact runtime entries by importance within its byte budget
          |
          v
CAS compactAndMutate(revision, compaction, original mutation, lineage)
  -> persist JSON and both Markdown projections as one local commit
```

The planner has no data-plane tools and cannot create a Space. The Host owns every write, verifies one durable destination for every committed source entry, and changes Runtime only after all evidence is valid. A late cross-process revision conflict still preserves the original runtime memory entries; because a remote Provider cannot share the local file lock, already committed durable copies are retained as safe duplicates rather than destructively rolled back.

### Runtime archive recovery

Capacity archival writes to an active Memory Space whose Provider supports exact writes and safe forget. Asynchronous extraction targets, including Hindsight, are excluded before any archive write. When no Memory Space at all can take the archive, because the layer is off or takes no automatic writes, no Provider is ready, no space is active or only unsupported Providers remain, the Runtime Source appends the entries compaction leaves out to its local archive in `runtime/archived/`, under the same lock and just before it commits the compaction and the pending write: `MEMORY.md` to read and `memories.jsonl` with each entry's metadata. A space that another Memory Spaces Source could take it into, or a Runtime Source too old to keep what compaction leaves out, still refuses. Mnemon Packs do not carry the local archive, and importing one keeps it. Direct Provider writes retain their existing asynchronous behavior.

Conversation archival uses the selected Source's write scope: known spaces activated during the turn and spaces created by that View can receive the archive. A space created elsewhere after the View was pinned requires a new turn, so a write whose only eligible spaces lie outside the View's scope, or that the View offers no writes to, is refused rather than archived locally. An empty scope never grants access to every space. Destination errors distinguish an empty directory, an empty or excluding View scope, and unsupported Provider capabilities, and report the catalog, authorized and writable counts. The pending add has not been saved on failure; retry the same tool input in a new turn after correcting the reported cause. Existing runtime memory entries are preserved.

If an archive receipt or local commit fails, the Host attempts to forget only entries proven newly created by this attempt. Skipped or reused entries are preserved. A changed or unreadable Runtime revision after a commit error is treated as uncertain: archive entries are retained to avoid losing committed memory. Cleanup errors identify the remaining destination and item ids. A Provider request that fails without receipts may have an unknown remote outcome, so this is not a distributed transaction; inspect that Provider before retrying.

## Document Creation, Update, and Archiving

```text
create/update request
          |
          v
capacityPlan using rendered UTF-8 bytes
          |
     +----+----+
     |         |
    fits     overflow
     |         |
     v         v
 commit    select least-recently-used active Document
               |
               v
          snapshot document + revision
               |
               +-- no Memory Space anywhere can take the index
               |     -> move file to archived without an index, no worker
               |
               v
          spawn archive worker
               |
               v
       write/verify concise Mnemon cold reference
       with title, summary, planned path, SHA-256
               |
          +----+----+
          |         |
        failed    receipt ok
          |         |
          v         v
   keep active   revision check
                    |
               +----+----+
               |         |
             conflict   current
               |         |
               v         v
          keep active  move file to archived
                             |
                             v
                    retry original mutation
```

Manual archiving uses the same “index first, move second” path, and the same local archive when no Memory Space can take the index. When the Mnemon index succeeds but a revision conflict occurs, the index is not rolled back, so a safe duplicate reference may remain while the active original text is never lost.

### Document archive recovery

Document archive no longer asks the worker to number remember/recall receipts. If an older attempt left a cold index while the document stayed active, retrying can reuse an index whose exact path and content hash match the current revision. Updated documents need a matching new revision index. Providers with asynchronous extraction or no safe forget are rejected before indexing. When no Memory Space at all can take the index, the Document is archived locally without one: its original moves to the archive and stays readable on the Project Documents page. A cleanup failure names the destination and newly created id; keep existing data until the outcome is established.

## Deterministic Activity Scoring and Idle Review

Completed turns accumulate four signals:

```text
score =
  min(floor(totalUserCharacters / 50), 3)
  + completedTurnCount
  + min(floor(completedToolResults / 5), 2)
  + toolDiversityScore

toolDiversityScore:
  unique tools < 3  -> 0
  unique tools = 3  -> 1
  unique tools >= 4 -> 2

eligible when score >= 5
```

Reaching the threshold does not guarantee a write:

```text
completed turn
      |
      v
score >= 5 ? -- no --> retain activity for later turns
      |
     yes
      |
      v
Host dirty admission
  - explicit no-memory intent in current turn -> stop
  - persistence intent, >=320 user characters,
    >=600 assistant characters, or completed non-Mnemon work -> continue
      |
      v
wait idleReviewMs (default 30 s), and at least
idleReview.minIntervalMs (default 5 min) after the last attempt
      |
      +-- new turn --> cancel timer/worker, retain activity
      |
      v
confirm the Agent is idle, turn/end exists, the turn was composed
by the Layered strategy, and idleReview.maxPerSession is not reached
      |
      v
start a task Agent on the completed turn
  - spawn (default): a bounded checkpoint, idleReview.maxContextChars
  - fork: inherits the parent context
      |
      v
conservative maintenance decision, one layer per pass
  - Documents first: search; create at most one separate document
    for a project record, never update or archive an existing one
  - runtime memory: only new, explicit, durable user assertions;
    MEMORY.md takes compact rules no Document covers, never
    project records (off with idleReview.runtimeMemory: false)
  - after a Document, working memory is refused, and vice versa
  - no Memory Spaces write tools
      |
      +-- completed, including skip -> clear activity
      |
      +-- failed/aborted ------------> retain activity
```

The admission check is deliberately structural rather than an LLM classification, so an eligible but ordinary checkpoint starts no background model. The review Agent's tools are exactly `mnemon_document_search`, `mnemon_runtime_memory` and `mnemon_document_create`, without the runtime tool when `idleReview.runtimeMemory` is `false`. The review guard holds each pass to one layer: the first Document creation or working-memory change it admits claims the pass, and the other is refused even if that first call fails; USER.md changes stay independent. “At most one” document or runtime memory change is still enforced by the persona, not by a Host mutation counter. Memory Spaces receive review output only later, through working-memory capacity archiving and Document cold archiving. While Agent Teams tools are installed, review pauses unless `idleReview.agentTeams: scoped`; the Status page says so while it is paused. Background watermarks are not yet persisted, so a Host restart loses accumulated signals that have not been processed.

## How Configuration Switches Interact

- `recallMode=off`: stops injecting recall cues; explicit `mnemon_recall` remains available.
- `writebackMode=off`: disables writeback cues and scored idle review; explicit writes are still governed by `writeEnabled`.
- `lifecycleEnabled=false`: disables lifecycle reminders and review without removing explicit tools or Web entry points.
- `routingGuidance=false`: removes only the additional routing section; the Runtime Memory context remains registered.
- `writeEnabled=false`: removes semantic write tools and write RPC, and rejects write commands; it does not guarantee a read-only file-system mount.
