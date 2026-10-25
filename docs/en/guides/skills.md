# Skills

[简体中文](../../zh-CN/guides/skills.md) | **English** | [Documentation](../README.md)

**Skills** is one place for the DSH skills a workspace can load. You can switch a skill off, use it in the conversation, edit it and go back to an earlier version. It can also improve skills from your real conversations, test every change before you adopt it, and install more skills from the places they are already published. Skills is **experimental**: it ships with dsh-mnemon and is on, but self-evolution stays off until you turn it on.

| Where | What you do there | How to open it |
|---|---|---|
| [The Skills page](#the-skills-page) | Manage skills, handle what self-evolution suggests, test skills, install more | **Memory System → Skills**, or its own sidebar entry |
| [In a conversation](#in-a-conversation) | See which skills a turn used and what its review suggested | The **Turn skills** line under a finished turn |
| [Settings](#settings) | Turn self-evolution, its parameters, the conversation line and the sidebar entry on or off | **Plugins → dsh-mnemon → Skills**, or the gear on the Skills page |

A skill is a folder with a `SKILL.md`, in the [Agent Skills](https://agentskills.io/specification) format DSH reads. The page never calls a model itself, and skills reach the model only through DSH's own `skill` tool: Skills never adds anything to a turn's memory View.

The screens below come from the [v0.5.34 Skills gallery](../../assets/skills-v0.5.34/README.md), captured on the fictional Lumen project: the assistant wrote release notes with the `release-notes` skill, the user corrected the format, and self-evolution took it from there.

## The Skills page

The page has five tabs: **Skills**, **Evolution**, **Evals**, **Market** and **Trash**. The count on **Evolution** is how many suggestions and drafts wait for you.

### Skills

![Skills: every skill by where it lives, one shadowed; release-notes with an improvement waiting](../../assets/skills-v0.5.34/en/skills-library.jpg)

The list groups every `SKILL.md` DSH can load by where it lives, in DSH's order of precedence: the project's `.dsh/skills` and `.agents/skills`, then your `~/.dsh/skills` and `~/.agents/skills`. When two skills share a name, DSH loads the first, and the other is marked **Shadowed**. Files DSH would refuse are counted under the list (*N files cannot load*) and open to their reasons.

- Each row has a **switch** that turns the skill on or off for both the model and the `/` menu, and **Use** (on hover) that returns to the conversation with `/name` in its input. A dot means an improvement waits for the skill DSH loads.
- **New** writes a `SKILL.md` from a name and a description in the root you choose; the name must be lowercase letters, digits and single hyphens.
- The detail shows the rendered `SKILL.md` with **Use**, **Edit** and a menu with **Draft an improvement** (a task Agent writes a draft, optionally from your note) and **Remove** (the folder moves to the **Trash** tab).
- **Invocation** is one choice: **Auto and / command**, **/ command only**, **Auto-load only** or **Off**. It writes DSH's own `disable-model-invocation` and `user-invocable` keys.
- **Tests** is one line with the skill's case count and last score; it opens the skill under **Evals**. **Versions** and **Files** fold away: every change (creation, edit, invocation, install, an adopted improvement, a restore) leaves a version you can compare and restore.

Every write is fenced by the file's hash, so a skill edited elsewhere in the meantime is not overwritten.

### Trash

**Trash** lists removed skills with their name, removal time, original location, bundle or single-file layout, and size. **Restore** returns a known entry to its recorded path, including its original project even when another workspace is selected. Older entries without a known location ask you to choose a root.

When the name is already taken, choose another name, explicitly confirm replacement, or cancel. Replacement checks the current file hash and keeps the displaced skill in the Trash. Renaming updates the skill name while retaining the bundle's other files. The list and count refresh after each operation.

**Delete for good** asks you to type the skill name. **Empty the Trash** has its own confirmation. Both permanently remove files; ordinary **Remove** keeps them recoverable.

### Evolution

The page follows drafts and backtests while they run, refreshes the cards again when they finish, and reloads when you return to the window or tab.

**Pending** lists what waits for you: suggestions, and drafts written for a skill directly. **Done** keeps what was adopted, dismissed, expired or invalidated. **Evidence** lists the conversations reviews read. The sparkle button, **Review this conversation**, reviews the current conversation now instead of waiting for it to pause.

| A suggestion and its evidence | Its draft, backtested |
|---|---|
| ![Evolution, Pending: the suggestion to update release-notes, with its evidence folded out](../../assets/skills-v0.5.34/en/skills-suggestion.jpg) | ![The draft under the suggestion: its notes and changes, the backtest Current 40 → Draft 93 +53, and the diff](../../assets/skills-v0.5.34/en/skills-draft.jpg) |

- **A suggestion** says what it proposes, a new skill or an update to one, in one line, with its reason, the conversation it came from and its confidence. **Draft** asks a task Agent to write the new `SKILL.md`; **Dismiss** sets it aside. Its **Evidence** folds out the cited steps of the conversation, each linking to the full record.
- **A draft** shows its notes and changes, the backtest as one line, such as *Current 40 → Draft 93 +53*, which opens to each case's verdicts, and the diff. **Adopt** writes it (a new skill goes to your user skills or the project's, as you choose), **Discard** drops it, and the menu holds **Edit draft** and **Redraft with a note**. A draft that scored lower than the current version asks before it is adopted.
- **Evidence** shows each conversation as numbered steps (your messages, tool calls with their failures, skill loads) with what the review marked on them. **Pin** keeps a record from being pruned; choosing steps and **Make** turns them into test cases for a skill.

![Evolution, Evidence: four recorded conversations; the release notes conversation with its signals and numbered steps](../../assets/skills-v0.5.34/en/skills-evidence.jpg)

### Evals

![Evals: each skill with its cases and last score; release-notes with three cases and its backtest case by case](../../assets/skills-v0.5.34/en/skills-evals.jpg)

Every skill's tests in one place. The list shows the skills with cases first, each with its last score against the version DSH loads, then the skills without cases, then the skills a suggestion proposes that do not exist yet (**Not created**), which link to their suggestion.

- **Add case** takes a title, the task as the user would say it, optional context, and checks, each **Must** or **Should**. Cases also come from reviews and from evidence. Each case has a switch, and opens to its checks and the conversation it came from.
- **Backtest** runs the enabled cases against the current version, or without the skill when it does not exist yet. The history keeps the newest runs, each opening to its per-case verdicts, the steps the run took and its answer.

A backtest is a simulation: an executor follows the skill without tools and writes what it would do, and a judge grades each check. A case passes when every **Must** check passes, and the score counts **Must** checks twice. A case that could not run counts in neither score of a comparison.

For a case that needs a screenshot, scan or chart, select **Requires image input** when adding or editing it. Text-only backtests cannot receive images: the marked case shows **Not measured**, makes no executor or judge calls, and is excluded from the run's score and the draft/baseline comparison. If every selected case is marked, the run completes without a score. This is an explicit marker, not automatic image detection or attachment support.

Existing cases remain text-only and previous runs are unchanged; mark image-dependent cases and backtest again. To test a text transcription instead, put it in **Context** and clear the marker. Before downgrading to a Host without this support, turn off marked cases so the older Host does not try to simulate them.

### Market

![Market: searching changelog finds a skill in the listed sources and 30 on skills.sh](../../assets/skills-v0.5.34/en/skills-market.jpg)

The market reads skills from **sources**, each one way skills are already published:

| Source | What it offers |
|---|---|
| **Featured** (built in) | A curated list with descriptions in both languages; each skill installs from its upstream repository under the upstream license |
| **skills.sh** (built in) | The open index the `skills` CLI searches, hundreds of thousands of skills, queried once you type two characters and ordered by installs |
| **GitHub repository** | Every `SKILL.md` in a repository or one folder of it, Claude Code plugin marketplaces included |
| **Website** | Skills a site publishes in an [Agent Skills discovery index](https://github.com/cloudflare/agent-skills-discovery-rfc) at `/.well-known/agent-skills/` |
| **Catalog** | A JSON file in the market's own format, by URL or path: a team's curated list, with categories and both languages |

- **Search** filters your sources and, below them, shows what skills.sh found, each with its repository and install count.
- **Sources** lists the sources, each with its kind, skill count and freshness or its error, a switch, and **Refresh** or **Remove** in its menu. **Add a source** takes `owner/repo`, a github.com or skills.sh link, a site's address, or a JSON file's URL or path, and says what it read before anything is fetched. Pasting the same into the search box offers to add it in one click.
- **Preview** shows the `SKILL.md`, its files, license and source, and for a skill skills.sh reviewed, the **Security review** of each reviewer (pass, warning or fail, worst first).
- **Install** writes the skill to the root you choose. Files come from the skill's own repository or site, complete, bounded in size and number, with every path kept inside the skill folder; a site's artifact must match its published SHA-256 digest. The install is recorded, so the market can offer an update, and it says when a local edit would be replaced.

| A preview with its security reviews | Sources |
|---|---|
| ![The preview of a skills.sh skill: its SKILL.md, files, license and five security reviews](../../assets/skills-v0.5.34/en/skills-market-preview.jpg) | ![Sources: the built-in Featured and skills.sh, a team catalog, and Add a source](../../assets/skills-v0.5.34/en/skills-sources.jpg) |

An Agent follows a skill as written, and a skill may carry scripts. Install only what you trust, and read the `SKILL.md` first.

## Self-evolution

Self-evolution is off until you turn it on under [Settings](#settings), or from the empty **Evolution** tab. Then:

1. As each turn ends, the Host records the turn's steps: your messages, the tools it called and whether they failed, and the skills it loaded. Secrets such as tokens and API keys are redacted.
2. The conversation earns a review as it goes: one point a turn, more for longer requests (up to 3), many tool calls (up to 2) and varied tools (up to 2). Once the window reaches the **Review threshold**, the conversation has been idle for **Idle wait** seconds, and at least **Review interval** seconds have passed since its last review, a task Agent reviews it in the background. A new turn postpones the review to the next pause.
3. The review looks for strong signals (corrections, "from now on" instructions, failed tools, a change of approach, a reusable procedure, a skill that was missing or misleading, an approach the user confirmed) and suggests a new skill or an update, citing the steps it rests on. It can propose test cases too. Before choosing a new name, it receives the existing skill catalog and up to 20 recently updated open suggestions, with bounded summaries and rationale. It is instructed to reuse a matching skill or suggestion and retain earlier requirements when combining refinements; matching remains a model judgment, not automatic semantic clustering.
4. Suggestions are admitted only above the **Minimum confidence**. One per skill name and kind stays open: new evidence is appended, and a pending suggestion of equal or higher confidence can replace its summary and rationale; drafting/review wording stays fixed; a dismissed suggestion is not proposed again from the same conversation for a day; each conversation keeps at most **Pending per conversation**; and suggestions expire after **Suggestion expiry** days. An update records the skill's hash and is invalidated if the file changes before it is drafted.
5. **Draft** writes the new `SKILL.md`. With **Backtest drafts** on, the draft and the current version (or no skill, for a new one) run the same cases, at most **Cases per backtest**, and the draft shows the comparison.
6. You adopt, edit, redraft or discard it. Nothing changes a skill without your **Adopt**.

A review that fails is logged under the turn and keeps its window; after three failures in a row, the conversation stops reviewing until DSH recreates its Agent. Reviews, drafts and backtests run as dsh-mnemon task Agents, on the model the **Task Agent model** setting picks; see [Configuration](../reference/configuration.md#background-task-agent-model-route).

## In a conversation

![A turn that used release-notes, with the Turn skills line: release-notes, suggested 1](../../assets/skills-v0.5.34/en/chat-skills.jpg)

A turn that used a skill, or earned a review, ends with a **Turn skills** line. It names the skills the turn used, loaded by the model or called by you as `/name`, then shows **Reviewing** while the review waits or runs, and **suggested** with a count once it has left suggestions. Each skill opens on the Skills page; the suggestions open the suggestion, or the **Pending** list when there are several. The line also shows in a conversation reopened from history, and it is hidden when the turn has nothing to say. Turn it off with **In the conversation**.

## Its own sidebar entry

With **Sidebar entry** on, Skills becomes a sidebar entry of its own, next to the Memory System, and the Memory System leaves its tab out. The page is the same, under its own title; its gear opens its settings, **Back to chat** and **Use** return to the conversation, and the links under a turn open it there.

## Settings

| dsh-mnemon's page under Plugins | Skills' own page |
|---|---|
| ![dsh-mnemon's page under Plugins: Skills in Memory composition, tagged Experimental](../../assets/skills-v0.5.34/en/plugin-skills-row.jpg) | ![Skills' page under Plugins: Self-evolution, Backtest drafts, Review parameters, In the conversation and Sidebar entry](../../assets/skills-v0.5.34/en/plugin-skills.jpg) |

Skills has its own page under **Plugins → dsh-mnemon**, like every component, and its row there carries the **Experimental** tag. Switches apply at once, without reloading the plugin.

| Setting | Default | What it does |
|---|---|---|
| **Self-evolution** | Off | Review conversations and suggest skills. Task and subagent sessions are saved locally; Mnemon does not automatically delete them. |
| **Backtest drafts** | On | Compare each new draft with the current version on its test cases |
| **Review parameters** | — | The thresholds above, folded, applied together with **Apply** |
| **In the conversation** | On | Show the **Turn skills** line under each turn |
| **Sidebar entry** | Off | Show Skills as its own sidebar entry instead of in the Memory System |

The [configuration reference](../reference/configuration.md#skills-settings) lists every key, its range and where it is saved.

## Data and trust

- **Skills stay where DSH reads them.** Edits, installs and adoptions write the skill folders themselves. A deleted or replaced skill goes to the Skills trash first.
- **Skills' own data** lives in the `skills/` folder of the storage root: the ledger of suggestions, drafts and installs, the test cases and runs, the recorded conversations, every skill version, and the market's sources with their cached lists. See the [storage model](../reference/storage-model.md#skills). It is not part of ZIP backups or Git sync.
- **Recorded conversations** keep what a review needs to cite (your messages, tool names, inputs and failures, skill loads) with secrets redacted. The newest 100 are kept; pinned records and those a suggestion or case cites stay longest. You can delete any record.
- **Task and subagent sessions** are saved by DSH in its own session directory (by default `~/.dsh/sessions/`; the actual path depends on DSH configuration), separately from the `skills/` evidence above. A review involves a task Agent and a delegated worker. Disposing those instances, hiding them from the sidebar or deleting Skills evidence does not automatically remove their DSH sessions. Mnemon currently has no session cleanup control or automatic retention period; these sessions are also outside Mnemon ZIP backups and Git sync. Turning **Self-evolution** off stops future automatic reviews without deleting earlier sessions; manual drafts, backtests and other model operations can still create sessions.
- **Model use.** Only self-evolution, drafts, backtests and making cases from evidence call a model, as task Agents. Browsing, editing, switching and installing do not.
- **The market** fetches from GitHub, skills.sh and the sites you add. GitHub allows 60 unauthenticated requests an hour; listing a repository takes one, reused for ten minutes. Set `GITHUB_TOKEN` or `GH_TOKEN` in DSH's environment to raise the limit.

## Troubleshooting

| What you see | What to do |
|---|---|
| **Evolution** stays empty | Check that **Self-evolution** is on. A conversation needs a few turns of real work and a pause before its first review; use **Review this conversation** to review it now. |
| **Review failed** under a turn | The task Agent could not answer; the window is kept for the next try. After three failures, the conversation stops reviewing until DSH recreates its Agent. |
| *GitHub declined to list …* | The hourly limit is spent. Try again later, or set `GITHUB_TOKEN`. A skills.sh preview still shows the skill from its text copy, and says so. |
| *skills.sh is busy* or *can't search right now* | Search again in a moment; your other sources still work. The switch under **Sources** turns skills.sh off. |
| *… publishes no Agent Skills index* | The site has no `/.well-known/agent-skills/index.json` under the address or at its root. |
| A draft says *The backtests cannot be compared* | No case could run on both sides; check the per-case errors, then **Backtest again**. |
