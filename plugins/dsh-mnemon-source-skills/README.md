# dsh-mnemon-source-skills

The Skills Source of [dsh-mnemon](https://github.com/omdsh-dev/dsh-mnemon), experimental: one place for the DSH skills a workspace can load, the data their self-evolution keeps, their tests, and a market of more skills.

- **Skills.** Every `SKILL.md` in `<project>/.dsh/skills`, `<project>/.agents/skills`, `~/.dsh/skills` and `~/.agents/skills`, read with DSH's own rules and precedence. Switch a skill off for the model or the `/` menu (DSH's `disable-model-invocation` and `user-invocable` keys), use it in the conversation, edit it, restore an earlier version, or move it to the trash. Every write is fenced by the file's hash and leaves a version.
- **Evolution.** With self-evolution on, the dsh-mnemon Host records each conversation's steps as turns end and reviews it in the background once it has earned it. A suggestion names the steps it rests on; a task Agent drafts the new `SKILL.md`, which is backtested against the current version before you adopt it. This Source admits suggestions by confidence, dismissal, expiry and per-conversation limits, and keeps the ledger.
- **Evidence.** The conversations reviews read, as numbered steps with the review's notes and secrets redacted; pin them, delete them, or make test cases from chosen steps.
- **Evals.** Each skill's cases, from reviews, evidence or by hand, and its backtest runs. A backtest is a simulation: an executor follows the skill without tools, and a judge grades each check. Mark cases that require image input as `requiresVision`; the supporting Host records them as **Not measured**, without model calls or scores, and excludes them from baseline comparisons.
- **Market.** Skills from sources: a featured catalog shipped in `market/official.json` and refreshed from the repository; skills.sh, the open index the `skills` CLI searches, queried as the user types; any GitHub repository (every `SKILL.md` in it, plugin marketplaces included); any site publishing an [Agent Skills discovery index](https://github.com/cloudflare/agent-skills-discovery-rfc) at `/.well-known/agent-skills/` (digests checked, `.tar.gz` and `.zip` artifacts unpacked safely); and catalogs in the format below. Installing previews the skill, fetches its whole folder from its upstream, checks it against DSH's rules and records where it came from, so an update can be offered.

The Source never calls a model and never joins a model View; skills reach the model through DSH's own `skill` tool. The Memory System shows it as the **Skills** page, which can also become a sidebar entry of its own. The [Skills guide](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/guides/skills.md) ([中文](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/zh-CN/guides/skills.md)) walks through the page.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `dataDir` | the Host's storage root | Where `skills/` (ledger, evals, trajectories, versions, market, trash) is kept |
| `dshHome` | `$DSH_HOME`, then `~/.dsh` | DSH's home; its `skills` folder is read |
| `agentsHome` | `$DSH_AGENTS_HOME`, then `~/.agents` | The shared agents home; its `skills` folder is read |

Self-evolution, its review parameters, the line under each turn and the sidebar entry are dsh-mnemon settings, under `skills` in its configuration, edited on this component's page under **Plugins → dsh-mnemon**; see [Skills settings](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/reference/configuration.md#skills-settings). The Host passes the admission rules with each review, so this Source keeps no settings of its own.

## A catalog

A team can publish its own curated list as one JSON file, by URL or path:

```json
{
  "version": 1,
  "id": "team",
  "name": { "en": "Team skills", "zh-CN": "团队技能" },
  "categories": [{ "id": "docs-writing", "label": { "en": "Writing", "zh-CN": "文档写作" } }],
  "skills": [{
    "name": "release-notes",
    "title": { "en": "Release notes" },
    "description": { "en": "…", "zh-CN": "…" },
    "category": "docs-writing", "author": "…", "license": "MIT", "version": "1.0.0",
    "source": { "type": "github", "repo": "org/repo", "path": "skills/release-notes", "ref": "main" }
  }]
}
```

A source is a GitHub folder, a URL to one `SKILL.md`, or a folder relative to a local catalog file. Entries that cannot be installed are left out when the catalog is read.

## Storage files

Under the storage root, `skills/` holds `ledger.json` (suggestions, drafts, reviews, versions and installs), `evals.json` (cases and runs), `trajectories/` (recorded conversations), `versions/` (earlier `SKILL.md` files), `market/` (added sources and their cached lists) and `trash/`. It is written under the storage lock with atomic replacement and is not part of a Mnemon Pack. See the [storage model](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/reference/storage-model.md#skills).

`requiresVision` is optional; omitting it while editing preserves the existing marker, and explicit `false` clears it. Unmeasured results keep the ungraded `error` verdict plus `unmeasuredReason: 'requires-vision'` so older score readers exclude them too. Existing records need no migration. Upgrade the Host together with this Source; before downgrading the Host, disable image-dependent cases because older executors do not read the marker. Historical runs are not rewritten.

## Trash management

The scoped management API exposes `trash-list` (`trash` is an alias), `trash-restore-preview`, `trash-restore`, `trash-purge` and `trash-empty`. Restore inputs use an entry `id`, an optional selected `root` and `name`; replacement also requires `replace: true` and the current conflict's `expectedHash` from the preview. Mutations retain the Source's confirmation and revision checks. Optional sidecars record the original project and path; legacy entries require an explicit destination when their origin is unknown.

## Source-owned UI and tests

The optional `./client` entry is an ordinary DSH Client plugin. This package owns its pages and `presentation/` resources and uses `dsh-mnemon/client` for the shared frame and scoped management client. It never receives a Host Context, credentials or another Source's controller.

From a source checkout, install the declared dependencies and run `pnpm verify` to check the Source's behavior, the market's parsers and archive reader, and Source-backed page interactions.

[Plugin development](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/development/extensions.md) · [中文指南](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/zh-CN/development/extensions.md)
