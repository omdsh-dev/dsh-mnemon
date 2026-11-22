# Contributing

[简体中文](./CONTRIBUTING.zh-CN.md) | **English**

Thank you for contributing to dsh-mnemon. This document defines the Issue, Pull Request, verification, and maintenance rules. See the [Development and Verification Guide](./docs/en/development/README.md) for implementation details and test scenarios.

All repository conventions live in standard open-source documentation (`CONTRIBUTING.md`, `ISSUE_TRIAGE.md`, `.github/` templates, and `docs/`) and are enforced by automated CI checks rather than separate tool-specific instruction files (such as `AGENT.md`). Human contributors and coding tools follow the same single source of truth.

## Pull Request scope

The repository accepts these external Pull Requests:

- **Fixes**: reproducible bugs, compatibility problems, and security hardening;
- **Enhancements and optimization**: improvements to existing capabilities, performance, stability, and user experience;
- **Maintenance**: tests, build work, refactors, and dependency compatibility.

New capabilities, Providers, persistence formats, RPC authority, or security-boundary changes require an Issue and maintainer approval before implementation begins.

Documentation-only PRs from external contributors are not accepted directly. Open an Issue first so maintainers can confirm the scope. Maintainer release notes, bilingual synchronization, and documentation maintenance are exempt.

## Prerequisites

- Node.js `^22.19.0 || >=24.11.0` for the pinned DSH development profile and build tooling (published entries still import on Node 20); CI covers Node.js 22.19 plus 24 with pnpm 10.13.1;
- use only published `@deepseek-ai/*` NPM contracts; do not modify DSH source or point tsconfig at a DSH source checkout;
- do not commit tokens, credentials, private memory, sensitive paths, or unredacted logs in repository configuration, fixtures, screenshots, or PR descriptions;
- `lib/` is generated build output and must not be committed or edited manually.

## Quick start

```sh
git clone https://github.com/omdsh-dev/dsh-mnemon.git
cd dsh-mnemon
pnpm install
pnpm run verify
```

`verify` runs TypeScript checks, Vitest, reproducible double builds, isolated real Headless-profile activation, and published-package validation.

## Commit convention

Commit messages and PR titles use Conventional Commits:

```text
type(scope): subject
```

Allowed types are `feat`, `fix`, `chore`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, and `revert`. Use a module or topic for the scope, for example:

```text
fix(version): run pnpm update inside the owning profile
fix(client): honor trusted remote management grant
```

Code, comments, documentation, commit messages, and PR titles must not contain emoji.

## Checklist before opening a PR

1. **Use the latest main**: rebase onto or merge the latest `main`, resolve conflicts, and rerun verification before submitting.
2. **Run complete verification**: run `pnpm run verify` by default. If a check cannot run, document the reason, alternative evidence, and remaining risk in the PR.
3. **Add targeted regression coverage**: bugs need a test that fails before the fix and passes afterward. UI behavior must cover both authorized and rejected paths.
4. **Keep review evidence focused**: include screenshots or a short recording when they help reviewers assess a material WebUI change. A before/after comparison or the key new state is usually enough. Attach media to the PR on GitHub, or use `node scripts/upload-pr-evidence.mjs` to upload redacted evidence to `mnemon-dev/assets` with links pinned to a full commit SHA. Keep review binaries out of `main`. Put release acceptance bundles in GitHub Releases or CI artifacts. For Host, CLI, or Headless changes, include redacted logs or command results.
5. **Keep both languages synchronized**: long-lived documents under `docs/en/` and `docs/zh-CN/` must have matching names and responsibilities. Keep `README.md`, `README.zh-CN.md`, `CHANGELOG.md`, and `CHANGELOG.zh-CN.md` synchronized. Product media belongs under semantic folders in `docs/assets/` with zero unreferenced files.
6. **Write concise, self-documenting code**: prefer clear module structure, crisp naming, small pure helpers, and executable regression tests over narrative comments. Avoid both overly verbose identifiers and cryptic placeholder names (such as `x1`, `tmp`, or `bar`), remove dead code and unused bindings (`tsc --noUnusedLocals --noUnusedParameters`), and keep only machine directives (such as shebangs, `@ts-expect-error`, `@vitest-environment`, and `@deprecated`).
7. **Validate once at the trust boundary**: enforce input, path, permission, and integrity checks once at external boundaries (CLI/RPC entrypoints, disk reads, external HTTP/Provider responses, and release workflow entrypoints), then trust established types and invariants internally. Do not stack redundant hashing, repeated re-validation, or extra subprocess checks inside internal helpers for contrived call paths that bypass upstream gates.
8. **Explain security and data effects**: changes to persistence formats, paths, RPC authority, Provider credentials, or import/export must explain compatibility, migration or rejection, rollback, and data retention.
9. **Keep boundaries stable**: `src/host/protocol.ts` is the browser-safe source of Client and Host wire DTOs. Do not import executable Host modules into browser code.
10. **Disclose AI coding**: complete the PR template with the model and coding tool used. Contributors remain responsible for the final code, verification, and security.
11. **Do not commit generated output**: ensure the worktree contains no `lib/` output or temporary Provider-lab data.

## Documentation and persistence constraints

- When user-visible behavior changes, review the English and Chinese versions of `installation.md`, `getting-started.md`, `ui-guide.md`, `configuration.md`, `operations.md`, and `compatibility.md`, which states the supported DSH releases;
- commands, configuration keys, paths, and code symbols must match across both languages;
- Runtime, Documents, and Memory Space registry format changes must not happen silently; include legacy-format handling and damaged-input tests;
- do not send user preferences into long-term Memory Spaces or use real private data in fixtures and documentation examples.

## Issue rules

- Search open and closed Issues before submitting;
- use the bilingual [Bug report form](.github/ISSUE_TEMPLATE/bug_report.yml) for bugs, describing the symptom, expected outcome, reproduction steps and environment. Evidence may be plain text, JSON or another code block anywhere in the report; separate evidence, smoke tests, code references and patch proposals are optional;
- use the bilingual [standard Issue form](.github/ISSUE_TEMPLATE/standard_issue.yml) for features, enhancements, documentation, and questions;
- CLI/API submissions may use the same section headings; the bot adds `bug` when the report type is “Bug 报告 / Bug report”, so reporters do not need label permissions;
- template checks request missing basic information without closing the Issue. Edit the original body to supply details; the bot updates its existing reminder. Maintainers decide whether further investigation or closure is appropriate;
- see [Issue Triage](./ISSUE_TRIAGE.md) or [Issue 分类标准](./ISSUE_TRIAGE.zh-CN.md) for labels, classification, and closure criteria;
- report security vulnerabilities privately through [SECURITY.md](./SECURITY.md), not in a public Issue.

## Pull Request rules

- Keep each PR focused on one cohesive concern with clean file boundaries, and add a `.changeset/*.md` entry whenever published package inputs change (`node scripts/check-release-intent.mjs`);
- keep the bilingual [PR template](.github/pull_request_template.md) intact and complete its summary, context, affected areas, type, latest-code confirmation, AI disclosure, compatibility and data safety, local validation, and user-visible evidence;
- CI and PR policy checks must pass. Correct the description or implementation when a check fails; do not remove template sections;
- PRs superseded by a more complete solution, based on an obsolete design, or unable to upgrade safely will be closed with an explanation;
- reviews use the current `main`, public contracts, and released behavior as the source of truth, not only the PR description.
