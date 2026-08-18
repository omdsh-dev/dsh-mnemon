# Operations, Security, and Troubleshooting

[简体中文](../zh-CN/operations.md) | **English** | [Documentation hub](./README.md)

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

[![Status with component versions, three-tier data, and effective directories](../assets/screenshots/status-overview.png)](../assets/screenshots/status-overview.png)

Status shows Mnemon / dsh-mnemon versions, Runtime, Memory Spaces, Documents, and effective directories. `mnemon status` opens the effective Store and may initialize data or run upstream migrations, so it is not a completely side-effect-free probe.

## Version checks and updates

**Check versions** on Status opens the version panel:

[![Check and update Mnemon CLI and dsh-mnemon](../assets/screenshots/version-check.png)](../assets/screenshots/version-check.png)

- **Mnemon CLI**: installed from `mnemon --version`; latest from Mnemon GitHub Releases.
- **dsh-mnemon**: installed from the running package; latest from the npm registry.

Checking is read-only and never installs automatically. Update appears only when a newer version exists and the source is safely recognized. Mnemon supports Homebrew Cask / Formula and `go install`; dsh-mnemon supports npm installations managed by pnpm in the owning DSH Profile. `link:` / `file:` development builds and unrecognized manual installs show guidance only.

The Host fixes update commands and arguments. The browser cannot supply either; shell is disabled and execution/output are bounded. After an update, the UI rechecks both components and refreshes Status automatically. Mnemon applies on the next CLI call. Restart `dsh web` after updating dsh-mnemon.

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

Import is governed by `writeEnabled` and is rejected in read-only deployments. A ZIP contains private memory—encrypt it, restrict access, and rehearse recovery. Provider credentials live in `state/memory-providers.json` with mode `0600`; they are excluded from ZIP. Saved values are returned only to the loopback settings editor, never through the trusted-host read channel. Protect the entire `state/` directory in the offline snapshot below if connections must be backed up.

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

Saving `global` / `workspace` / `custom` initializes a new runtime graph before switching atomically. The page reloads automatically, but **data is not migrated**:

```text
old scope -- save --> new empty or existing root

no automatic copy
no automatic merge
no automatic delete
```

Recommended migration: export from the old scope → switch and confirm the new root → import → verify. In Workspace mode, confirm both inspection and execution targets.

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

- Read RPC and the activation-only Memory Space control are always `trusted-host`; broader write, settings, and backup RPC remain `loopback` unless local Host configuration explicitly sets `remoteAccess: trusted-host`.
- The trusted-host read-side Provider catalog is redacted. Saved credential values are returned only through the management channel after its configured authority check succeeds.
- The WebUI follows the Host's settings capability result instead of inferring authority from transport locality. Activation and read-only card health refresh remain available through trusted-host channels; an unavailable settings channel renders an explicit diagnostic rather than an empty page.
- The WebUI neither reads SQLite, starts processes, calls remote providers, nor supplies arbitrary update commands; provider network access remains inside the Host.
- Workers use persona, tool allowlists, schema-validated one-run result tools, and `maxDepth: 1`.
- Queries, candidates, Document bodies, and historical memory are treated as untrusted data.

These boundaries are not a secret scanner. There is no deterministic credential detection; never submit keys, tokens, private keys, or raw sensitive logs.

### Security reporting

Report vulnerabilities privately through [SECURITY.md](../../SECURITY.md), not a public issue. Data loss, path traversal, lock/revision bypasses, subagent-isolation breaks, and injection through rendered memory are in scope.

## Troubleshooting

| Symptom | Check and resolution |
|---|---|
| Mnemon unavailable | macOS/Linux: run `command -v mnemon`, `mnemon --version`. Windows PowerShell: run `Get-Command mnemon`, `Test-Path "$env:LOCALAPPDATA\Programs\mnemon\mnemon.exe"`. Set `MNEMON_CLI_PATH` or `mnemon.cliPath`, then restart |
| Headless Agent has no Mnemon tools | Plugins are profile-local. Run `dsh plugin --profile headless add dsh-mnemon`; a Web-profile installation does not carry over |
| Memory System missing from sidebar | Check `tabEnabled=true`, `displayMode=sidebar`; Buildin is in the conversation area; for a local link run `pnpm run build`, then restart |
| Status healthy but recall empty | Check active spaces, storage scope, inspected root, effective session root, and query focus |
| Header reports misalignment | The workbench is inspecting another workspace; align or keep deliberate read-only inspection; Agent-backed actions are rejected |
| Saved settings appear unchanged | Inspect the save error; success applies live and reloads automatically without refresh |
| Custom directory rejected | Use an absolute path, `~`, or `~/...` |
| `memoryBodyId is required...` | Active count is not exactly one; select a target explicitly |
| `memory body is not active for reading` | Activate it in Overview; inactive writes are allowed, reads are not |
| Provider error | Semantic work needs full isolation capabilities; background review additionally needs `fork + inheritsParentContext` |
| `memory subagent stopped with error` | Structured-output delegated runs (`mnemon_remember` / `mnemon_recall` / `mnemon_related` / `mnemon_forget`) fail on DSH 0.1.0-rc.6 when the plugin also passes a `toolFilter` that hides the result-capture tool. Fixed in dsh-mnemon ≥ 0.2.x, which registers a dynamic per-run result tool and includes it in the allowlist. Upgrade to the latest release (`dsh plugin --profile web add dsh-mnemon@latest`) and restart DSH. See https://github.com/omdsh-dev/dsh-mnemon/issues/14 |
| Runtime replace exceeds capacity | Shorten it or organize first; automatic maintenance handles add overflow only |
| Document source path rejected | Keep it inside the session workspace and outside managed Documents |
| CLI timeout | Increase `timeoutMs`; large Stores may need more than 10 seconds for status or graph |
| Lock timeout | Check other writers; never delete a lock owned by a live process |
| ZIP export reports WAL busy | Wait for Memory Space writes to settle; do not bypass the uncheckpointed-WAL guard |
| ZIP import checksum/schema failure | The backup is damaged or incompatible; preserve the current root and never unzip over it manually |
| No Update button | Already current, remote check failed, or the source is link/manual; follow panel guidance |
| Remote page can toggle a Memory Space but cannot perform another write | Secure default; only behind reliable authentication, set `remoteAccess: trusted-host` locally, configure DSH `trustedHosts`, and restart the Host |

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
