# Getting Started

[简体中文](../zh-CN/getting-started.md) | **English** | [Documentation hub](./README.md)

This guide goes from a blank environment to the first verified recall. It uses Sidebar, global storage, and the compatible `default-three-tier` topology. You do not need to configure TurnView, Strategy, or generation concepts for normal use.

If installation is complete, jump to [First verification](#6-complete-first-verification). When upgrading from v0.3.x, first read the [v0.4.0 Sidebar-only compatibility notes](./releases/v0.4.0.md#upgrade-and-compatibility). If you are upgrading from v0.2.x, also read the [v0.3.0 upgrade notes](./releases/v0.3.0.md#upgrade-and-data-compatibility).

## 1. Prerequisites

You need:

- Node.js `^22.19.0 || >=24.0.0` for the DSH 0.1.1-rc.2 baseline;
- a DSH Web or Headless profile that starts successfully;
- a locally executable `mnemon` CLI;
- a DSH model route capable of creating independent task Agents.

Regular semantic work prefers a provider named `spawn` with `toolFilter`, `persona`, and `depthLimit`. Mnemon supplies a schema-validated, one-run result tool instead of depending on the Provider's `outputSchema` path. Optional score-based background review additionally requires a provider named `fork` with `inheritsParentContext=true`. Missing `fork` does not block deterministic pages or regular manual actions.

This workflow uses dsh-mnemon v0.4.0, DSH 0.1.1-rc.2, and Mnemon 0.2.3 as the recommended registry baseline. Some compatible UI screenshots were captured on dsh-mnemon v0.2.0. DSH rc.2 uses `Promise.withResolvers` and the Node Zstd API, so Node 20 cannot boot its complete profile. Source compatibility is also verified against DSH 0.1.2-alpha.1, which is not published to npm. Back up and repeat this verification against an isolated root before upgrading.

Install and verify the tested DSH release with:

```sh
npm install -g @deepseek-ai/dsh@0.1.1-rc.2
dsh --version
npm view @deepseek-ai/dsh dist-tags
```

## 2. Install Mnemon

Homebrew Cask is recommended on macOS:

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

On Windows, the official release provides ZIP archives for AMD64 and ARM64. The following PowerShell installs v0.2.3 under the auto-discovered per-user Programs directory and verifies it against the published checksum:

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

On Windows, dsh-mnemon discovers native `mnemon.exe` from `PATH`, an exported `GOBIN` or `GOPATH`, the default `%USERPROFILE%\go\bin`, `%LOCALAPPDATA%\Programs\mnemon`, and Program Files. `.cmd` and `.bat` wrappers are not accepted because CLI calls deliberately run without a shell.

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

[![Sidebar-only Memory System settings: memory scope and layers](../assets/screenshots/settings-sidebar-only.png)](../assets/screenshots/settings-sidebar-only.png)

### Workbench entry

Open the dedicated workbench from Memory System in the DSH sidebar. Sidebar is the only presentation; no display-mode selection is needed.

### Storage location

| Scope | Root | Best suited for |
|---|---|---|
| **Global** (default) | `MNEMON_DATA_DIR` or `~/.mnemon` | Sharing one memory set across workspaces |
| **Workspace** | `<workspace>/.mnemon` | Project isolation with cross-workspace inspection in the workbench |
| **Custom** | `dataDir` | A dedicated disk, mounted volume, or explicit directory |

Save initializes a candidate runtime graph before atomically switching the Host. The page clears stale state and reloads automatically—no browser refresh is needed. Changing scope never migrates, merges, or deletes old data.

### Layer topology

A first installation should show Runtime, Documents, and Memory Spaces enabled. Each Layer has one master switch. Enabling only permits on-demand use; it does not force recall on every turn. Disabling stops that Layer's context, tools, background work, and data-plane Web/RPC together without deleting data. Its Sidebar tab is marked Off, and re-enabling restores the existing data. Keep all three defaults on for the first workflow.

In Workspace mode, conversation Agents, tools, and lifecycle hooks use the current conversation's effective root. Independent task Agents launched by the workbench use the inspected workspace explicitly, including when no main session is selected. The header reports a mismatch and offers one-click alignment.

## 5. Open the Sidebar workbench

Click **Memory System** in the sidebar, then start on **Status**:

[![Status with CLI, versions, Runtime, Documents, Memory Spaces, and storage root](../assets/screenshots/status-overview.png)](../assets/screenshots/status-overview.png)

Confirm that:

- the top right says Connected;
- Mnemon and dsh-mnemon show installed versions;
- the storage root matches your chosen scope;
- Memory System reports `default-three-tier`, with the three default Layers matching Settings;
- Runtime, Documents, and Memory Spaces report no errors.

If Mnemon is unavailable, run `command -v mnemon` and `mnemon --version` on macOS/Linux, or `Get-Command mnemon` and `Test-Path "$env:LOCALAPPDATA\Programs\mnemon\mnemon.exe"` on Windows PowerShell. See [Troubleshooting](./operations.md#troubleshooting) for other symptoms.

## 6. Complete first verification

### Create a Memory Space

1. Open **Memory Spaces → Overview**.
2. Select **Create Memory Space**.
3. The default **Choose manually** path preserves the existing flow. Keep **Mnemon Native** for the official local-first default, or select and configure a third-party engine from the same panel.
4. With a connected conversation, **Smart selection** adds data-boundary, required-capability, soft-preference, strategy-prompt, and multi-provider candidate controls.
5. Use a narrow name such as “Project Decisions.”
6. Describe what belongs there and which tasks should recall it, then enable read activation.

In an empty storage root, the first Memory Space uses Mnemon's native `default` Store ID while keeping the name and description you supplied. Its activation toggle affects DSH only.

Smart selection first has the Host enforce the provider allowlist, data boundary, and required capabilities. One remaining candidate is selected deterministically; only an ambiguous eligible set reaches an independent task Agent, which considers the soft preference and strategy prompt. Provider credentials never enter model context, and the resulting card retains the source, reason, and confidence.

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
- Use the [storage model](./storage-model.md) to choose Runtime, Documents, or Memory Spaces.
- Use the [configuration reference](./configuration.md) for Workspace scope, read-only behavior, and lifecycle switches.
- Use the [operations guide](./operations.md) to export your first ZIP backup and establish a pre-upgrade checklist.
