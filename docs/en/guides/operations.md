# Operations, Security, and Troubleshooting

[简体中文](../../zh-CN/guides/operations.md) | **English** | [Documentation hub](../README.md)

## Health checks

Check the binary, then open **Status** in the workbench:

```sh
command -v mnemon
mnemon --version
```

Windows PowerShell:

```powershell
Get-Command mnemon -ErrorAction SilentlyContinue
Test-Path "$env:LOCALAPPDATA\Programs\mnemon\mnemon.exe"
```

```text
/mnemon status
```

[![Status with component versions, three-tier data, and effective directories](../../assets/webui-v0.5.4/en/status.jpg)](../../assets/webui-v0.5.4/en/status.jpg)

Status shows Mnemon / dsh-mnemon versions, Runtime, Memory Spaces, Documents, and effective directories. `mnemon status` opens the effective Store and may initialize data or run upstream migrations, so it is not a completely side-effect-free probe.

## Version checks and updates

**Check versions** on Status opens the version panel:

[![Check and update Mnemon CLI and dsh-mnemon](../../assets/webui-v0.5.4/en/versions.jpg)](../../assets/webui-v0.5.4/en/versions.jpg)

- **Mnemon CLI**: installed from `mnemon --version`; latest from the official `@mnemon-dev/mnemon` npm package.
- **dsh-mnemon**: installed from the running package; updates from npm `latest`. An installed beta/alpha/rc also checks its own channel and can graduate to a newer stable version. Stable users never opt into prereleases automatically.

Checking is read-only and never installs automatically. Update appears only when a newer version exists and the source is safely recognized. Mnemon supports the official npm launcher, Homebrew Cask / Formula, and `go install`; dsh-mnemon supports npm installations managed by pnpm in the owning DSH Profile. `link:` / `file:` development builds and unrecognized manual installs show guidance only.

npm updates require the active launcher to belong to the global root reported by the current npm. A different Node/npm installation or a broken launcher shows repair guidance instead. Use `npm install --global @mnemon-dev/mnemon@latest` to install or migrate, then `mnemon update` for later updates. The commands run on the DSH Host and need Node.js 22+. After changing PATH or a CLI override, recheck the executable path shown in the dialog.

Expand dsh-mnemon's subpackage list to inspect Sources, Strategies, and Providers. Starter pins update with the Starter. Only independently installed packages in the owning Profile can update individually; source links are preserved. Package writes are serialized, and restart reminders survive subsequent checks and reopening the dialog. Read-only connections retain checks and command copying; page updates require management authority and `writeEnabled`.

![Expanded subpackages with installed versions, Starter pins and local-source maintenance](../../assets/webui-v0.5.4/en/versions-expanded.jpg)

Go updates additionally require the active executable to resolve to the current Go installation output (`GOBIN`, or the first `GOPATH` entry's `bin` directory), with no cross-compilation target. A downloaded binary is not a Go-managed installation merely because it contains Go build metadata. CLI updates must verify that the active executable actually reaches the checked release before reporting success.

The Host fixes update commands and arguments. The browser cannot supply either; shell is disabled and execution/output are bounded. A plugin update installs the exact checked version in its owning profile and verifies the installed package before reporting success; pinned beta versions cannot silently remain on an older release. After an update, the UI rechecks both components and refreshes Status automatically. Mnemon applies on the next CLI call. Restart `dsh web` after updating dsh-mnemon.

The opt-in SQLite incompatibility first called out for DSH rc.8 remains in DSH 0.1.1-rc.2. It applies only to `@deepseek-ai/dsh-session-persistence-sqlite`, which shipped profiles do not select. The rc.2 backend uses schema version 17, rejects older schemas, and provides no migration path: deployments that mounted it manually should back up and recreate the DSH session database. dsh-mnemon's Runtime, Documents, Memory Spaces, and Provider data use separate storage roots and are unaffected.

## DSH 0.1.5 compatibility and legacy Session recovery

DSH `0.1.5-rc.1` is the npm `latest` release verified by this checkout. Restart the Web Profile after upgrading Mnemon: the Starter patch gives the owning `connection` entry both `webRuntime` and `webServer`. This restores all seven Mnemon RPC channels when **Memory System** or its Settings page previously returned HTTP 405. Custom profiles that install the Host without the Starter must apply the same dependency declaration to their connection entry, preserving any additional dependencies in their own composition. No DSH package source is changed; browser authentication and Mnemon grants still apply.

The separate error `source summary requires notice form; source v0 artifact remains unchanged` comes from older Mnemon messages in DSH Session logs. New recall/instruction messages omit that invalid summary. Updating the plugin does not rewrite an existing Session. To repair one affected log:

1. Stop the owning DSH process. Back up its entire Session storage root, including every generation, separately from a Mnemon Pack. Use the exact `raw log` path reported by DSH; do not search or rewrite unrelated sessions.
2. With the updated Mnemon package installed, preview the command below against a **backup copy**. Use Node `22.19+` or `24+` for `.jsonl.zstd`; plain `.jsonl` also works on Node 20.
3. Write to a new path outside the Session directory. Review `repairedMessages`, `repairedDescriptors`, `expandedToolChunkRows`, `expandedToolChunks`, the SHA-256 report and `blockers`. Preview counts describe candidate changes. Known unsupported shapes cause exit status 1; a requested copy has `mode: "refused"` and no output is published. Existing output files are rejected.
4. In a disposable copy of the Profile, replace only the affected `session.jsonl` or `session.jsonl.zstd` with the repaired copy, retaining the original backup. Let DSH load and resume it, then restart and verify the conversation. Repeat that explicit replacement in the stopped original Profile only after validating the copy. The command itself never replaces the input or a live Session.

```sh
dsh-mnemon-repair-session --input /backup/session.jsonl.zstd
dsh-mnemon-repair-session --input /backup/session.jsonl.zstd --output /backup/repaired-session.jsonl.zstd
```

The executable is installed with `dsh-mnemon`; a Profile-local installation can use `pnpm exec dsh-mnemon-repair-session` from that Profile. In a checkout use `node bin/repair-legacy-session.mjs`. The two stream normalizations below preserve IDs themselves; a proven identity recovery can also apply to the same log. The copy repair supports these audited historical shapes:

| Historical shape | Copy behavior |
|---|---|
| `dsh-mnemon` instructions summary `Optional memory recall and remember reminder`; recall summary `Memory View snapshot` or `Runtime memory snapshot` | Remove only that source's `summary` member. Other plugin messages and unfamiliar summaries remain untouched. |
| Exact historical subagent descriptor v2 with a composition accepted by the frozen v3 contract | Change only its version value to 3. Keep provider, model pair, persona, label and tool filters intact; add no defaults or reasoning effort. Extra fields, unpaired models and unsupported versions are refused. |
| Exact packed `tool-call-chunks` with string `id: ""` or `name: ""` | Expand to the original raw delta events, preserving IDs, name presence, argument strings, sequence numbers and timestamps. No chunk is dropped and provenance references need no renumbering. Already raw empty-string deltas remain byte-identical. |
| Exact raw or packed tool deltas with an own `name: null` member | Keep the member and change its value to `""`; expand packed rows with the same logical sequence and timing. IDs, arguments and durable messages remain intact. Both values leave assembly unchanged, and keeping the member preserves token timing. `normalizedToolChunkNames` counts affected logical deltas. |
| A completed `deepseek-official` stream recorded a unique nonempty provider ID before empty continuation IDs corrupted its durable tool chain | Restore that existing ID only after checking exact ordered chunk provenance, indexed block assembly, matching name/arguments and a unique call/result association. Preserve placeholders before the first candidate, message UUIDs, payloads and other plugin content. Independently proven multiple calls and text/reasoning blocks are supported. No ID is generated. |
| No recorded ID, conflicting identities, interruptions, unknown affected owner shapes or unaccounted approval/dispatch/plugin/copy references | Report blockers and refuse output. Arbitrary empty-ID histories and owner replay state need recovery by their original writer. |

The ID check uses the original stream's complete `sourceEventSeqs`, including packed logical members. Result provenance must select its exact call; if absent, only a unique single-call step with no other attempt qualifies. An explicit wrong reference never uses that fallback. Extra references through sequence numbers or message IDs are checked across step boundaries; ordinary compaction sequence references and unrelated plugins can remain unchanged. `recoveredToolIdentityChains` counts restored chains, `recoveredToolIdentityFields` counts logical identity slots, and `toolIdentityRecoveryRefusals` explains unsupported proofs with bounded location samples.

The tool accepts only v0, valid UTF-8 JSON records and complete ordinary Zstandard frames, with a 128 MiB limit on stored input, decoded input and expanded output. Malformed input, incomplete frames, ambiguous duplicate keys on transformed or identity-proof paths, and unsafe delta coordinates are refused without publishing output. Only the changed summary/version/name/identity members and expanded packed rows are rewritten; every other decoded byte is retained. Diagnostics count every known blocker and include at most ten line/event/path samples per class, without message bodies. `migrationValidated: false` is deliberate: this scanner does not recover unrelated corruption or guarantee that every Session can migrate. The installed official DSH loader and stream replay remain the final checks. See the [issue #251 contract audit and verification](../../pr-assets/issue-251-legacy-repair/README.md).

DSH migrates old Sessions to immutable v3 generations when opening for write. Mnemon Runtime, Documents and Memory Spaces retain their existing formats. To roll DSH back, restore the pre-upgrade Session backup in a separate old-version Profile; do not open v3 generations with an older DSH. See [verification and screenshots](../../pr-assets/issue-223-dsh-015/README.md).

## Backup and recovery

### Recommended: Settings ZIP

**Settings → Memory System → Backup and migration** operates on the **currently effective root**:

- **Export ZIP** includes Runtime, Documents, and every Mnemon Native Memory Space. Third-party connections, local external stores, and remote data are excluded.
- **Import ZIP** previews, validates, then merges into the effective root.
- Packs include `manifest.json`, SHA-256 inventory, and component summaries.
- Export/import hold component locks; a Memory Space with an uncheckpointed WAL is rejected.
- Import checks paths, counts, compressed/expanded limits, JSON schemas, Document hashes, registry consistency, and SQLite headers.
- Merge is staged before replacing component directories; commit failure restores pre-import directories.

The UI offers safe merge, not “overwrite everything”:

- Runtime deduplicates by target and content.
- Identical Document ID + hash is skipped; conflicting content receives a new ID.
- Identical Memory Space ID + database is skipped; conflicting content receives a new ID.

Import is governed by `writeEnabled` and is rejected in read-only deployments. A ZIP contains private memory—encrypt it, restrict access, and rehearse recovery. Provider credentials live in `state/memory-providers.json` with mode `0600`; they are excluded from ZIP. Saved credential values are not returned through management responses either. Protect the entire `state/` directory in the offline snapshot below if connections must be backed up.

![Mnemon Pack preview before safe import into the disposable root](../../assets/webui-v0.5.4/en/backup-preview.jpg)

### Recovery rehearsal

1. Select an isolated `custom` directory and save.
2. Confirm **Current directory ZIP** points to that root.
3. Select the backup, review its preview, then import.
4. Check Runtime, Documents, Memory Spaces, and directories on Status.
5. Run one focused direct recall and read one Document.
6. Only after verification decide whether to switch a production scope.

Never restore directly into the only production root without another backup.

### Filesystem snapshot

To preserve reserved `state` or take an offline complete snapshot, stop every DSH / Mnemon process using the root and copy:

```text
<storageRoot>/runtime
<storageRoot>/documents
<storageRoot>/data
<storageRoot>/state    # when present; outside the built-in Pack's three data components
```

Generate an inventory or checksums and rehearse recovery in isolation. A normal directory copy while writers are running is not a consistent snapshot.

## Changing storage scope

Saving `global` / `workspace` / `custom` / `workspaces` initializes a new runtime graph before switching atomically. The page reloads automatically, but **data is not migrated**:

```text
old scope -- save --> new empty or existing root

no automatic copy
no automatic merge
no automatic delete
```

Recommended migration: export from the old scope → switch and confirm the new root → import → verify. In Workspace mode, confirm both inspection and execution targets.

With `workspaces`, back up the complete central directory for every workspace, or export a Pack for the selected workspace only. A renamed/moved workspace receives a new path hash; restoring its old data is an explicit operator action.


Existing turns and delegated child activations may still use the old runtime. Wait for them to finish or cancel them before moving or retiring its data. Parent completion alone does not release an asynchronous child's delegation; a newly created or cold-resumed activation captures its own authorized generation.

<a id="cloud-hosted-webui"></a>

## Cloud-hosted WebUI on DSH 0.1.5-rc.1

DSH 0.1.5-rc.1 is the recommended registry target. It authenticates the page, every RPC, and every stream through an authority-bound browser session created from the launch-token URL printed by the Host. `--trusted-host` remains a Host/Origin fence; it does not replace HTTPS or deployment access controls.

1. Terminate HTTPS at a reverse proxy or access gateway and protect the public entry for its intended users. Proxy the same-origin `/` and `/api` traffic, including streams, to `http://127.0.0.1:3080` while preserving the external `Host` authority.
2. Start the loopback service with the external authority. Use a bare `host[:port]`, not a URL:

   ```sh
   dsh web --trusted-host memory.example.com --no-open
   ```

   For a non-default public port, use the exact authority, for example `memory.example.com:8443`. DSH deliberately rejects `--host 0.0.0.0`; keep the service on loopback and let the proxy or an SSH tunnel reach it.
3. For a browser that does not already have a valid cookie for this public authority, use the launch-token URL printed as `dsh web: ...`. With a reverse proxy, replace only the printed loopback origin with the public HTTPS origin and preserve the `/` path and `?token=...` query. For example, transform `http://127.0.0.1:3080/?token=...` into `https://memory.example.com/?token=...`. Treat that URL as a credential and do not put it in logs, tickets, or chat. DSH exchanges it for an HttpOnly, SameSite cookie and redirects to a clean `/`; a still-valid authority-bound cookie can survive a Host restart.
4. Open the clean external URL and verify that **Status** and **Settings → Memory System** both load and a page reload remains authenticated. Remote settings are read-only by default. If management is intended, apply the [explicit remote management grant](#remote-management), restart DSH, then verify one deliberate small save.

An HTTP 403 can indicate a Host/Origin mismatch or an old remote Client still using standalone channels: check `--trusted-host`, the public authority and proxy routing, then upgrade dsh-mnemon to v0.5.5 or later, restart DSH and reload the browser. Remote Mnemon calls use the authenticated API Gateway. An HTTP 401 requires restoring the Host's browser authentication or pairing. A response saying remote management requires `remoteAccess: trusted-host` is a separate Mnemon grant check; successful browser authentication alone does not authorize management.

### Disable the complete Starter

The legacy `mnemon` Entry remains the lifecycle switch for the complete Starter. To disable Mnemon without leaving its Source or Strategy Entries waiting on the missing Host service, add this profile patch and restart DSH:

```yaml
- id: mnemon
  disabled: true
```

This disables the Core/Host, all three bundled Sources, the default Strategy, and all three optional Strategy enhancements together. It does not remove installed packages or delete memory data. Remove the override, or change it to `false`, and restart DSH to enable the Starter again.

<a id="remote-management"></a>
<a id="dsh-011-rc2-rollback"></a>

### Remote management and DSH 0.1.1-rc.2 rollback

For v0.5.5 authenticated Gateway clients, `remoteAccess: trusted-host` grants management operations; default remote reads and narrow activation do not need it. The previous DSH rc.2 line enforces the same local configuration through legacy method-authority tiers, with settings, backups and broad mutations loopback-only by default. Configure management only for the intended authenticated users.

1. Open `~/.dsh/profiles/web/cordis.patch.yml`, or `$DSH_HOME/profiles/web/cordis.patch.yml` when `DSH_HOME` is set. Edit an existing top-level `- id: mnemon` entry instead of adding a duplicate. If the initialized file still ends in `[]`, replace that marker with the complete row below; otherwise append the row to the existing top-level YAML list:

   ```yaml
   - id: mnemon
     config:
       routingGuidance: true
       lifecycleEnabled: true
       recallMode: guided
       writebackMode: guided
       idleReviewMs: 30000
       tabEnabled: true
       writeEnabled: true
       remoteAccess: trusted-host
       timeoutMs: 10000
       defaultRecallLimit: 10
       embedding:
         enabled: false
         endpoint: http://localhost:11434
         model: nomic-embed-text
       recallQuality:
         policy: strict-v1
         lowScoreThreshold: 0.25
         highScoreThreshold: 0.6
         candidateMultiplier: 3
         maxMediumResults: 4
         maxUnknownResults: 2
   ```

   A profile patch replaces the targeted row's complete `config` instead of deep-merging one field. Preserve existing customizations, and compare it with `dsh web --dump-default-config` after a plugin upgrade so new bundled defaults are not masked.
2. Inspect the effective tree with `dsh web --dump-config`. Confirm that the final `mnemon` row contains `remoteAccess: trusted-host` and that stderr reports no unmatched `mnemon` target.
3. Start DSH with the same `--trusted-host` command, and restart after any `remoteAccess` change because Mnemon captures that policy at startup. Verify **Status**, settings loading, and one deliberate small save through the authenticated remote connection.

## Security boundaries

### Process

- CLI uses `spawn(command, args, { shell: false })`.
- stdout + stderr are capped at 2 MiB by default.
- Calls use `timeoutMs` and AbortSignal; cancellation sends `SIGTERM`, then `SIGKILL` after 1.5 seconds.
- One Runner serializes calls; separate DSH processes still rely on Mnemon / SQLite concurrency.

### Files

- Runtime, Documents, and Pack operations use in-process queues or component locks.
- Lock wait defaults to 5 seconds; stale threshold is 30 seconds.
- Writes use temporary files, staging, and rename.
- Runtime revisions block stale compaction; Document revisions block movement of updated originals.
- `sourcePaths` cannot escape the initiating workspace or point into managed Documents.

### Web and model

- DSH owns authentication or pairing for remote RPCs and streams. The v0.5.5 Mnemon Gateway projection additionally requires `remoteAccess: trusted-host` for management; local loopback clients retain their legacy channels.
- On DSH 0.1.1-rc.2, read and activation use `trusted-host`; write, settings, and backup default to `loopback` and are promoted together only by local `remoteAccess: trusted-host` configuration.
- Provider catalogs and management responses are redacted; the UI receives configured field names, never saved credential values.
- The WebUI follows the Host's writable settings snapshot instead of inferring capability from transport locality; an unavailable settings channel renders an explicit diagnostic rather than an empty page.
- The WebUI neither reads SQLite, starts processes, calls remote providers, nor supplies arbitrary update commands; provider network access remains inside the Host.
- Workers use persona, tool allowlists, and `maxDepth: 1`. A stable result tool accepts only the current child's revocable request ID and validates each operation's result schema.
- Distillation and supervised writeback workers cannot call `mnemon_forget`. Idle review has only the create-only Documents tool for document writes, so it cannot replace user originals or archive documents to make room. These restrictions are enabled by default and do not require an enhancement plugin.
- Queries, candidates, Document bodies, and historical memory are treated as untrusted data.

These boundaries are not a secret scanner. There is no deterministic credential detection; never submit keys, tokens, private keys, or raw sensitive logs.

### Security reporting

Report vulnerabilities privately through [SECURITY.md](../../../SECURITY.md), not a public issue. Data loss, path traversal, lock/revision bypasses, subagent-isolation breaks, and injection through rendered memory are in scope.

## Troubleshooting

`mnemon.cliPath` accepts an explicit path or a command name resolved against the Host's PATH. If the binary is installed or restored into an existing search directory while DSH is running, click Recheck to refresh availability without restarting. Changes to the Host process's environment still require a restart. Status and version checks resolve the same configured command.

| Symptom | Check and resolution |
|---|---|
| Mnemon unavailable | macOS/Linux: run `command -v mnemon`, `mnemon --version`. Windows PowerShell: run `Get-Command mnemon`, `Test-Path "$env:LOCALAPPDATA\Programs\mnemon\mnemon.exe"`. Set `MNEMON_CLI_PATH` or `mnemon.cliPath`, then restart |
| Electron desktop Host cannot run npm CLI scripts | Verified npm launchers use child-only `ELECTRON_RUN_AS_NODE=1`. If the desktop shell disables the [Electron `runAsNode` fuse](https://www.electronjs.org/docs/latest/tutorial/fuses#runasnode), this flag is ignored; set `mnemon.cliPath` to the official native binary (`mnemon.exe` on Windows). Automatic npm updates still require a Host that can run the JavaScript launcher |
| Headless Agent has no Mnemon tools | Plugins are profile-local. Run `dsh plugin --profile headless add dsh-mnemon`; a Web-profile installation does not carry over |
| Memory System entry missing | Check `tabEnabled=true`; `displayMode=sidebar` uses the sidebar, while `displayMode=builtin` uses the open conversation's tabs. For a local link run `pnpm run build`, then restart the profile |
| A retained `buildin` preference opens a conversation tab after upgrading | v0.4.2 restores that preference and saves it as `builtin`; select Sidebar to keep the standalone entry. Memory scope and stored data are unchanged |
| Status healthy but recall empty | Check active spaces, storage scope, inspected root, effective session root, and query focus |
| Header reports misalignment | Confirm that the inspected workspace is intended. Workbench tasks execute there; conversation tools retain their own session scope |
| Saved settings appear unchanged | Inspect the save error; success applies live and reloads automatically without refresh |
| Custom directory rejected | Use an absolute path, `~`, or `~/...` |
| `memoryBodyId is required...` | Active count is not exactly one; select a target explicitly |
| `memory space is not active for reading` | Activate it in Overview; inactive writes are allowed, reads are not |
| Provider error | Semantic work needs full isolation capabilities; background review additionally needs `fork + inheritsParentContext` |
| Runtime replace exceeds capacity | Shorten it or organize first; automatic maintenance handles add overflow only |
| Document source path rejected | Keep it inside the session workspace and outside managed Documents |
| CLI timeout | Increase `timeoutMs`; large Stores may need more than 10 seconds for status or graph |
| Lock timeout | Check other writers; never delete a lock owned by a live process |
| Memory System goes blank with a `refreshSnapshot` or settings-store error | Upgrade dsh-mnemon to v0.4.1 and restart the owning DSH profile; settings callbacks preserve their host store receiver |
| ZIP export reports `date not in range 1980-2099` | Upgrade dsh-mnemon to v0.4.1; fixed local ZIP date fields work in timezones behind UTC and keep identical exports byte-stable across timezones |
| ZIP export reports WAL busy | Wait for Memory Space writes to settle; do not bypass the uncheckpointed-WAL guard |
| ZIP import checksum/schema failure | The backup is damaged or incompatible; preserve the current root and never unzip over it manually |
| No Update button | Already current, remote check failed, or the source is link/manual; follow panel guidance |
| An authenticated remote page can read or activate a Memory Space but cannot save settings or perform other writes | Default management restriction; for intended remote management, preserve the current configuration, set `remoteAccess: trusted-host` locally, and restart DSH |
| On alpha, Mnemon RPC returns 401 after a DSH restart or authority change | Open the launch URL printed by `dsh web` so the one-time token can establish a fresh authority-bound browser cookie |

## Known limitations

### Feature read-only is not disk read-only

`writeEnabled=false` disables semantic mutation and Pack import, but startup may initialize/repair Runtime, Document search updates `lastAccessedAt`, and Mnemon reads may migrate a database.

### Shared Documents scope

`global` and `custom` can share one Document index across workspaces; records have no independent workspace-ownership field. `sourcePaths` are checked against the initiating cwd only when written.

### Cross-system transactions

Cold-index-first protects active content but is not a rollback-capable distributed transaction across Mnemon SQLite and the filesystem. A revision conflict after indexing may leave a duplicate reference; the system preserves data.

### Background watermark

Activity score, latest checkpoint, and retry state are not persisted. Host restart clears unprocessed activity. Failure backoff, circuit breaking, and manual retry are not implemented yet.

### Versions and internationalization

There is no formal fixed DSH / Mnemon support matrix. The main Web interface is bilingual, while commands, tool cards, compatibility metadata, and some errors remain partially untranslated.

## Document archive recovery

Document archive no longer asks the worker to number remember/recall receipts. If an older attempt left a cold index while the document stayed active, retrying can reuse an index whose exact path and content hash match the current revision. Updated documents need a matching new revision index. Providers with asynchronous extraction or no safe forget are rejected before indexing. A cleanup failure names the destination and newly created id; keep existing data until the outcome is established.

## Runtime archive recovery

Capacity archival requires an active Memory Space whose Provider supports exact writes and safe forget. Asynchronous extraction targets, including Hindsight, are excluded before any archive write. If no eligible target remains, activate a suitable space or increase `runtimeMemory.memoryLimitBytes`; the rejected mutation and existing hot entries stay unchanged. Direct Provider writes retain their existing asynchronous behavior.

Conversation archival uses the selected Source's write scope: known spaces activated during the turn and spaces created by that View can receive the archive. A space created elsewhere after the View was pinned requires a new turn. An empty scope never grants access to every space. Destination errors distinguish an empty directory, an empty or excluding View scope, and unsupported Provider capabilities, and report the catalog, authorized and writable counts. The pending add has not been saved on failure; retry the same tool input in a new turn after correcting the reported cause. Existing hot entries are preserved.

If an archive receipt or local commit fails, the Host attempts to forget only entries proven newly created by this attempt. Skipped or reused entries are preserved. A changed or unreadable Runtime revision after a commit error is treated as uncertain: archive entries are retained to avoid losing committed memory. Cleanup errors identify the remaining destination and item ids. A Provider request that fails without receipts may have an unknown remote outcome, so this is not a distributed transaction; inspect that Provider before retrying.

## Optional workspace services

See [Composable workspace services](workspace-services.md) for independent Sources, policies, activation, data ownership and retained acceptance evidence.
