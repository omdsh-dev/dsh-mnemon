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
- **dsh-mnemon**: installed from the running package; updates from npm `latest`. An installed beta/alpha/rc also checks its own channel and can graduate to a newer stable version. Stable users never opt into prereleases automatically.

Checking is read-only and never installs automatically. Update appears only when a newer version exists and the source is safely recognized. Mnemon supports Homebrew Cask / Formula and `go install`; dsh-mnemon supports npm installations managed by pnpm in the owning DSH Profile. `link:` / `file:` development builds and unrecognized manual installs show guidance only.

Go updates additionally require the active executable to resolve to the current Go installation output (`GOBIN`, or the first `GOPATH` entry's `bin` directory), with no cross-compilation target. A downloaded binary is not a Go-managed installation merely because it contains Go build metadata. CLI updates must verify that the active executable actually reaches the checked release before reporting success.

The Host fixes update commands and arguments. The browser cannot supply either; shell is disabled and execution/output are bounded. A plugin update installs the exact checked version in its owning profile and verifies the installed package before reporting success; pinned beta versions cannot silently remain on an older release. After an update, the UI rechecks both components and refreshes Status automatically. Mnemon applies on the next CLI call. Restart `dsh web` after updating dsh-mnemon.

The opt-in SQLite incompatibility first called out for DSH rc.8 remains in DSH 0.1.1-rc.2. It applies only to `@deepseek-ai/dsh-session-persistence-sqlite`, which shipped profiles do not select. The rc.2 backend uses schema version 17, rejects older schemas, and provides no migration path: deployments that mounted it manually should back up and recreate the DSH session database. dsh-mnemon's Runtime, Documents, Memory Spaces, and Provider data use separate storage roots and are unaffected.

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

Import is governed by `writeEnabled` and is rejected in read-only deployments. A ZIP contains private memory—encrypt it, restrict access, and rehearse recovery. Provider credentials live in `state/memory-providers.json` with mode `0600`; they are excluded from ZIP. Saved values are returned only through the authenticated management channel, never through the ordinary redacted read catalog. Protect the entire `state/` directory in the offline snapshot below if connections must be backed up.

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

Existing turns and delegated child activations may still use the old runtime. Wait for them to finish or cancel them before moving or retiring its data. Parent completion alone does not release an asynchronous child's delegation; a newly created or cold-resumed activation captures its own authorized generation.

<a id="cloud-hosted-webui"></a>

## Cloud-hosted WebUI on stable DSH 0.1.2-rc.1

Stable DSH 0.1.2-rc.1 is the recommended registry target. It authenticates the page, every RPC, and every stream through an authority-bound browser session created from the launch-token URL printed by the Host. `--trusted-host` remains a Host/Origin fence; it does not replace HTTPS or deployment access controls.

1. Terminate HTTPS at a reverse proxy or access gateway and protect the public entry for its intended users. Proxy the same-origin `/` and `/api` traffic, including streams, to `http://127.0.0.1:3080` while preserving the external `Host` authority.
2. Start the loopback service with the external authority. Use a bare `host[:port]`, not a URL:

   ```sh
   dsh web --trusted-host memory.example.com --no-open
   ```

   For a non-default public port, use the exact authority, for example `memory.example.com:8443`. DSH deliberately rejects `--host 0.0.0.0`; keep the service on loopback and let the proxy or an SSH tunnel reach it.
3. For a browser that does not already have a valid cookie for this public authority, use the launch-token URL printed as `dsh web: ...`. With a reverse proxy, replace only the printed loopback origin with the public HTTPS origin and preserve the `/` path and `?token=...` query. For example, transform `http://127.0.0.1:3080/?token=...` into `https://memory.example.com/?token=...`. Treat that URL as a credential and do not put it in logs, tickets, or chat. DSH exchanges it for an HttpOnly, SameSite cookie and redirects to a clean `/`; a still-valid authority-bound cookie can survive a Host restart.
4. Open the clean external URL and verify that **Status** and **Settings → Memory System** both load, an intentional small settings save succeeds, and a page reload remains authenticated.

An HTTP 403 points to the Host/Origin fence: check `--trusted-host`, the public port, and whether the proxy preserves `Host`. An HTTP 401 means the browser session is missing or invalid: return to the current process's launch-token URL. DSH 0.1.2-alpha.5 uses the same browser-session model and remains covered as the immediate source-compatibility predecessor. Both releases ignore Mnemon's retained `remoteAccess` compatibility setting.

### Disable the complete Starter

The legacy `mnemon` Entry remains the lifecycle switch for the complete Starter. To disable Mnemon without leaving its Source or Strategy Entries waiting on the missing Host service, add this profile patch and restart DSH:

```yaml
- id: mnemon
  disabled: true
```

This disables the Core/Host, all three bundled Sources, the default Strategy, and all three optional Strategy enhancements together. It does not remove installed packages or delete memory data. Remove the override, or change it to `false`, and restart DSH to enable the Starter again.

### DSH 0.1.1-rc.2 rollback

The previous rc.2 line uses method-specific authority tiers instead of the browser-session model. Ordinary reads and activation may use `trusted-host`, while settings, backups, Provider connections, and broad mutations remain loopback-only unless local Mnemon configuration promotes all management channels. Use rc.2 remotely only behind reliable user authentication.

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
3. Start rc.2 with the same `--trusted-host` command, then restart it after any `remoteAccess` change because Mnemon captures that policy at startup. Verify **Status**, settings loading, and one deliberate small save through the authenticated proxy.

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

- On DSH 0.1.2-rc.1 and its alpha.5 predecessor, every RPC and stream requires the same authenticated browser session; the retained `remoteAccess` value has no transport effect.
- On DSH 0.1.1-rc.2, read and activation use `trusted-host`; write, settings, and backup default to `loopback` and are promoted together only by local `remoteAccess: trusted-host` configuration.
- The ordinary Provider catalog is redacted. Saved credential values travel only through the version-appropriate protected management channel.
- The WebUI follows the Host's writable settings snapshot instead of inferring capability from transport locality; an unavailable settings channel renders an explicit diagnostic rather than an empty page.
- The WebUI neither reads SQLite, starts processes, calls remote providers, nor supplies arbitrary update commands; provider network access remains inside the Host.
- Workers use persona, tool allowlists, schema-validated one-run result tools, and `maxDepth: 1`.
- Queries, candidates, Document bodies, and historical memory are treated as untrusted data.

These boundaries are not a secret scanner. There is no deterministic credential detection; never submit keys, tokens, private keys, or raw sensitive logs.

### Security reporting

Report vulnerabilities privately through [SECURITY.md](../../SECURITY.md), not a public issue. Data loss, path traversal, lock/revision bypasses, subagent-isolation breaks, and injection through rendered memory are in scope.

## Troubleshooting

`mnemon.cliPath` accepts an explicit path or a command name resolved against the Host's PATH. If the binary is installed or restored into an existing search directory while DSH is running, click Recheck to refresh availability without restarting. Changes to the Host process's environment still require a restart. Status and version checks resolve the same configured command.

| Symptom | Check and resolution |
|---|---|
| Mnemon unavailable | macOS/Linux: run `command -v mnemon`, `mnemon --version`. Windows PowerShell: run `Get-Command mnemon`, `Test-Path "$env:LOCALAPPDATA\Programs\mnemon\mnemon.exe"`. Set `MNEMON_CLI_PATH` or `mnemon.cliPath`, then restart |
| Headless Agent has no Mnemon tools | Plugins are profile-local. Run `dsh plugin --profile headless add dsh-mnemon`; a Web-profile installation does not carry over |
| Memory System entry missing | Check `tabEnabled=true`; `displayMode=sidebar` uses the sidebar, while `displayMode=builtin` uses the open conversation's tabs. For a local link run `pnpm run build`, then restart the profile |
| A retained `buildin` preference opens a conversation tab after upgrading | v0.4.2 restores that preference and saves it as `builtin`; select Sidebar to keep the standalone entry. Memory scope and stored data are unchanged |
| Status healthy but recall empty | Check active spaces, storage scope, inspected root, effective session root, and query focus |
| Header reports misalignment | The workbench is inspecting another workspace; align or keep deliberate read-only inspection; Agent-backed actions are rejected |
| Saved settings appear unchanged | Inspect the save error; success applies live and reloads automatically without refresh |
| Custom directory rejected | Use an absolute path, `~`, or `~/...` |
| `memoryBodyId is required...` | Active count is not exactly one; select a target explicitly |
| `memory body is not active for reading` | Activate it in Overview; inactive writes are allowed, reads are not |
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
| An rc.2 remote page can activate a Memory Space but cannot perform another write | Secure default; only behind reliable authentication, set `remoteAccess: trusted-host` locally, configure DSH `trustedHosts`, and restart the Host |
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
