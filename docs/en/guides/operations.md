# Operations, security and troubleshooting

[简体中文](../../zh-CN/guides/operations.md) | **English** | [Documentation](../README.md)

## Health checks

Open **Status** in the Memory System. If you use Mnemon Native, also check its binary; the other Providers do not need it:

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

![Status with each memory component, the Providers and the storage areas](../../assets/webui-v0.5.32/en/memory-status.jpg)

Status shows the dsh-mnemon and Mnemon versions, one card per memory component, the Providers and the effective directories. `mnemon status` opens the effective Store and may initialize data or run upstream migrations, so it is not a completely side-effect-free probe.

If OpenViking reports `/api/v1/admin/*` access restrictions, configure **User key owner (skip admin)** (`discoveryUser`), the account identifier, endpoint and user API key on Memory Spaces' page under **Plugins → dsh-mnemon**. This verifies access to the selected memory root using the data API; a denied or missing root keeps the previous configuration. It does not prove write permission or change the identity bound to the key. Leave the field empty for admin discovery. See [Provider boundaries and downgrade steps](./memory-providers.md#operational-boundaries).

## Version checks and updates

**Check versions** on Status opens the version panel:

- **dsh-mnemon**: installed is the version the owning Profile records (Status shows the version that runs); updates from npm `latest`. An installed beta/alpha/rc also checks its own channel and can graduate to a newer stable version. Stable users never opt into prereleases automatically.
- **Mnemon CLI**: installed from `mnemon --version`; latest from the official `@mnemon-dev/mnemon` npm package. Only Mnemon Native needs it, so a missing CLI shows as optional with its install command.

Checking is read-only and never installs automatically. Update appears only when a newer version exists and the source is safely recognized. Mnemon supports the official npm launcher, Homebrew Cask / Formula, and `go install`; dsh-mnemon supports npm installations in the owning DSH Profile. `link:` / `file:` development builds and unrecognized manual installs show guidance only.

dsh-mnemon updates through DSH's own plugin installer, as `dsh plugin add dsh-mnemon@<version>` would, and so does an optional Strategy the Profile added on its own. The installer uses the Profile's package manager, which in the desktop app is the app's bundled pnpm, so no pnpm is needed on PATH. It follows the Profile's registry settings and fallbacks and waits for the Profile's lock. Before keeping the new version, DSH checks the DSH versions it supports. A failed install restores the Profile's `package.json` and lockfile, the dialog shows pnpm's error line with DSH's log path, and the enabled plugins stay as they were; files the install downloaded can stay, and Check versions keeps showing the version the Profile records. Through DSH's installer the Host updates only the Profile it runs in. Where DSH offers no plugin installer, the Host runs pnpm from PATH in the owning Profile. With neither the app's pnpm nor one on PATH, the dialog asks you to install pnpm and restart DSH. dsh-mnemon 0.5.21 and earlier only know the pnpm route: in the desktop app, update from those versions once by uninstalling dsh-mnemon on the Plugins page and adding it again with **Add plugin** as `dsh-mnemon@<version>`, which keeps your memory data and settings. On DSH 0.2.1, whose installer no longer installs over a plugin the Profile has, 0.5.30 and earlier stop with `already-installed`; in the desktop app, update from them the same way.

npm updates require the active launcher to belong to the global root reported by the current npm. A different Node/npm installation or a broken launcher shows repair guidance instead. Use `npm install --global @mnemon-dev/mnemon@latest` to install or migrate, then `mnemon update` for later updates. The commands run on the DSH Host and need Node.js 22+. After changing PATH or a CLI override, recheck the executable path shown in the dialog.

On Windows desktop Hosts, memory operations and version checks use the native binary pinned by a recognized official Mnemon npm installation directly. This avoids the npm launcher's additional console window while retaining hidden subprocesses, timeouts, cancellation, and saved embedding settings. The displayed installation path and npm update ownership still refer to the original launcher. Unknown package layouts or missing native dependencies retain the launcher fallback and its repair diagnostics.

Expand dsh-mnemon's subpackage list to inspect Sources, Strategies, and Providers. Starter pins update with the Starter. Only independently installed packages in the owning Profile can update individually; source links are preserved. Package writes are serialized, and restart reminders survive subsequent checks and reopening the dialog. Read-only connections retain checks and command copying; page updates require management authority and `writeEnabled`.

Go updates additionally require the active executable to resolve to the current Go installation output (`GOBIN`, or the first `GOPATH` entry's `bin` directory), with no cross-compilation target. A downloaded binary is not a Go-managed installation merely because it contains Go build metadata. CLI updates must verify that the active executable actually reaches the checked release before reporting success.

The Host fixes update commands and arguments. The browser cannot supply either; shell is disabled and execution/output are bounded. A plugin update installs the exact checked version in its owning profile and verifies the installed package before reporting success; pinned beta versions cannot silently remain on an older release. After an update, the UI rechecks both components and refreshes Status automatically. Mnemon applies on the next CLI call. dsh-mnemon loads once DSH restarts: stop and rerun `dsh web`, or quit the desktop app completely (`Cmd+Q` on macOS) and reopen it. Until then the Host keeps running the previous version, while DSH loads the new Memory System page as soon as the files change; that page reopens **Check versions** with the update and the restart it needs. Until DSH restarts, a notice above every Memory System page names the installed version and the one that still runs, whether the update came from Check versions or `dsh plugin`; packages updated on their own are named too. Status shows the running version, and **Check versions** the installed one, so it does not offer that update again.

## Backup and recovery

<a id="recommended-settings-zip"></a>

### Recommended: ZIP from the plugin page

**Storage → Backup and migration** on the `dsh-mnemon` page under **Plugins** operates on the **currently effective root**:

- **Export ZIP** includes Runtime, Documents, and every Mnemon Native Memory Space. Third-party connections, local external stores, and remote data are excluded.
- Only the memory sources dsh-mnemon ships are in it: runtime memory, Project Documents and Memory Spaces. A memory source installed from another plugin package is neither exported nor imported; it keeps its own data.
- **Import ZIP** previews, validates, then merges into the effective root.
- Packs include `manifest.json`, SHA-256 inventory, and component summaries.
- Export/import hold component locks; a Memory Space with an uncheckpointed WAL is rejected.
- Import checks paths, counts, compressed/expanded limits, JSON schemas, Document hashes, registry consistency, and SQLite headers.
- Merge is staged before replacing component directories; commit failure restores pre-import directories.

The UI offers safe merge, not “overwrite everything”:

- Runtime deduplicates by target and content.
- Identical Document ID + hash is skipped; conflicting content receives a new ID.
- Memory Spaces are compared by the memories and links they hold, never by the read counts a recall rewrites or the vectors filled in later. A link is the two memories it joins and its type: merging spaces or linking again rewrites its weight, note and time, and the same link with other values is still the same link, which keeps this machine's values. A weight or note changed on one machine therefore stays on that machine, and the branch holds the values of the machine that synced last. A memory's update time does not take part either: filling in its vector once the embedding service answers again, with **Fill in** in the embedding settings or `mnemon embed`, or keeping it from pruning with `mnemon gc --keep` moves that time without changing the memory. A space with the same ID takes in the memories only the incoming version holds, so two machines that both added memories end with one space holding both; this machine's own rows, read counts, read log and schema stay as they are. When a memory differs on the two sides, edited or forgotten on one of them, the incoming version is kept beside this one under a new ID, once, and its later versions move that copy on instead of adding another. A space with a new ID is skipped when one of the same name here already holds all its memories. This reads the databases with `node:sqlite` (Node 22.13, 23.4 or later); earlier Node, a database it cannot read, one with a virtual table, or one of more than 500,000 rows is compared by its bytes.

Import is governed by `writeEnabled` and is rejected in read-only deployments. A ZIP contains private memory—encrypt it, restrict access, and rehearse recovery. Provider credentials live in `state/memory-providers.json` with mode `0600`; they are excluded from ZIP. Saved credential values are not returned through management responses either. Protect the entire `state/` directory in the offline snapshot below if connections must be backed up.

![A verified backup preview before Safe import](../../assets/webui-v0.5.32/en/plugin-backup-preview.jpg)

### Git repository sync

**Storage → Git sync** publishes the same payload as ZIP backup to a Git repository, so another machine can pull it. The switch is off by default, and while it is off the row shows only its title and the switch: no status is read and no Git command runs. Switched on, the row opens one card that reads in the order it is set up: **Repository**, **Sync**, **Automatic sync**, **Backup history** and **Advanced**. The remote holds readable files; the storage root is never made a Git work tree.

Like the ZIP, a sync carries only runtime memory, Project Documents and the Mnemon Native Memory Spaces. A memory source installed from another plugin package is not synced; it keeps its own data.

On the configured branch and remote directory (defaults `mnemon-sync` and `mnemon/`):

```text
<branch>:<subdir>/
+-- manifest.json       # Mnemon Pack manifest plus the sync extension
+-- checksums.json      # SHA-256 per payload file, as in the ZIP
+-- payload/
    +-- runtime/{memories.json,USER.md,MEMORY.md}
    +-- documents/{index.json,active/<id>.md,archived/<id>.md}
    +-- data/{.dsh-memory-bodies.json,<bodyId>/mnemon.db}
```

**Connecting a repository.** **Repository** offers two ways in:

- **GitHub account** runs GitHub's OAuth device flow. **Copy and open GitHub** copies the one-time code and opens `https://github.com/login/device` in one click, and the page then asks GitHub whether the browser step finished, at the interval GitHub asked for. Signed in, the same place lists the account's repositories with a search box: private and public ones are marked, one without push permission cannot be chosen, and a name that matches none can be created on the spot as a private repository. Choosing a public repository asks first, since anyone can then read the memory. A repository chosen this way authenticates with the grant, so a token saved earlier is removed; the `MNEMON_SYNC_GIT_TOKEN` environment variable, when set, still comes first.
- **Repository address** takes an `https://` or `ssh://` URL, a `git@host:path` address or an absolute path on the Host, and checks it before anything is sent: another form, or a password or token written into the address, escaped or not, is refused in the form. An HTTPS address may name the user its host wants a token under, as `https://x-token-auth@bitbucket.org/<workspace>/<repository>.git` does; **Credentials** below says when. The **Access token** field appears only for an HTTPS address, the only kind that needs one.

Once connected, the row shows the repository, whether it answers and how it authenticates: the GitHub sign-in, a token, the `MNEMON_SYNC_GIT_TOKEN` environment variable or an SSH key. When the repository cannot be read, the row says why: no credentials, a credential the host rejected, an address that leads nowhere (GitHub answers "not found" for a private repository it will not show without credentials), a network that does not reach the host, or no answer within 20 seconds. An HTTPS repository refused for its credentials, or reported not found (which GitHub also answers when the credentials cannot reach it), offers **Set credentials**; one that answers without any is marked as needing them before the first push fails, with a GitHub sign-in offered for `github.com` and a token for any other host. **Change** reopens the two ways in. **Disconnect** asks first, then forgets the repository, its saved token and the automatic sync interval, without deleting anything here or in the repository.

**Syncing.**

- **Sync now** is the one primary action. It merges the branch into this machine first, then exports the complete pack into `<storageRoot>/state/sync/git`, commits it there and pushes the branch. The row then says what happened (how many remote memories the merge brought in and which commit it pushed, that the repository was already up to date, or why the push did not finish) and when the last sync ran. That time is kept in `state/sync/last-run.json`, so it survives a restart.
- **Check remote** reads what a sync would change and writes nothing: for each component whether the two sides differ, and for runtime memory how many entries are only on the remote, only here, or written differently on both. Its **Merge here only** merges the branch without publishing anything; its **Sync now** runs the same sync as the row.
- **Automatic sync** offers an interval (off, every hour, every 3, 6 or 12 hours, every day, every 3 or 7 days), saved as soon as it is chosen. While it is on, the Host repeats the same sync in the background, reading the interval from `state/sync-git.json` on every tick, so a change takes effect at once and no restart is needed. The row says when the next run is due, or why the last one failed. The timer never writes memory beyond the merge a sync performs.
- Both directions require `writeEnabled`; a read-only deployment refuses them with the same message Import ZIP uses.

**What the channel guarantees.**

- **One repository per mirror.** The mirror names the repository it was filled from and is rebuilt for another one, and a branch the remote does not hold starts a new history. Switching to an empty repository, or syncing after the remote branch was deleted, never publishes earlier payloads there again.
- **No machine overwrites another.** The branch is merged before every push, and a push Git refuses because another machine published meanwhile folds the branch in again and is tried once more. Only a second refusal is reported; syncing again resolves it.
- **One copy per divergence.** A document that differs on the two sides is kept beside the local one under a new id, and merging the same version again, as a retried sync does, does not add a second copy. A memory space merges instead: the memories either side added join one space, and the read counts a recall writes never make a copy. Only a memory edited or forgotten on one side keeps the other version as one copy, which that side's later versions move on.
- **No stuck lock.** The sync lock records its owner, so a Host that stopped mid-operation does not leave every later sync refused: a lock whose process is gone is taken over at once, one an older version left without a record after 15 minutes, and any lock after an hour. The one-command credential files such a Host left behind are removed.
- **An edit travels, not a copy.** A Project Document differs on the two sides only when both changed it since they last agreed.
  - After every merge and every publish, a machine records each Project Document's version as it and the branch then agree on it, and the commit they agreed at (`state/sync/base.json`). A version covers the text, title, description, archive and links, but not when the document was last read.
  - A document only the branch changed since then replaces the older version on this machine. A document only this machine changed is published as it is. Editing, renaming or archiving a document between syncs therefore adds no copy.
  - A document both sides changed keeps this machine's version under its id, at a revision above both, and the branch's version beside it as a copy, even when only its title or archive differs. A branch version with a lower revision than this machine's, which a machine on an older dsh-mnemon can publish, is kept as a copy too.
  - The agreement is used only while the branch still descends from the commit it was made at. A machine with no agreement on record, such as one updated from dsh-mnemon 0.5.28, which kept none, uses the documents at the commit of its last sync instead (`state/sync/last-run.json`), as the branch held them after this machine published or merged them, while the branch still descends from that commit. That record is dropped when the repository, branch or directory changes, and a branch version above this machine's revision is never taken from it.
  - Without either, every document whose text differs keeps a copy, as before. This happens on the first sync after an update from a version before 0.5.28, on the first sync with another repository, branch or directory, and after the branch is deleted and published again.
- **Git 2.20 or newer** is enough: the mirror is initialized without options later Git versions introduced.
- **Merges are validated.** A merge reads the remote manifest and its SHA-256 inventory first; a manifest or checksum mismatch is a hard failure that imports nothing. A push judges the payload it is about to publish by the same rules an import applies, so a Documents index whose digest or size disagrees with its document stops the push with the document's name, and nothing reaches the branch. A ZIP export still downloads such a store, so it can be backed up before it is repaired.
- **Backup size.** Git stores a brand-new blob for every push, and the payload is the whole pack, so every successful push folds the mirror's loose objects into one pack (`git repack -adf`). A collection that fails is reported in the push result as a warning and never fails a push that already succeeded.
- The payload is the existing Mnemon Pack payload: one collector, one validator, one importer. Packs carry `manifest.json`, the SHA-256 inventory and component summaries, and the sync extension records the channel, branch, directory and push time. A reader that does not know sync still reads a valid Mnemon Pack manifest.
- The payload carries memory content only: runtime, documents and memory-spaces, with the user profile inside runtime. Configuration belongs to the profile layer and never travels in a payload, so a second machine keeps its own settings instead of inheriting this machine's. A sync always carries the full pack; the [sync channel](../reference/interfaces.md#sync-channel) says why.
- The mirror under `state/sync/git` is disposable and never a pack component, so it cannot sync itself; deleting it costs one fetch. Every sync, Check remote and backup history included, brings the sync directory inside the mirror back to the branch, so a file Git does not track there, such as the `-wal` and `-shm` SQLite leaves beside a database opened in place, is removed rather than read as payload; keep nothing of your own there. Every payload file is published whatever ignore rules the machine has, such as a global `*.db`. A branch an earlier version published without such a file fails the checksum check on every machine: delete the branch on the remote, or choose another directory under **Advanced**, and sync once.

**Advanced** keeps this computer's name, the branch, the directory in the repository and the commit author, each showing the value in use; saving a new branch or directory says that the next sync writes there. **This computer's name** is what backup history and **Check remote** show as "from …" and what every sync publishes with its version: **Host name** uses the computer's current host name and follows it when it changes, and **Custom** takes a name of up to 120 characters on one line. A new name is used from the next sync on, which records it in a version of its own; earlier versions keep the name they were published with. The author is an explicit choice. **Default** commits as `dsh-mnemon sync <mnemon@localhost>`. **This computer's Git** uses the `user.name` and `user.email` Git has on the machine, and the default identity where none is configured, rather than failing or publishing a name Git guessed from the account and host names. **Custom** takes a name and an email.

**Credentials.** They stay out of the payload, the DSH profile configuration, the browser, responses, error messages and the logs; the [sync channel](../reference/interfaces.md#sync-channel) gives the order in which they are resolved and the fields that describe them.

- A GitHub sign-in is kept in DSH's credentials store and is used only for repositories on `https://github.com`. Its scope is `repo`, so it reaches private repositories; a repository on another host needs its own token. A grant GitHub no longer honours is reported as such, with **Sign in again**. Signing out deletes the stored grant. A Host that mounts no credentials provider offers the address form alone.
- A saved token lives in `state/sync-git.json` (mode `0600`) and belongs to the host it was saved for: moving the repository to another host forgets it unless a new token comes with the move. The `MNEMON_SYNC_GIT_TOKEN` environment variable, when set, comes before both.
- Git is offered the token under a user name: the one the address names, else `oauth2` for `gitee.com`, which refuses `x-access-token` (Gitee requires `oauth2` or the account name), and `x-access-token` for every other host, as before. GitHub documents `x-access-token` for its tokens on github.com, GitHub Enterprise Server and `*.ghe.com`, and GitLab, Gitea and Azure DevOps accept it. A host that wants another name is given it in the address: a self-hosted Gitee takes `oauth2` or your account name, as in `https://oauth2@gitee.example.com/<owner>/<repository>.git`, and Bitbucket Cloud takes its access and API tokens under `x-token-auth`. Git looks the token up under that name whatever this machine configures for the host, such as the `credential.<url>.username` and `credential.useHttpPath` Git Credential Manager sets, and an address that writes its host in capitals or with its port finds it too. An earlier dsh-mnemon refuses a saved address that names a user, even to change or disconnect it, so remove the name before going back to one.
- A host that rejects the credential it was offered is reported as such, naming what it rejected: the GitHub sign-in, which signing in again renews; a saved token, which a new one under **Access token** replaces; or `MNEMON_SYNC_GIT_TOKEN`, which only the environment can change, and which comes before the other two. On a host other than github.com, the line for a saved token also points at the user name in the address. The page asks for a sign-in or a token only when there is none.
- Sign-in works even when the launcher passes no proxy policy on: the Host retries once through a proxy it discovers, and names `HTTPS_PROXY` when it finds none. The [sync channel](../reference/interfaces.md#sync-channel) describes the fallback.
- A remote that cannot be read fails the sync before anything is committed. A push the remote refuses after the commit, for example without write access, keeps the commit in the mirror and says why. Nothing is lost either way; sync again once the remote answers.

### Seeing every machine's backups and differences

**Backup history** lists the versions the branch holds, newest first, by the manifest each commit carries: when it was synced, from which computer, what each component held, and the commit message where a person wrote one. The remote is one shared branch, so this is the list of every machine's backups. An empty branch reports an empty history, and a commit whose manifest cannot be read is skipped while the rest are still listed. The history is read 20 commits at a time, and **Load earlier versions** appends the next page, up to the latest 100 versions.

**Check remote** compares by entry, not by byte: an entry is identified by its target and its content, so the same memory counts as one entry wherever it was written. Runtime memory falls into these kinds:

- **Written differently on both sides**: two entries in the same target whose text is nearly the same, such as "Prefer concise answers in every reply" and "Prefer concise answers for all replies". Similarity is the overlap of character bigrams, and only `0.6` or more counts as the same subject, so unrelated memories are never called a conflict for sharing a target. A sync keeps both wordings; **Show** lists the pairs side by side, and **Go to Memory reconciliation** leads to the one place they are merged.
- **Only on the remote**: entries the branch holds and this installation does not. A merge adds them and honors the removals the branch recorded. Entries this installation deleted earlier, and the branch still holds, are counted apart: a merge keeps them out, and **Bring them back** overrules that deletion once, after which the tombstones it overruled leave this installation's state. The dialog then says how many entries it actually wrote.
- **Only here**: entries this installation holds and the branch does not; a sync shares them.
- **Removals not applied here**: deletions the branch recorded that this installation has not carried out yet; a sync applies them. The branch keeps every removal either side ever recorded, so a removal this installation already applied, or has since written over with the same content, is not counted again.

The two sides of a conflict count as the conflict, not in the per-side counts. Both lists are bounded, and the dialog says when there are more differences than it counted.

Checking the remote and reading the history are reads: nothing is imported and no local memory changes. The only writes are **Sync now**, **Merge here only**, **Bring them back** and **Apply**; `runtime` in a merge's answer reports how many entries it wrote and how many stayed out because this installation had deleted them.

### Memory reconciliation

Reconciling reuses the existing review ledger, and the **Reconcile** button on the **Memory reconciliation** row under **Storage** is the one entry to it:

- The run reads the difference, including both wordings of every conflict, as evidence. It is also given the entries the sync branch holds and this installation does not, and the opinions already recorded on pending proposals, oldest first, so a request can answer a proposal directly before reconciling again.
- **What to accomplish** states what the run should achieve, for example "keep the short wording, do not merge near-duplicates". It describes the goal and never widens permission: what an operation may contain is still the Host's decision. The answer says whether your request was followed and how many branch entries the plan could see.
- The plan arrives as a pending proposal that is never written on its own. It lists every operation with its reason, and can be **Accepted** and then **Applied**, rejected, or annotated with an opinion first.
- A rejected plan has to be **reopened** before the AI is asked again: a decided proposal is answered by its decision, so the reviewer's words only reach the next run once it is open again. That is why the order is "leave an opinion, reopen, then ask again".
- An accepted plan can be applied in part. Every operation carries a checkbox, only the positions that have not run are offered, **All** and **None** switch the whole set, and the button names how many it will apply; an empty selection says so instead of applying nothing silently. The ledger records the positions that ran (`appliedOperations`), shown as "{count} of {total} operations have run", so a plan applied in part stays in the list until every one of its operations has run.
- A plan whose operations all ran leaves the list for the **Applied plans** dialog, kept for reading. Reopening one there does not undo what it wrote; it restores the whole plan as a pending decision.
- A read-only Host can still read and annotate the ledger; applying is what requires a writable deployment.

### Recovery rehearsal

1. Under **Storage**, set **Data directory** to **Custom**, enter an isolated directory and apply.
2. Confirm the current read/write root on Status is that directory.
3. Select the backup under **Backup and migration**, review its preview, then import.
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
<storageRoot>/state    # when present; outside the built-in Pack's four data components
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

## Disable the complete Starter

The legacy `mnemon` Entry remains the lifecycle switch for the complete Starter. To disable Mnemon without leaving its Source or Strategy Entries waiting on the missing Host service, add this profile patch and restart DSH:

```yaml
- id: mnemon
  disabled: true
```

This disables the Core/Host, all three bundled Sources, both main Strategies, and all three optional Strategy enhancements together. It does not remove installed packages or delete memory data. Remove the override, or change it to `false`, and restart DSH to enable the Starter again.

<a id="cloud-hosted-webui"></a>

## Cloud-hosted WebUI

The DSH releases in the [compatibility matrix](../reference/compatibility.md) are the supported registry targets. It authenticates the page, every RPC, and every stream through an authority-bound browser session created from the launch-token URL printed by the Host. `--trusted-host` remains a Host/Origin fence; it does not replace HTTPS or deployment access controls.

1. Terminate HTTPS at a reverse proxy or access gateway and protect the public entry for its intended users. Proxy the same-origin `/` and `/api` traffic, including streams, to `http://127.0.0.1:3080` while preserving the external `Host` authority.
2. Start the loopback service with the external authority. Use a bare `host[:port]`, not a URL:

   ```sh
   dsh web --trusted-host memory.example.com --no-open
   ```

   For a non-default public port, use the exact authority, for example `memory.example.com:8443`. DSH deliberately rejects `--host 0.0.0.0`; keep the service on loopback and let the proxy or an SSH tunnel reach it.
3. For a browser that does not already have a valid cookie for this public authority, use the launch-token URL printed as `dsh web: ...`. With a reverse proxy, replace only the printed loopback origin with the public HTTPS origin and preserve the `/` path and `?token=...` query. For example, transform `http://127.0.0.1:3080/?token=...` into `https://memory.example.com/?token=...`. Treat that URL as a credential and do not put it in logs, tickets, or chat. DSH exchanges it for an HttpOnly, SameSite cookie and redirects to a clean `/`; a still-valid authority-bound cookie can survive a Host restart.
4. Open the clean external URL and verify that **Status** and the `dsh-mnemon` page under **Plugins** both load and a page reload remains authenticated. Remote settings are read-only by default. If management is intended, apply the [explicit remote management grant](#remote-management), restart DSH, then verify one deliberate small save.

An HTTP 403 can indicate a Host/Origin mismatch or an old remote Client still using standalone channels: check `--trusted-host`, the public authority and proxy routing, then upgrade dsh-mnemon, restart DSH and reload the browser. Remote Mnemon calls use the authenticated API Gateway. An HTTP 401 requires restoring the Host's browser authentication or pairing. A response saying remote management requires `remoteAccess: trusted-host` is a separate Mnemon grant check; successful browser authentication alone does not authorize management.

<a id="remote-management"></a>

### Remote management

For authenticated remote clients, `remoteAccess: trusted-host` grants management operations; remote reads and narrow activation do not need it. Without it, a remote page's Memory System and plugin settings say why they are read only. A browser on the same computer and DSH desktop windows are not remote clients and do not need it. Configure management only for the intended authenticated users. To run an older DSH, keep the Mnemon release verified with it and its pre-upgrade Session backup; see the [compatibility matrix](../reference/compatibility.md).

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
         maxRankedResults: 2
   ```

   A profile patch replaces the targeted row's complete `config` instead of deep-merging one field. Preserve existing customizations, and compare it with `dsh web --dump-default-config` after a plugin upgrade so new bundled defaults are not masked.
2. Inspect the effective tree with `dsh web --dump-config`. Confirm that the final `mnemon` row contains `remoteAccess: trusted-host` and that stderr reports no unmatched `mnemon` target.
3. Start DSH with the same `--trusted-host` command, and restart after any `remoteAccess` change because Mnemon captures that policy at startup. Verify **Status**, settings loading, and one deliberate small save through the authenticated remote connection.

## Security boundaries

<a id="process"></a>
<a id="files"></a>
<a id="web-and-model"></a>

The Host runs the Mnemon CLI without a shell, bounds every call's time and output, and serializes writes behind locks and revisions. The browser never receives credentials and cannot start processes, and each task Agent gets only the memory tools its task needs. [Architecture](../development/architecture.md#security-boundaries) lists each boundary.

These boundaries are not a secret scanner. There is no deterministic credential detection; never submit keys, tokens, private keys, or raw sensitive logs.

A skill installed from the Skills market is instructions an Agent follows, and may carry scripts. dsh-mnemon never runs a skill's scripts itself: every install is previewed first, a site's artifact must match its published digest, archives may not hold links or paths outside the skill folder, and size and file counts are bounded. Review a skill before installing it; see the [Skills guide](./skills.md#data-and-trust).

### Security reporting

Report vulnerabilities privately through [SECURITY.md](../../../SECURITY.md), not a public issue. Data loss, path traversal, lock/revision bypasses, subagent-isolation breaks, and injection through rendered memory are in scope.

## Troubleshooting

`mnemon.cliPath` accepts an explicit path or a command name resolved against the Host's PATH. If the binary is installed or restored into an existing search directory while DSH is running, choose **Refresh** in the Memory System header to update availability without restarting. Changes to the Host process's environment still require a restart. Status and version checks resolve the same configured command.

| Symptom | Check and resolution |
|---|---|
| Plugin details show the `mnemon-bundle` container row (named `dsh-mnemon/bundle` from 0.5.20, `cordis:group` before) as off, and its switch returns `unknown-plugin` | Known container-display issue in DSH 0.2.0, as in 0.1.7; DSH 0.2.1 no longer lists the row, and the configuration then leaves out its note. Check **Memory System → Status** and the actual components; continue using Mnemon if they and memory operations work. Use the top-level bundle or `mnemon` core component switch for the composition; do not reset data or remove the group. See [cause, handling and fix boundaries](../reference/compatibility.md#the-bundle-component-list-on-dsh-020) and [upstream #649](https://github.com/dsh-external/issues/issues/649). |
| Terminal flashes when switching conversations on Windows | Update the Starter, or Runtime Source if independently installed, then restart the DSH Host. Runtime Git branch detection hides its console window; Git failures, timeouts and detached HEAD still fall back to an unfiltered Runtime view. |
| Mnemon unavailable | macOS/Linux: run `command -v mnemon`, `mnemon --version`. Windows PowerShell: run `Get-Command mnemon`, `Test-Path "$env:LOCALAPPDATA\Programs\mnemon\mnemon.exe"`. Set `MNEMON_CLI_PATH` or `mnemon.cliPath`, then restart |
| Electron desktop Host cannot run npm CLI scripts | Verified npm launchers use child-only `ELECTRON_RUN_AS_NODE=1`. If the desktop shell disables the [Electron `runAsNode` fuse](https://www.electronjs.org/docs/latest/tutorial/fuses#runasnode), this flag is ignored; set `mnemon.cliPath` to the official native binary (`mnemon.exe` on Windows). Automatic npm updates still require a Host that can run the JavaScript launcher |
| Headless Agent has no Mnemon tools | Plugins are profile-local. Run `dsh plugin --profile headless add dsh-mnemon`; a Web-profile installation does not carry over |
| Memory System entry missing | Check `tabEnabled=true`; `displayMode=sidebar` uses the sidebar, while `displayMode=builtin` uses the open conversation's tabs. For a local link run `pnpm run build`, then restart the profile |
| An old `buildin` preference opens a conversation tab | It is saved as `builtin`; choose **Sidebar** under **Interface** to keep the standalone entry. Memory scope and stored data are unchanged |
| Status healthy but recall empty | Check active spaces, storage scope, inspected root, effective session root, and query focus |
| Header reports misalignment | Confirm that the inspected workspace is intended. Workbench tasks execute there; conversation tools retain their own session scope |
| A setting appears unchanged | Switches and selectors apply at once; typed values need **Apply**. A failed write shows its reason beside the control and restores the saved value |
| Custom directory rejected | Use an absolute path, `~`, or `~/...` |
| `memoryBodyId is required...` | Active count is not exactly one; select a target explicitly |
| `memory space is not active for reading` | Activate it in Overview; inactive writes are allowed, reads are not |
| Provider error | Review needs guarded local child publication; use bounded `spawn` or opt-in `fork`. To review while Team tools are installed, opt into `idleReview.agentTeams: scoped`; `pause` stays the default. Inspect partial-write receipts before retrying |
| Idle review fails with `no user query found in messages` on a local model, such as Qwen3.x on Ollama | Once tool results filled the model's context window, Ollama's truncation dropped the subagent's prompt. From 0.5.22, Mnemon adds a short user turn to a refused subagent step and retries it ([#327](https://github.com/omdsh-dev/dsh-mnemon/issues/327)); update dsh-mnemon. A larger Ollama context length (`OLLAMA_CONTEXT_LENGTH` or the model's `num_ctx`) also avoids the truncation. The review may have created a Document before it failed; check the partial-write receipts |
| The sidebar shows empty **Untitled** rows under **Ungrouped**, more each time a memory task ran | dsh-mnemon 0.5.32 and earlier gave the task Agent of a memory task (Save to memory, Ask Agent, Document archive, runtime memory capacity maintenance, memory reconciliation and the rest) no subagent origin, and DSH lists such a session as a conversation wherever it holds no projection-cache record of it ([#435](https://github.com/omdsh-dev/dsh-mnemon/issues/435)). Update dsh-mnemon, and later tasks stay out of the list. The rows already there stay: dsh-mnemon does not remove them, and memory data is unaffected. To hide one, use **Archive session** on its row; DSH keeps it under its archived filter, and **Unarchive session** brings it back |
| Runtime replace exceeds capacity | Shorten it or organize first; automatic maintenance handles add overflow only |
| Document source path rejected | Keep it inside the session workspace and outside managed Documents |
| CLI timeout | Increase `timeoutMs`; large Stores may need more than 10 seconds for status or graph |
| Lock timeout | Check other writers; never delete a lock owned by a live process |
| ZIP export reports WAL busy | Wait for Memory Space writes to settle; do not bypass the uncheckpointed-WAL guard |
| ZIP import checksum/schema failure | The backup is damaged or incompatible; preserve the current root and never unzip over it manually |
| No Update button | Already current, remote check failed, or the source is link/manual; follow panel guidance |
| An authenticated remote page can read or activate a Memory Space but cannot save settings or perform other writes | Default management restriction; for intended remote management, preserve the current configuration, set `remoteAccess: trusted-host` locally, and restart DSH |
| In the DSH desktop app, runtime memory, Memory Spaces and the plugin settings are read only while agent tools still write | dsh-mnemon 0.5.18 and earlier treated desktop windows as remote pages ([#310](https://github.com/omdsh-dev/dsh-mnemon/issues/310)); uninstall dsh-mnemon on the app's Plugins page and add it again with **Add plugin**, with no `remoteAccess` change |
| DSH 0.2 reports dsh-mnemon as incompatible when installing or starting | A release before 0.5.19 was installed; update dsh-mnemon, and within 24 hours of a release install the versioned package as [Install and start](./installation.md#common-problems) describes |
| With dshmarket in the Profile, DSH warns at start that `mkt-client-dsh-mnemon-source-memory-spaces` did not activate (`Memory Spaces requires at least one explicit Provider child`), Status shows Runtime Memory or Project Documents twice, or every turn fails with `found ambiguous working-context Sources` | A Source package is also installed on its own in the Profile, and dshmarket 1.66 loads it a second time as a client-only mount ([#359](https://github.com/omdsh-dev/dsh-mnemon/issues/359)). Update dsh-mnemon to 0.5.27 or later. If the Profile maintains Memory Spaces itself, also update it to 0.5.18 or later: **Check versions** does so where pnpm is on the Host's PATH, otherwise run `dsh plugin --profile web add dsh-mnemon-source-memory-spaces@0.5.18`. Then restart DSH. Removing the separately installed Source from the Profile, for example with `dsh plugin --profile web remove dsh-mnemon-source-memory-spaces`, also ends it, because the Starter brings its own copy. Memory data is unaffected |
| After dsh-mnemon was updated while DSH ran, enabling a component reports `ERR_PACKAGE_PATH_NOT_EXPORTED` (`Package subpath './starter'` or `'./bundle'`) | The running process still loads with the old version's package information; quit DSH completely and start it again (`Cmd+Q` for the desktop app). On 0.5.18 or 0.5.19, do not turn off `dsh-mnemon/starter`; see [Install and start](./installation.md#err_package_path_not_exported-after-an-update) |
| `mnemon-bundle (cordis:group): pending (waiting for service: mnemonStarterReady)`, or the desktop app fails to start and shows its plugin recovery page | `dsh-mnemon/starter` of 0.5.18 or 0.5.19 is off; turn it on under **Plugins → dsh-mnemon**, or update to 0.5.20, which has no separate readiness switch. On the desktop app, remove the plugin from the recovery page and add dsh-mnemon again; see [Install and start](./installation.md#dsh-says-waiting-for-service-mnemonstarterready) |
| `mnemon-bundle (dsh-mnemon/bundle): pending (waiting for service: mnemonStarterReady)` right after an update | DSH was updated to 0.5.20 without a restart and still runs the old component group; quit DSH completely and start it again, as [Install and start](./installation.md#err_package_path_not_exported-after-an-update) describes |
| Skills' **Evolution** stays empty, a turn shows **Review failed**, or the market says GitHub declined | Self-evolution is off until turned on; a review needs a few turns of work and a pause. GitHub allows 60 unauthenticated requests an hour: set `GITHUB_TOKEN` or `GH_TOKEN` in DSH's environment and restart. See [Skills troubleshooting](./skills.md#troubleshooting) |
| Mnemon RPC returns 401 after a DSH restart or authority change | Open the launch URL printed by `dsh web` so the one-time token can establish a fresh authority-bound browser cookie |

<a id="dsh-015-compatibility-and-legacy-session-recovery"></a>

## Legacy Session recovery

The error `source summary requires notice form; source v0 artifact remains unchanged` comes from older Mnemon messages in DSH Session logs. New recall/instruction messages omit that invalid summary. Updating the plugin does not rewrite an existing Session. To repair one affected log:

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

The supported DSH releases are in the [compatibility matrix](../reference/compatibility.md). The Web interface is bilingual, while commands, tool cards, compatibility metadata and some errors remain partly untranslated.

<a id="document-archive-recovery"></a>
<a id="runtime-archive-recovery"></a>

## When an archive fails

What a failed or interrupted archive keeps, and what to check before retrying, is described with each workflow: [Document archive recovery](../reference/workflows.md#document-archive-recovery) and [Runtime archive recovery](../reference/workflows.md#runtime-archive-recovery).
