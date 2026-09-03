# Configuration Reference

[简体中文](../zh-CN/configuration.md) | **English** | [Documentation Center](./README.md)

## Configuration Location and Activation

The plugin registers the `mnemon` namespace with the DSH settings service. User configuration is stored in:

```text
$DSH_HOME/settings.yaml
```

The default is commonly `~/.dsh/settings.yaml`. All current settings are marked `live`; after Save, the Host initializes a candidate runtime graph and then switches to it atomically.

Executing turns retain their pinned runtime. An already-dispatched child retains its delegated runtime until that activation is disposed, even if its parent has finished; later parent turns and newly delegated activations use the new generation. Saving settings does not silently expand an existing task's Recall authority.

The Web settings page edits `storageScope`, the independent `runtimeUserScope`, `dataDir`, Mnemon Native's Ollama embedding override, one master switch for each of the three memory Layers, the background task Agent model route, and the Turn memory and Save-to-memory switches under `mnemon-ui`. Global and Workspace define the scope of the complete memory system; the USER.md profile may explicitly remain global while project memory follows that scope. Mnemon Native owns its Custom data location, embedding runtime, and ZIP backup/migration controls. Each external provider has a collapsible service configuration for reusable endpoints, credentials, or executables. Enabling or saving it discovers the provider's existing namespaces and maps them into Memory Spaces → Overview; disabling it removes those local mappings without deleting provider data. Other advanced settings must be changed directly in YAML.

## Complete Example

```yaml
mnemon:
  storageScope: global # global | workspace | custom
  runtimeUserScope: storage # storage | global
  # dataDir: ~/mnemon-data       # required for custom
  # cliPath: /opt/homebrew/bin/mnemon
  # store: legacy-store          # compatibility discovery hint, not a regular routing target
  timeoutMs: 10000
  defaultRecallLimit: 10
  runtimeMemory:
    memoryLimitBytes: 10240
    userLimitBytes: 4096
    maintenanceMaxTokens: 8192
  embedding:
    enabled: false
    endpoint: http://localhost:11434
    model: nomic-embed-text
  memoryTopology:
    layers:
      runtime: { enabled: true }
      documents: { enabled: true }
      memory-spaces: { enabled: true }
  recallQuality:
    policy: strict-v1
    lowScoreThreshold: 0.25
    highScoreThreshold: 0.6
    candidateMultiplier: 3
    maxMediumResults: 4
    maxUnknownResults: 2
  routingGuidance: true
  lifecycleEnabled: true
  recallMode: guided
  writebackMode: guided
  idleReviewMs: 30000
  tabEnabled: true
  writeEnabled: true
  taskAgentModel:
    mode: inherit # inherit | fixed
    # provider: deepseek # required for fixed
    # model: deepseek-chat # required for fixed
  remoteAccess: read-only # rc.2 only: read-only | trusted-host
```

## Options

| Setting | Default | Range | Implementation Semantics |
|---|---:|---|---|
| `storageScope` | `global` | `global` / `workspace` / `custom` | Controls the root for Runtime, Documents, Memory Spaces, and reserved state as one unit |
| `runtimeUserScope` | `storage` | `storage` / `global` | Keeps USER.md in the selected storage root, or overlays the global USER.md while project MEMORY.md and the other layers stay selected-scope |
| `dataDir` | unset | absolute path, `~`, or `~/...` | Required for `custom`; legacy configurations that set only this option automatically resolve to `custom` |
| `cliPath` | auto-discovered | executable path | Explicitly selects the Mnemon CLI |
| `store` | unset | `[A-Za-z0-9][A-Za-z0-9_-]*` | Compatibility discovery/preference hint for legacy Stores; semantic operations are routed through Memory Spaces |
| `timeoutMs` | `10000` | 100–120000 ms | Hard timeout for a single CLI call |
| `defaultRecallLimit` | `10` | 1–50 | Default recall count for the service and UI; individual entry points may impose a lower limit |
| `runtimeMemory.memoryLimitBytes` | `10240` | 1–1048576 bytes | UTF-8 byte limit for the complete `MEMORY.md` projection |
| `runtimeMemory.userLimitBytes` | `4096` | 1–1048576 bytes | UTF-8 byte limit for the complete `USER.md` projection |
| `runtimeMemory.maintenanceMaxTokens` | `8192` | 1–1000000 tokens | Completion-token budget for Runtime migration and compaction workers; does not change Document archive or metadata-maintenance budgets |
| `embedding` | `{ enabled: false, endpoint: http://localhost:11434, model: nomic-embed-text, apiKey: '', protocol: auto }` | enabled + HTTP(S) endpoint + model + optional apiKey + protocol (auto/ollama/openai) | When enabled, the Host injects the saved endpoint, model, API key, and protocol override into every Mnemon CLI child process; an endpoint ending in `/v1` makes Mnemon use the OpenAI-compatible protocol with the API key as a Bearer token, and `protocol: openai` forces it for non-`/v1` endpoints; when disabled, existing Host environment and Mnemon defaults remain untouched |
| `memoryTopology.layers.<id>.enabled` | `true` for the three defaults | boolean | Whether the Layer participates; disabling never deletes or migrates existing data |
| `recallQuality.policy` | `strict-v1` | registered policy id | Deterministic policy applied before recall content is serialized to an Agent or client |
| `recallQuality.lowScoreThreshold` | `0.25` | 0–1, below high threshold | Normalized scores below this boundary are removed by `strict-v1` |
| `recallQuality.highScoreThreshold` | `0.6` | 0–1, above low threshold | Retained normalized scores at or above this boundary are labeled high relevance |
| `recallQuality.candidateMultiplier` | `3` | 1–5 | Expands each Provider request before filtering, capped by the service limit of 50 candidates |
| `recallQuality.maxMediumResults` | `4` | 0–50 | Maximum medium-relevance rows admitted by `strict-v1` after all high-relevance rows |
| `recallQuality.maxUnknownResults` | `2` | 0–50 | Maximum unscored or unknown-scale rows admitted by `strict-v1` after scored evidence |
| `routingGuidance` | `true` | boolean | Whether to register an additional tiered-routing system section |
| `lifecycleEnabled` | `true` | boolean | Whether to enable the pre-step cue and score-based background review |
| `recallMode` | `guided` | `guided` / `off` | Whether to inject one durable on-demand recall cue per session; does not remove explicit recall |
| `writebackMode` | `guided` | `guided` / `off` | Whether to inject one durable hot-memory cue per session and enable scored, dirty-admitted background review; does not remove explicit writes |
| `idleReviewMs` | `30000` | 5000–600000 ms | Required continuous idle time after the threshold is reached |
| `displayMode` | `sidebar` | `sidebar` / `builtin`; legacy `buildin` accepted | Entry placement: standalone Sidebar or a conversation tab using the same workspace UI; legacy spelling is migrated to `builtin` |
| `tabEnabled` | `true` | boolean | Whether to mount the selected entry and workbench; Host RPC, commands, and Agent tools remain registered when off |
| `writeEnabled` | `true` | boolean | Whether to expose semantic write tools, write RPC, and write commands |
| `taskAgentModel` | `{ mode: inherit }` | `inherit` / `fixed` | Model route for independent task Agents used by AI metadata, Agent Query, memory distillation, and Document archiving, plus the idle-review worker; `fixed` requires both `provider` and `model` and also pins their bounded workers for write, answer, provider placement, migration, compaction, archive, and metadata maintenance. Conversation Recall and Related are direct Host reads and do not use this route |
| `remoteAccess` | `read-only` | `read-only` / `trusted-host` | DSH 0.1.1-rc.2 compatibility policy for non-loopback Mnemon management RPC; startup-only and ignored by DSH 0.1.2-alpha.5 |
| `mnemon-ui.turnBar` | `true` | boolean | Turn-tail memory activity bar; on by default, **applies live after saving** |
| `mnemon-ui.saveAction` | `true` | boolean | “Save to memory” icon and confirmation on finalized assistant replies; on by default, **applies live after saving** |

Both the `mnemon` Host/storage namespace and the `mnemon-ui` browser-presentation namespace apply live. The storage root switches atomically only after the new runtime graph initializes successfully. Legacy `mnemon.conversationInteraction` values remain a migration default, but new saves write only to `mnemon-ui`.

### Runtime Memory budgets

Long conversations can raise the two hot-memory byte limits and the bounded migration/compaction worker budget without patching generated package files:

```yaml
mnemon:
  runtimeMemory:
    memoryLimitBytes: 20480
    userLimitBytes: 10240
    maintenanceMaxTokens: 32768
```

The defaults preserve the released 10240 / 4096 / 8192 behavior. Saving the block builds a new runtime generation, so subsequent Runtime reads, writes, capacity maintenance, and Mnemon Pack validation use the same limits. Existing entries and the `memories.json` format are unchanged. Lowering a byte limit below current usage does not delete data; the Runtime view reports the over-capacity state and further writes require compaction or a higher limit. Rollback only requires removing the block or restoring the defaults.

The isolated DSH Web comparison below shows the default USER 4.0 KB / MEMORY 10.0 KB limits first, followed by the active USER 10.0 KB / MEMORY 20.0 KB configuration. Both captures use an empty temporary root and contain no private memory.

[![Runtime Memory default and configured capacity comparison](../assets/screenshots/runtime-memory-capacity-configuration.png)](../assets/screenshots/runtime-memory-capacity-configuration.png)

### Mnemon Native embeddings

Finder- and Dock-launched macOS applications do not normally inherit interactive shell startup files. Enable **Manage embedding settings in DSH** under Mnemon Native to make the saved values authoritative for every Mnemon child process instead:

```yaml
mnemon:
  embedding:
    enabled: true
    endpoint: http://127.0.0.1:11434
    model: qwen3-embedding:0.6b
```

For an OpenAI-compatible server, point the endpoint at its `/v1` base URL; Mnemon automatically switches from the Ollama protocol to the OpenAI protocol (`/v1/embeddings`). Fill in `apiKey` for services that require authentication; it is sent as a Bearer token. For compatible endpoints that do not end in `/v1`, set the protocol explicitly with `protocol: openai`:

```yaml
mnemon:
  embedding:
    enabled: true
    endpoint: http://127.0.0.1:8080/api
    model: bge-m3-mlx-8bit
    apiKey: sk-...
    protocol: openai
```

The Host copies its normal process environment and then overwrites `MNEMON_EMBED_ENDPOINT`, `MNEMON_EMBED_MODEL`, `MNEMON_EMBED_API_KEY`, and `MNEMON_EMBED_PROTOCOL` for the child only (`protocol: auto` injects no protocol variable and leaves Mnemon's `/v1` auto-detection in charge). It does not modify the desktop session, `launchctl`, shell files, or Mnemon's persisted data. Saving swaps to a new runtime graph, so later calls use the new values without restarting DSH. With `enabled: false` or an omitted `embedding` block, dsh-mnemon supplies no override: inherited variables and Mnemon's built-in defaults keep their previous behavior. `MNEMON_EMBED_DIMENSIONS` remains an advanced inherited environment setting.

The endpoint must be an absolute HTTP(S) URL without credentials, query parameters, or a fragment. Mnemon sends memory and query text to this service; the API key is stored in the DSH settings file like other settings, and a remote plain-HTTP endpoint exposes that text in transit, so use a trusted loopback endpoint or HTTPS. **Test status** runs the effective `mnemon embed --status` command for the current default Store and reports embedding-server reachability, model, the resolved protocol when Mnemon reports one, and embedding coverage without backfilling or changing memories. Save pending edits before testing so the check cannot claim an unsaved value is active.

### Memory Layer switches

Each Layer has one master switch. `enabled=true` permits the default strategy to use the Layer when needed; it does not force recall or writes on every turn. `enabled=false` stops that Layer's context injection, model calls, background processing, and data-plane Web/RPC operations together.

[![The isolated English v0.3 settings page gives each default Memory Layer one master switch](../assets/screenshots/settings-memory-layers-en.jpg)](../assets/screenshots/settings-memory-layers-en.jpg)

Disabling is reversible routing state, not deletion. The corresponding Sidebar tab remains visible with an Off badge and does not read the data plane; Status, Catalog, and management directories remain observable. Re-enabling uses the original directories and data.

[![The actual English Sidebar after disabling Documents: its tab remains while data is neither read nor deleted](../assets/screenshots/sidebar-layer-disabled-en.jpg)](../assets/screenshots/sidebar-layer-disabled-en.jpg)

The WebUI reads the live `memory-system` descriptor, so a Layer contributed by an extension does not require a frontend enum change. Settings submit only changed `enabled` Booleans under one revision fence. If the candidate runtime graph cannot validate, the current generation remains active. The Kernel still authoritatively checks capability, trigger source, and Guards, but those are not ordinary-user settings in v0.3.

### Recall quality policies

`strict-v1` is the Agent-safe default: for Providers that explicitly declare a normalized 0–1 relevance score, non-positive and below-threshold rows are removed before their content reaches an Agent. It then returns every high-relevance row up to the requested limit, at most four medium-relevance rows, and at most two unscored or unknown-scale rows by default; it does not fill the result limit with weaker evidence. `balanced-v1` retains low-score rows only after primary evidence, and `exhaustive-v1` preserves finite scored rows for direct inspection. An out-of-range score is treated as unknown-scale instead of being fabricated into a confidence value. Cross-provider ordering continues to use reciprocal-rank fusion.

Policies are pure, bounded host extensions. A plugin may call `registerRecallQualityPolicy(policy)` before the runtime graph is constructed, then select that policy id in configuration. Invalid limits, decisions, or selections fall back to `strict-v1`; an unknown configured id rejects the candidate runtime graph. Filtering counts are returned as structured `source.quality` statistics and are not appended to Agent hints.

### Browser authentication

One branch-free registration path supports both verified DSH versions. Mnemon always supplies the trailing authority object required by 0.1.1-rc.2; the 0.1.2-alpha.5 two-argument JavaScript implementation naturally ignores it, so no package-version check or capability branch is involved.

On DSH 0.1.1-rc.2, `remoteAccess` remains a real startup security boundary and cannot be changed through Web settings. The default `read-only` mode keeps settings, ZIP backups, Provider connections, and broad mutations loopback-only; `trusted-host` promotes all three management channels together and must be used only behind reliable deployment authentication. DSH `trustedHosts` is a Host/Origin fence, not user authentication.

DSH 0.1.2-alpha.5 removes those method-specific privilege tiers and authenticates every Mnemon RPC through the browser session established by its one-time launch token and signed cookie. It ignores `remoteAccess`, which remains accepted solely so the same plugin configuration can roll back to rc.2 safely. `writeEnabled=false` is a product-level read-only mode in both versions; it is not a substitute for transport authentication.

For the complete proxy, profile-patch, trusted-authority, restart, and verification workflow, see [Cloud-hosted WebUI on stable DSH rc.2](./operations.md#cloud-hosted-webui).

## Storage Scopes

### `global`

```text
MNEMON_DATA_DIR when non-empty
  otherwise ~/.mnemon
```

Suitable for users who want Runtime, Documents, and Memory Spaces shared across multiple workspaces. Other Mnemon-enabled agents can also share the Mnemon Memory Spaces when they use the same root.

### `workspace`

```text
Agent / tool / lifecycle: resolve(currentSession.header.cwd, ".mnemon")
Web workbench inspection: resolve(workspaceRegistry.get(selectedWorkspaceId).path, ".mnemon")
```

Each DSH workspace owns an independent three-tier memory root. Conversation Agents, model tools, commands, and lifecycle hooks route by the current session cwd. Independent task Agents launched from the Web workbench instead use the selected Host-registered workspace explicitly; the browser can never submit an arbitrary path. AI metadata, Agent Query, memory distillation, and document archiving therefore target the workspace selected at the top left even when no main session is selected.

Headless has no `workspaceRegistry`; its fresh session cwd is the directory from which `dsh --profile headless ...` was launched, so `workspace` resolves directly to `<invocation cwd>/.mnemon`.

### Global USER.md with workspace project memory

To share user-level collaboration requirements across repositories while keeping project facts isolated, select **Workspace** plus **Global user profile**, or configure:

```yaml
mnemon:
  storageScope: workspace
  runtimeUserScope: global
```

Each turn then projects `USER.md` from the global root (`MNEMON_DATA_DIR` when set, otherwise `~/.mnemon`) together with `MEMORY.md` from `<workspace>/.mnemon`. `target=user` mutations and local USER.md compaction go only to the global source; `target=memory`, Documents, Memory Spaces, and Provider state remain workspace-scoped. Global MEMORY.md and workspace USER.md entries stay intact on disk but are not projected in this mode.

Changing this setting never copies, merges, or deletes entries. Switching back to `runtimeUserScope: storage` reveals the selected root's original USER.md again. A Mnemon Pack still represents one selected storage root, so a workspace Pack does not silently include the separate global USER.md; back up the global root separately when that profile is important.

### `custom`

```yaml
mnemon:
  storageScope: custom
  dataDir: /absolute/path/to/mnemon-data
```

`~` and `~/...` are also allowed. Relative paths are rejected.

### Choose a Cross-Agent Sharing Scope

| Goal | Recommended scope | Notes |
|---|---|---|
| Share durable memory among local agents | `global` | Every participant uses `~/.mnemon` or the same `MNEMON_DATA_DIR` |
| Share one explicit data root | `custom` | Every participant configures the same absolute directory for isolation and backup |
| Share only inside one project | `workspace` | Every participant aligns its Mnemon root to that project's `<workspace>/.mnemon` |

Mnemon Native interoperates with other Mnemon-enabled agents through `data/<store>/mnemon.db`; third-party engines interoperate through their configured provider scope. Runtime, Documents, DSH activation state, and UI metadata remain managed by dsh-mnemon. See [Long-term memory providers](./memory-providers.md).

External service settings, Memory Space scope settings, and secrets are stored in `state/memory-providers.json` under the selected scope root, not in `settings.yaml`. Multiple Memory Spaces reuse one provider service configuration; the Host merges both layers only at runtime. The Mnemon Native ZIP contains only Runtime, Documents, and native Memory Spaces; external service data, credentials, and local third-party stores are excluded.

## CLI Discovery Precedence

```text
config.cliPath
  -> executable MNEMON_CLI_PATH
  -> each PATH directory
  -> Windows: GOBIN/mnemon.exe
              first GOPATH/bin/mnemon.exe, or ~/go/bin/mnemon.exe
              %LOCALAPPDATA%/Programs/mnemon/mnemon.exe
              %ProgramFiles%/mnemon/mnemon.exe
  -> Unix: ~/.local/bin/mnemon
           /opt/homebrew/bin/mnemon
           /usr/local/bin/mnemon
           /usr/bin/mnemon
```

An explicit `cliPath` accepts either a path or a command name on PATH (for example, `mnemon`). Status checks and execution share the discovery rules and recognize CLI installation/removal on recheck without restarting DSH. If the explicitly configured command is unavailable, calls report a launch error rather than silently selecting another CLI. Automatically discovered Windows commands must be regular `.exe` files. `.cmd` and `.bat` wrappers are intentionally excluded because process execution does not use a shell.

## Compatibility Store Hint Precedence

```text
config.store
  -> MNEMON_STORE
  -> <storageRoot>/active
  -> default
```

After the Memory Space directory has been established, long-term semantic operations use explicit Memory Space IDs and do not rely on the global active Store for routing.

## Background Task Agent Model Route

AI metadata, Agent Query, workbench/conversation memory distillation, and document archiving create a clean independent top-level task Agent. It uses the selected workspace as its cwd, works even when no main Agent session is selected, and is disposed after the task finishes.

The default `inherit` mode first uses the DSH Provider / Model selected for new sessions, then falls back to a complete route from the current available main Agent. Choosing **Choose model provider** in Settings stores a complete Provider + Model and overrides only Mnemon background tasks; it does not change the conversation Agent. When semantic judgment requires a bounded worker inside that task Agent, the worker inherits the task Agent route.

```yaml
mnemon:
  taskAgentModel:
    mode: fixed
    provider: deepseek
    model: deepseek-chat
```

DSH 0.1.1-rc.2 includes each model's declared input modalities in the live catalog. dsh-mnemon preserves that metadata and labels image-capable choices as **Image input**; the 0.1.1 prerelease line's first-party image-capable entry is `deepseek-official/deepseek-v4-flash-vision-exp`. Selecting it does not make current Mnemon background jobs ingest images: AI metadata, Agent Query, distillation, smart selection, and Document archive still submit text and bounded evidence. In the main conversation, DSH-owned image blocks keep their durable attachment references when dsh-mnemon appends lifecycle guidance, while activity thresholds count text blocks only. Raw image bytes are not copied into Runtime, Documents, or Memory Spaces.

## Provider Requirements

Regular workers prefer `spawn`. If no provider has that name, another provider with all of the following capabilities can be selected:

```text
outputSchema = true
toolFilter   = true
persona      = true
depthLimit   = true
```

Background review has no fallback: a compatible provider named `fork` must exist and must have:

```text
inheritsParentContext = true
```

A missing `fork` does not block deterministic state or regular UI reads, but a subagent failure is recorded when the review threshold is reached.

## Read-Only Configuration

```yaml
mnemon:
  writeEnabled: false
```

Effects:

- Model write tools are not registered;
- `/dsh-mnemon-write` RPC is not registered;
- `/mnemon remember` and `/mnemon forget` are rejected;
- semantic mutations through `MnemonService` are rejected.

This is feature-level read-only behavior, not a read-only filesystem mode: the Runtime controller may still initialize or repair projections, Document search updates LRU access times, and Mnemon read commands may trigger upstream database migrations. Do not treat `writeEnabled=false` as a safety guarantee for read-only mounts.

## Switch Interactions

```text
writeEnabled=false
  -> overrides all explicit semantic writes

writebackMode=off
  -> no write cue, no scored review
  -> explicit writes remain when writeEnabled=true

recallMode=off
  -> no recall cue
  -> explicit recall remains

lifecycleEnabled=false
  -> no lifecycle cues or review
  -> UI, commands, and explicit tools remain

routingGuidance=false
  -> removes only mnemon:routing
  -> runtime-memory context remains
```

## Entry Placement: `displayMode` and `tabEnabled`

Memory System defaults to Sidebar, opening a dedicated center-column workbench with a minimal, logo-free skin aligned with official DSH panels. Set `displayMode: builtin`, or select Builtin in Settings, to put that same workspace in the current conversation's `conversation.view` tab instead. Pages, navigation, dialogs, and styling remain shared; there is no separate builtin UI.

The sidebar entry is an explicit navigation action: clicking it again keeps the workspace open; use “Back to conversation” to close it. Switching to the task board or SSH synchronizes both visibility and entry state, so a missed peer activation notification cannot prevent reopening Memory System.

Builtin omits the header's storage-mode badge, workspace picker, and alignment controls. Every read, write, and independent task request follows its owning session through the existing Host routing:

| `storageScope` | Builtin read/write root |
|---|---|
| `global` | Shared `MNEMON_DATA_DIR` or `~/.mnemon`, regardless of the session workspace |
| `workspace` | The current session's `<cwd>/.mnemon`; switching conversations follows their respective workspaces |
| `custom` | Configured `dataDir`, regardless of the session workspace |

The existing `runtimeUserScope: global` exception still keeps USER.md global. Changing placement does not change scope, migrate memory data, or revive the old builtin navigation. Settings RPC applies entry changes live.

The canonical spelling is **`builtin`**. Historical `displayMode: buildin` preferences ignored by v0.4.0–v0.4.1 are accepted again, but runtime and UI state normalize them to `builtin`. On startup and external settings changes, the Host rewrites that one field through DSH's revision-fenced settings writer. Old-client RPC writes also persist `builtin` directly. Other fields and document comments are preserved; an explicit newer Sidebar choice wins a concurrent migration.

If the old value comes only from a composition profile, migration saves a canonical user-setting override instead of rewriting the profile file. A read-only settings provider still recognizes the alias but is not written; a persistence failure is reported in the Host log without disabling the normalized entry.

`tabEnabled=false` removes the selected entry and workbench live; enabling it again restores the configured placement. The two entries are mutually exclusive. Host RPC, commands, and tools remain registered, so an Agent or command already in progress stays valid. Turn memory and Save to memory remain independently controlled by `mnemon-ui` and navigate to the selected placement.

## Profile Patch Overrides

The bundled `cordis.patch.yml` provides the default config row. A DSH profile configuration with the same ID may replace that row as a whole. Do not add only `cliPath` to a final profile patch: use `MNEMON_CLI_PATH` or the `mnemon.cliPath` user setting instead. When a profile patch must be customized for another reason, retain every key that must remain enabled instead of assuming a deep merge.

The cloud rc.2 `remoteAccess` override is one such whole-row customization. Use the complete, upgrade-aware example in the [cloud-hosted WebUI procedure](./operations.md#cloud-hosted-webui), not a standalone `config: { remoteAccess: trusted-host }` fragment.

## Common Configurations

Workspace isolation:

```yaml
mnemon:
  storageScope: workspace
```

The same workspace isolation inside each conversation:

```yaml
mnemon:
  storageScope: workspace
  displayMode: builtin
```

An explicit Windows CLI path:

```yaml
mnemon:
  cliPath: 'C:\Users\alice\AppData\Local\Programs\mnemon\mnemon.exe'
```

A custom data volume and a longer CLI timeout:

```yaml
mnemon:
  storageScope: custom
  dataDir: /Volumes/AgentData/mnemon
  timeoutMs: 30000
```

Keep explicit tools while disabling lifecycle behavior:

```yaml
mnemon:
  lifecycleEnabled: false
```

Disable only background writeback decisions:

```yaml
mnemon:
  writebackMode: off
```
