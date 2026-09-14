# Getting Started

[简体中文](../../zh-CN/guides/getting-started.md) | **English** | [Documentation hub](../README.md)

This guide goes from a blank environment to the first verified recall. It uses Sidebar, global storage, and the default `default-three-tier` composition. You do not need to configure View, Strategy, or generation concepts for normal use.

If installation is complete, jump to [First verification](#6-complete-first-verification). Existing installations should follow [Compatibility and upgrades](../reference/compatibility.md); version-specific migration history remains in the linked release notes.

## 1. Prerequisites

You need:

- Node.js `^22.19.0 || >=24.0.0` for the DSH 0.1.5-rc.1 baseline;
- a DSH Web or Headless profile that starts successfully;
- a locally executable `mnemon` CLI;
- a DSH model route capable of creating independent task Agents.

Regular semantic work prefers a provider named `spawn` with `toolFilter`, `persona`, and `depthLimit`. Mnemon keeps one stable `mnemon_subagent_result` tool registered and issues a revocable `requestId` for each child. The child returns `{ requestId, result }`; the Host validates `result` against that operation's schema and rejects stale or foreign submissions, without depending on the Provider's `outputSchema` path. Optional score-based background review additionally requires a provider named `fork` with `inheritsParentContext=true`. Missing `fork` does not block deterministic pages or regular manual actions.

The composable v0.5.6 distribution pins a verified combination of sixteen official plugins. Read the [patch notes](../releases/v0.5.6.md) and [compatibility matrix](../reference/compatibility.md). The DSH baseline is 0.1.5-rc.1; its complete profile requires Node `^22.19.0 || >=24.0.0`. Mnemon's Node 20 public-entry checks do not establish full Host compatibility. Current UI examples show v0.5.4 in Light appearance after a backup import into isolated storage; old release records retain their original versions.

Install and verify the tested DSH release with:

```sh
npm install -g @deepseek-ai/dsh@0.1.5-rc.1
dsh --version
npm view @deepseek-ai/dsh dist-tags
```

## 2. Install Mnemon

npm is recommended on macOS, Linux, and Windows (Node.js 22+). Run these commands on the machine running DSH:

```sh
npm install --global @mnemon-dev/mnemon@latest
mnemon --version
```

For later npm updates, run `mnemon update`, or use **Status → Check versions** when the page recognizes the owning npm installation. If migrating from Homebrew, Go, or a downloaded binary, put npm's global bin directory before the old command on PATH and update any `MNEMON_CLI_PATH` / `mnemon.cliPath` override. Restart DSH after changing its environment, then recheck the executable path on Status.

Homebrew Cask remains an alternative on macOS:

```sh
brew install --cask mnemon-dev/tap/mnemon
```

Go works on macOS and Linux:

```sh
go install github.com/mnemon-dev/mnemon@latest
```

Verify the binary:

```sh
mnemon --version
```

For a manual installation on Windows, the official release provides ZIP archives for AMD64 and ARM64. The following PowerShell installs v0.2.3 under the auto-discovered per-user Programs directory and verifies it against the published checksum:

```powershell
$version = '0.2.3'
$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') { 'arm64' } else { 'amd64' }
$archiveName = "mnemon_${version}_windows_${arch}.zip"
$releaseBase = "https://github.com/mnemon-dev/mnemon/releases/download/v${version}"
$archive = Join-Path $env:TEMP $archiveName
$checksumFile = Join-Path $env:TEMP "mnemon_${version}_checksums.txt"
Invoke-WebRequest "${releaseBase}/${archiveName}" -OutFile $archive
Invoke-WebRequest "${releaseBase}/checksums.txt" -OutFile $checksumFile
$line = Get-Content $checksumFile | Where-Object { $_.EndsWith("  $archiveName") } | Select-Object -First 1
if (-not $line) { throw "Checksum entry not found for $archiveName" }
$expected = (($line -split '\s+')[0]).ToLowerInvariant()
$actual = (Get-FileHash -Path $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw "Checksum mismatch for $archiveName" }
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\mnemon'
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
Expand-Archive -Path $archive -DestinationPath $installDir -Force
$mnemon = Join-Path $installDir 'mnemon.exe'
& $mnemon --version
```

Go remains an alternative when a Go toolchain is already available:

```powershell
go install github.com/mnemon-dev/mnemon@latest
$mnemonBin = go env GOBIN
if (-not $mnemonBin) {
  $mnemonBin = Join-Path (((go env GOPATH) -split ';')[0]) 'bin'
}
$mnemon = Join-Path $mnemonBin 'mnemon.exe'
& $mnemon --version
```

On Windows, dsh-mnemon discovers native `mnemon.exe` from `PATH`, an exported `GOBIN` or `GOPATH`, the default `%USERPROFILE%\go\bin`, `%LOCALAPPDATA%\Programs\mnemon`, and Program Files. The official npm `mnemon.cmd` launcher is also supported: dsh-mnemon validates its package and invokes its JavaScript entry with Node, without a shell. Other `.cmd` and `.bat` wrappers remain unsupported.

When DSH runs inside an Electron desktop main process, verified npm launchers run with `ELECTRON_RUN_AS_NODE=1` in the child process. This covers memory commands, version checks, and npm updates, while preserving saved embedding settings. The desktop application's own environment is unchanged. If the shell disables Electron's `runAsNode` fuse, point `mnemon.cliPath` at the platform's native Mnemon binary instead; see [Troubleshooting](./operations.md#troubleshooting).

If DSH still cannot find the binary, set `MNEMON_CLI_PATH` or add an absolute path to the user settings file instead of replacing the plugin's profile patch:

```yaml
mnemon:
  cliPath: 'C:\Users\alice\AppData\Local\Programs\mnemon\mnemon.exe'
```

`mnemon status` opens the effective Store and may initialize data or run upstream migrations, so it is not a side-effect-free installation probe.

## 3. Install dsh-mnemon

Install into the Web profile for the complete workbench:

```sh
dsh plugin --profile web add dsh-mnemon
```

Use an absolute path for a development checkout:

```sh
dsh plugin --profile web add "link:/absolute/path/to/dsh-mnemon"
```

Then start or restart the profile:

```sh
dsh --profile web
```

If the Web profile is reached through a cloud hostname, do not publish port 3080 directly. DSH 0.1.5-rc.1 authenticates every Mnemon RPC and stream through a browser session established from the one-time URL printed at Host startup. Configure the HTTPS reverse proxy or access gateway and trusted authority together, then open that launch URL, by following [Cloud-hosted WebUI](./operations.md#cloud-hosted-webui). The same section preserves the different `remoteAccess` procedure required when rolling back to DSH 0.1.1-rc.2.

Upgrade and uninstall:

```sh
dsh plugin --profile web update dsh-mnemon
dsh plugin --profile web remove dsh-mnemon
```

Uninstall removes the plugin registration, not memory data in global, workspace, or custom roots.

Profiles have independent plugin rosters. Install the package separately into Headless when one-shot tasks also need memory:

```sh
dsh plugin --profile headless add dsh-mnemon
dsh --profile headless "Check durable project context before answering this task."
```

For a development checkout, replace the package name with `"link:/absolute/path/to/dsh-mnemon"`. Headless mounts the same Runtime context, Documents, Memory Space tools, lifecycle guidance, and supervised write path as a Web Agent. It does not mount the workbench, conversation buttons, RPC channels, or an interactive slash-command surface.

With `storageScope=workspace`, Headless resolves `<invocation cwd>/.mnemon`; no Web workspace registry is required. The one-shot runner exits when its Agent becomes idle, so shutdown cancels any delayed score-based background review that has not started. Explicit or model-guided writes that finish during the task are durable.

## 4. Configure storage and the interface

Open **Settings → Memory System**:

The [UI guide](./ui-guide.md) shows the current settings and optional enhancements.

### Workbench entry

By default, open the dedicated workbench from Memory System in the DSH sidebar. Choose Builtin in Settings, or set `displayMode: builtin`, to show the same Source pages as a conversation tab instead. Save switches the entry live without changing stored data.

### Storage location

| Scope | Root | Best suited for |
|---|---|---|
| **Global** (default) | `MNEMON_DATA_DIR` or `~/.mnemon` | Sharing one memory set across workspaces |
| **Workspace** | `<workspace>/.mnemon` | Project isolation with cross-workspace inspection in the workbench |
| **Custom** | `dataDir` | A dedicated disk, mounted volume, or explicit directory |
| **Centralized workspaces** | `<central-root>/workspaces/<workspace-path-hash>/` | Central management with project isolation |

For centralized project isolation, select `storageScope: workspaces` and optionally set `dataDir`; data is stored in `<central-root>/workspaces/<workspace-path-hash>/`. The directory setting appears alongside the scope selector. Existing roots are retained when switching modes.

Save initializes a candidate runtime graph before atomically switching the Host. The page clears stale state and reloads automatically—no browser refresh is needed. Changing scope never migrates, merges, or deletes old data.

### Default memory layers

A first installation should show Runtime, Documents, and Memory Spaces enabled. Each Source has one master switch. Enabling only permits on-demand use; it does not force recall on every turn. Disabling stops that Source's context, tools, background work, and data-plane Web/RPC together without deleting data. Its Sidebar tab is marked Off, and re-enabling restores the existing data. Keep all three defaults on for the first workflow.

In Workspace mode, conversation Agents, tools, and lifecycle hooks use the current conversation's effective root. Independent task Agents launched by Sidebar use the inspected workspace explicitly, including when no main session is selected. Its header reports a mismatch and offers one-click alignment. Builtin uses its owning conversation's scope for reads, writes and tasks, with no storage-mode badge, workspace picker or alignment control.

## 5. Open the Sidebar workbench

Click **Memory System** in the sidebar, then start on **Status**:

![Current status with Native readiness and memory counts](../../assets/webui-v0.5.4/en/status.jpg)

Confirm that:

- the top right says Connected;
- Mnemon and dsh-mnemon show installed versions;
- the storage root matches your chosen scope;
- Runtime, Documents and Memory Spaces match the enabled layers in Settings;
- Runtime, Documents, and Memory Spaces report no errors.

Documents also needs a DSH workspace identity in Global or Custom storage. Select a workspace for the current conversation, or select the inspected workspace in Workspace storage. “Waiting for workspace” is a missing project context, not a missing CLI.

If Mnemon is unavailable, run `command -v mnemon` and `mnemon --version` on macOS/Linux, or `Get-Command mnemon` and `Test-Path "$env:LOCALAPPDATA\Programs\mnemon\mnemon.exe"` on Windows PowerShell. See [Troubleshooting](./operations.md#troubleshooting) for other symptoms.

## 6. Complete first verification

### Create a Memory Space

1. Open **Memory Spaces → Overview**.
2. Select **Create Memory Space**.
3. Choose an enabled Provider explicitly. Keep **Mnemon Native** for the official local-first default; enable third-party services in Settings first.
4. Use a narrow name such as “Project Decisions.”
5. Describe what belongs there and which tasks should recall it, then enable read activation.

In an empty storage root, the first Memory Space uses Mnemon's native `default` Store ID while keeping the name and description you supplied. Its activation toggle affects DSH only.

**Smart selection belongs to Memory Spaces → Distillation strategy, not the creation dialog.** The Host first enforces the provider allowlist, data boundary, and required capabilities. One remaining candidate is selected deterministically; only an ambiguous eligible set reaches an independent task Agent, which considers the soft preference and strategy prompt. Provider credentials never enter model context, and the resulting card retains the source, reason, and confidence.

See [Long-term memory providers](./memory-providers.md) before connecting an external service or CLI.

### Remember one test item

Open **Remember** and enter something stable, self-contained, future-useful, and secret-free. Leave advanced options collapsed so the independent task Agent can select a target, deduplicate, and distill.

Writing starts only after confirmation. Canceling the dialog changes no state.

### Verify recall

1. Open **Memory Spaces → Recall**.
2. Ask a concrete question that should match the item.
3. Use **Direct recall** first to inspect raw evidence.
4. Confirm the result retains its Memory Space, category, importance, score, and ID.

You can also use conversation commands:

```text
/mnemon status
/mnemon recall <focused query>
```

## 7. Verify memory inside a conversation

Ask a question that genuinely depends on history and allow the Agent to decide whether recall helps. After completion:

- Turn memory appears below the reply if the turn used memory tools.
- Expanding shows exact tools and links to their pages.
- Save to memory opens an editable confirmation; canceling performs no write.

Ordinary conversation should not force recall. Current requests, repository files, and live tool results outrank historical content.

## 8. Next steps

- Use the [Sidebar and conversation UI guide](./ui-guide.md) to learn every page.
- Use the [storage model](../reference/storage-model.md) to choose Runtime, Documents, or Memory Spaces.
- Use the [configuration reference](../reference/configuration.md) for Workspace scope, read-only behavior, and lifecycle switches.
- Use the [operations guide](./operations.md) to export your first ZIP backup and establish a pre-upgrade checklist.

## Optional workspace services

See [Composable workspace services](workspace-services.md) for independent Sources, policies, activation, data ownership and retained acceptance evidence.
