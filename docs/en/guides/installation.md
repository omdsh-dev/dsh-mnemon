# Install and start

[简体中文](../../zh-CN/guides/installation.md) | **English** | [Documentation](../README.md)

This page is for your first time: it starts from a computer that has never run DeepSeek Harness (DSH), installs dsh-mnemon, and ends with a conversation that uses your first memory. It takes about ten minutes. Already using DSH? Skip to [step 3](#3-install-and-enable-dsh-mnemon).

![Add dsh-mnemon on the Plugins page: type the package name, install, Enable now, and the Memory System appears in the sidebar](../../assets/install-v0.5.19/en/install.gif)

The screenshots and recordings come from real DSH 0.2.0-rc.1 and dsh-mnemon 0.5.19; the [installation gallery](../../assets/install-v0.5.19/README.md) describes how they were captured.

## Choose how you use DSH

| Way | Suits | Where to install dsh-mnemon |
|---|---|---|
| **Web (recommended)** | Using DSH in a browser; the easiest start | **Plugins → Add plugin** in the web sidebar |
| **Desktop app** | You already have the DeepSeek Harness desktop app | **Plugins → Add plugin** in the app's sidebar; see [Desktop app](#6-desktop-app) |
| **Command line and Headless** | Servers, scripts and one-shot jobs | `dsh plugin --profile <name> add dsh-mnemon`; see [Command line and Headless](#7-command-line-and-headless) |

All three install the same dsh-mnemon. By default your memory lives in `~/.mnemon` on the computer, and the web page and the desktop app share it.

## 1. Get Node.js, pnpm and the Mnemon CLI

| Tool | What it is for | Needed |
|---|---|---|
| [Node.js](https://nodejs.org/) 22.19 or later (22 or 24 LTS recommended) | Runs DSH | Yes |
| pnpm | DSH calls it to install plugins; without it the Plugins page says pnpm was not found | Yes |
| Mnemon CLI | Mnemon Native, the default local storage for Memory Spaces, needs it; runtime memory and Project Documents do not | Recommended; you can add it later |

With Node.js installed, run these in a terminal (PowerShell on Windows):

```sh
node --version
npm install --global pnpm
npm install --global @mnemon-dev/mnemon@latest
mnemon --version
```

Both `--version` commands should print a version. Homebrew, Go and a manual Windows installation are covered in [Other ways to install the Mnemon CLI](#other-ways-to-install-the-mnemon-cli).

## 2. Start DSH

```sh
npx @deepseek-ai/dsh web
```

DSH starts at `http://127.0.0.1:3080` and opens a one-time link in your browser; the terminal prints the same link. Keep the terminal open while you use DSH, and press `Ctrl+C` to stop it.

- This runs the DSH release tagged `latest` on npm, 0.2.1-rc.2 at the time of writing, which is also the one tagged `next`; `npx @deepseek-ai/dsh@0.2.0-rc.2 web` runs DSH 0.2.0-rc.2. dsh-mnemon supports both; see [Compatibility and upgrades](../reference/compatibility.md).
- If you use DSH often, install it globally with `npm install --global @deepseek-ai/dsh` and then run `dsh web`; the [command line](#7-command-line-and-headless) needs the global `dsh` too.

The first time you open it:

1. DSH 0.2 shows a **Preview Notice** first. Click **Continue**.
2. In **Add an API key to get started**, paste an API key you created on the [DeepSeek Platform](https://platform.deepseek.com/) and click **Save and continue**. You can also click **Configure later** and add it in **Settings** afterwards; installing plugins needs no key, conversations do.

<p align="center"><img src="../../assets/install-v0.5.19/en/install-02-api-key.jpg" alt="DSH's first-run dialog Add an API key to get started, with Configure later and Save and continue" width="760" /></p>

## 3. Install and enable dsh-mnemon

1. Click **Plugins** in the sidebar, then **Add plugin** in the top right corner.
2. Type `dsh-mnemon` and click **Install**. DSH chooses the **Registry** on the right of the dialog for you: until you pick one, it uses whichever answers faster, usually the **Official npm registry**, or the **Mainland China mirror** in mainland China. You rarely need to change it.
3. After a few seconds the dialog says **Installed** with the version. Click **Enable now**; DSH does not need a restart.
4. **Memory System** appears in the sidebar. That is it.

| Type the package name and install | Installed; enable it now |
|---|---|
| ![The Add plugin dialog with dsh-mnemon typed and the Official npm registry chosen](../../assets/install-v0.5.19/en/install-04-add.jpg) | ![The Installed dialog shows dsh-mnemon version 0.5.19 and Enable now](../../assets/install-v0.5.19/en/install-05-installed.jpg) |

The **Installed** card shows the description from the package, which is in English; the plugin list shows the name and description in the interface language.

If you prefer the command line, you can install with the command below and then start DSH as in step 2; if DSH is already running, restart it after installing. [Command line and Headless](#7-command-line-and-headless) has the rest of the commands.

```sh
npx @deepseek-ai/dsh plugin --profile web add dsh-mnemon
```

### Settings cannot save after manual installation

The package's `cordis.patch.yml` is a **bundle layer**, loaded automatically when `dsh-mnemon` is enabled. It is not a template to copy into your profile. Copying its `insert` block creates a second `mnemon-bundle` and `mnemon` with the same IDs. Settings can then fail with `Configuration for "mnemon" is overridden by a home patch or command-line overlay`.

For a profile with that duplicate insertion:

1. Stop DSH and back up the affected profile's `cordis.patch.yml` and `package.json`.
2. Check that `dsh.profile.bundles` in that profile's `package.json` includes `dsh-mnemon`. If it does not, install/enable the bundle using Plugins or the CLI above before applying this recovery.
3. Preserve any custom values from the copied Mnemon entries in one top-level override per component ID, such as `- id: mnemon` or `- id: mnemon-source-skills`. Combine them with existing overrides deliberately: a `config` row replaces the complete config object, rather than merging one field at a time.
4. Remove the copied **Mnemon insertion** from the profile patch. Keep unrelated entries, comments and overrides; if the `insert` block contains other plugins, keep those members. Remove an empty `insert` block.
5. If a profile-level bundle enable override is needed, it is just the following top-level row; its children come from the package automatically:

   ```yaml
   - id: mnemon-bundle
     name: dsh-mnemon/bundle
     disabled: false
   ```

6. Restart DSH and save a setting, such as Skills → Self-evolution. It should survive another restart. Runtime memory, Documents, Memory Spaces and skill files are not moved or deleted by this patch repair.

Removing only the nested `config` block does not remove duplicate IDs. The package's own nested defaults work with one bundle insertion and can stay. A genuine home-patch or command-line override is a separate case: change that owning layer instead of applying this duplicate-insertion recovery.

## 4. Check the installation

Click **Memory System**. It opens on **Status**:

- the header says **Connected · Layered strategy**;
- the **Memory engine** card shows `dsh-mnemon 0.5.19` or later;
- with the Mnemon CLI installed, Mnemon Native under **Memory Providers** reads "Service ready" with the CLI version. Without it, it reads "Mnemon CLI not found", and runtime memory and Project Documents work as usual.

![The Memory System's Status page: dsh-mnemon 0.5.19, the three memory layers, and Mnemon Native showing Mnemon 0.2.7](../../assets/install-v0.5.19/en/install-07-status.jpg)

## 5. Save your first memory

1. Click **New Session** and type something you want remembered, for example: `Remember: I own checkout performance on the Lumen project, and I prefer short answers.`
2. Under the reply, **Turn memory · wrote** appears; expand it to see the runtime memory this turn wrote.
3. Click an entry: the Memory System opens **Runtime memory** with that entry highlighted. Every later turn carries it.

![Typing a sentence to remember; under the reply Turn memory lists what it wrote, and an entry opens in Runtime memory](../../assets/install-v0.5.19/en/first-memory.gif)

| What this turn wrote | Where it lives |
|---|---|
| ![The reply confirms, and the turn memory bar lists two runtime memory updates](../../assets/install-v0.5.19/en/first-01-reply.jpg) | ![Runtime memory highlights the entry that was written](../../assets/install-v0.5.19/en/first-02-runtime.jpg) |

The model decides the wording and where to write it, so your text may differ. Continue with [Getting started](./getting-started.md): Project Documents, Memory Spaces, and saving a reply with **Save to memory**.

## 6. Desktop app

The **Plugins** page of the DeepSeek Harness desktop app works like the web page: **Plugins → Add plugin → type `dsh-mnemon` → Install → Enable now**.

- The desktop app uses its own `desktop` profile. From DSH 0.2 the command line no longer manages that profile, so install and manage plugins on the app's Plugins page.
- Desktop windows load from the app's own `dsh-app://app/` address. dsh-mnemon 0.5.18 and earlier treated them as remote pages, which made the Memory System and the plugin settings read only ([#310](https://github.com/omdsh-dev/dsh-mnemon/issues/310)). 0.5.19 fixes this; update dsh-mnemon, with no configuration change.
- DSH's Plugins page cannot update an installed plugin. Update dsh-mnemon from **Memory System → Status → Check versions → Update**; [Version checks and updates](./operations.md#version-checks-and-updates) explains how it installs. dsh-mnemon 0.5.21 and earlier cannot do this in the desktop app, and on DSH 0.2.1 neither can 0.5.30 and earlier, whose update stops with `already-installed`: update from them once by uninstalling dsh-mnemon on the Plugins page and adding it again with **Add plugin**, typing the newest version Check versions shows, for example `dsh-mnemon@0.5.35`. Your memory data and settings stay.
- After updating dsh-mnemon in the desktop app, quit the app completely and open it again (`Cmd+Q` on macOS) so the new version loads. If an error appears after an update, see [Common problems](#common-problems).

## 7. Command line and Headless

This section is for servers, scripts, one-shot jobs and development checkouts. You need:

- a DSH release that [Compatibility and upgrades](../reference/compatibility.md) lists, Node.js `^22.19.0 || >=24.0.0`, and pnpm;
- a DSH model route that can create independent task Agents; [Provider requirements](../reference/configuration.md#provider-requirements) says how they are started;
- for Mnemon Native only, the Mnemon CLI, as in [step 1](#1-get-nodejs-pnpm-and-the-mnemon-cli) or [other ways to install it](#other-ways-to-install-the-mnemon-cli). The other Providers connect to their own services.

Install DSH globally, then check the release you run and the ones npm offers:

```sh
npm install --global @deepseek-ai/dsh
dsh --version
npm view @deepseek-ai/dsh dist-tags
```

Install dsh-mnemon into the Web profile, which has the complete workbench, then start DSH, or restart it if it is already running:

```sh
dsh plugin --profile web add dsh-mnemon
dsh web
```

For a development checkout, add it by absolute path instead:

```sh
dsh plugin --profile web add "link:/absolute/path/to/dsh-mnemon"
```

### Headless

Profiles keep separate plugin lists. To give one-shot jobs memory too, install dsh-mnemon into the Headless profile as well, or the `link:` path of a development checkout:

```sh
dsh plugin --profile headless add dsh-mnemon
dsh --profile headless "Check persistent project context before answering."
```

Headless mounts the same runtime context, Project Documents, Memory Space tools, lifecycle guidance and supervised write path as a Web Agent. It does not mount the workbench, the conversation buttons, the RPC channels or an interactive slash-command surface. [Profile surfaces](../reference/interfaces.md#profile-surfaces) lists the differences, such as the idle review a one-shot run cancels when it exits, and [the `workspace` scope](../reference/configuration.md#workspace) says where Headless keeps per-workspace memory.

### Update and uninstall

```sh
dsh plugin --profile web update dsh-mnemon
dsh plugin --profile web remove dsh-mnemon
```

- Restart DSH after an update so the new version loads.
- For 24 hours after a release, pnpm 11 keeps `update` on the installed version; add the new version by name instead, as [Common problems](#common-problems) describes.
- In the WebUI and the desktop app, **Memory System → Status → Check versions → Update** installs the exact new version, as `dsh plugin add dsh-mnemon@<version>` would, so the 24-hour rule does not hold it back. On DSH 0.2.1, dsh-mnemon 0.5.30 and earlier stop there with `already-installed` instead. Update from them once: for the WebUI, quit DSH, run `dsh plugin --profile web add dsh-mnemon@<version>` and start DSH again; in the desktop app, uninstall dsh-mnemon on the Plugins page and add it again with **Add plugin** as `dsh-mnemon@<version>`. See [Version checks and updates](./operations.md#version-checks-and-updates).
- Before you move to another DSH release, follow the [upgrade order](../reference/compatibility.md#upgrade-order).
- Uninstalling removes the plugin registration, never your memory data in global, workspace or custom roots.

### Cloud access

If the Web profile is reached through a cloud hostname, do not publish port 3080 directly. DSH authenticates every Mnemon RPC and stream through a browser session established from the one-time URL printed at Host startup. Configure the HTTPS reverse proxy or access gateway and trusted authority together, then open that launch URL, by following [Cloud-hosted WebUI](./operations.md#cloud-hosted-webui).

## Other ways to install the Mnemon CLI

Only Mnemon Native uses the Mnemon CLI. Install it on the machine that runs DSH. The npm command from step 1 is recommended on macOS, Linux and Windows (Node.js 22+); update it later with `mnemon update`, or use **Status → Check versions** when the page recognizes the owning npm installation. If migrating from Homebrew, Go, or a downloaded binary, put npm's global bin directory before the old command on PATH and update any `MNEMON_CLI_PATH` / `mnemon.cliPath` override. Restart DSH after changing its environment, then recheck the executable path on Status.

Homebrew Cask remains an alternative on macOS:

```sh
brew install --cask mnemon-dev/tap/mnemon
```

Go works on macOS and Linux:

```sh
go install github.com/mnemon-dev/mnemon@latest
```

For a manual installation on Windows, the official release provides ZIP archives for AMD64 and ARM64. The following PowerShell installs v0.2.9 under the auto-discovered per-user Programs directory and verifies it against the published checksum:

```powershell
$version = '0.2.9'
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

Go remains an alternative on Windows when a Go toolchain is already available:

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

If DSH still cannot find the binary, set `MNEMON_CLI_PATH`, or set `mnemon.cliPath` as a user setting rather than replacing the plugin's profile patch (see [Configuration](../reference/configuration.md)):

```yaml
mnemon:
  cliPath: 'C:\Users\alice\AppData\Local\Programs\mnemon\mnemon.exe'
```

`mnemon status` opens the effective Store and may initialize data or run upstream migrations, so it is not a side-effect-free installation probe.

## Common problems

### Installing says "dsh-mnemon@… is incompatible with DSH …"

![The plugin could not be installed: dsh-mnemon@0.5.18 is incompatible with DSH 0.2.0-rc.1, with Edit and Retry](../../assets/install-v0.5.19/en/trouble-incompatible.jpg)

Before DSH installs a plugin, and each time it starts, it checks which DSH versions the plugin declares support for, and refuses a release that leaves its own version out. The screenshot shows DSH 0.2.0-rc.1 refusing dsh-mnemon 0.5.18, which declares DSH 0.1.7 only; [Compatibility and upgrades](../reference/compatibility.md) lists which releases each DSH takes.

- Check which version npm has: `npm view dsh-mnemon version`.
- For 24 hours after a release, pnpm does not pick the new version by default and installs an earlier one instead, which leads to this message. After two releases within a day it falls back further. Where DSH accepts that earlier release, **Add plugin** on DSH 0.2.1 says which version it installed, while DSH 0.2.0 shows no message, so check the version on Status. Click **Edit**, type the version as well, for example `dsh-mnemon@0.5.35` (use the version `npm view` shows), and click **Install**; on the command line, run `dsh plugin --profile web add dsh-mnemon@0.5.35`. Or retry after 24 hours.
- A versioned install pins the profile to that version. To upgrade later, run `dsh plugin --profile web update --latest dsh-mnemon` once the next release is a day old; within that day, add the new version by name the same way.
- Do not accept the risk for an older release with `allow-version` or similar: it really has not been verified on that DSH.

### The Plugins page says pnpm was not found

Run `npm install --global pnpm`, then start DSH again from a new terminal so that DSH finds pnpm on PATH. On the command line the message is `pnpm was not found; install pnpm and make it available on PATH.`

### The registry cannot be reached

Click **Registry** on the right of the dialog, switch between the Official npm registry and the Mainland China mirror, and retry; on a company network you can enter a custom address.

### Status says "Mnemon CLI not found"

Install the CLI as in [step 1](#1-get-nodejs-pnpm-and-the-mnemon-cli) and restart DSH. DSH looks for `mnemon` on PATH and in common install directories; if it still cannot find it, set `mnemon.cliPath` as described in [Other ways to install the Mnemon CLI](#other-ways-to-install-the-mnemon-cli).

### The Memory System is read only when opened from another device

When DSH is opened from another device (for example through an address set up with `--trusted-host`), the Memory System is read only by default and says why. If you do need remote management, set `remoteAccess: trusted-host` and restart DSH as the [operations guide](./operations.md#remote-management) describes. Desktop app windows and a browser on the same computer are not remote pages.

### ERR_PACKAGE_PATH_NOT_EXPORTED after an update

If dsh-mnemon was updated while DSH was running (for example on the desktop app's Plugins page), enabling a component can then show:

```text
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './starter' is not defined by "exports" in …/node_modules/dsh-mnemon/package.json
```

The new version is installed, but the running DSH still loads it with the old version's package information, which lacks an entry point the new version added: `./starter` after an update from 0.5.17 or earlier, `./bundle` after an update from 0.5.18 or 0.5.19. After an update from 0.5.18 or 0.5.19 the message can instead read `mnemon-bundle (dsh-mnemon/bundle): pending (waiting for service: mnemonStarterReady)`, because the running DSH keeps the old component group. Either way, quit DSH completely and start it again: `Cmd+Q` for the desktop app on macOS, or `Ctrl+C` and then `dsh web` again on the command line.

On 0.5.18 or 0.5.19, do not turn off `dsh-mnemon/starter` to make the message go away; that leads to the next problem.

### DSH says "waiting for service: mnemonStarterReady"

![The dsh-mnemon page under Plugins: Components 11 total, 11 off, with dsh-mnemon/starter first and Off; the sidebar has no Memory System](../../assets/install-v0.5.19/en/trouble-starter-off.jpg)

DSH prints this in the terminal when it starts, or shows it when you enable the plugin:

```text
dsh: warning: 1 entry did not activate
mnemon-bundle (cordis:group): pending (waiting for service: mnemonStarterReady)
```

The sidebar has no **Memory System**, and every dsh-mnemon component on the Plugins page reads Off. `dsh-mnemon/starter` has been turned off: in 0.5.18 and 0.5.19 this separate row prepares dependency resolution before the memory components load, and the others wait for it.

- Open **Plugins → dsh-mnemon** and turn on the `dsh-mnemon/starter` row. The Memory System appears right away; if it does not, restart DSH.
- The desktop app treats this as a failed start and shows its plugin recovery page. Click **Remove this plugin and continue** (your memory data stays), and once the app is up, add dsh-mnemon again as in [step 3](#3-install-and-enable-dsh-mnemon). Reinstalling 0.5.18 or 0.5.19 keeps the switch off, because the profile saves it, so then turn it on as above.
- From 0.5.20 there is no separate switch: the group prepares dependency resolution itself, and a leftover setting for it is ignored. If the message names `dsh-mnemon/bundle`, DSH was updated to 0.5.20 without a restart and still runs the old group; quit DSH completely and start it again.

### Upgrading DSH

Update dsh-mnemon on your current DSH first, then upgrade DSH, and update dsh-mnemon again. Otherwise DSH 0.2 turns a release before 0.5.19 off when it starts, with your memory untouched until the plugin is updated, and on DSH 0.2.1 releases up to 0.5.30 keep running while their memory subagents and **Check versions → Update** fail. [Older DSH releases](../reference/compatibility.md#older-dsh-releases) lists the release each older DSH keeps, and the [upgrade order](../reference/compatibility.md#upgrade-order) gives the steps, including how to update once where **Check versions → Update** stops with `already-installed`.
