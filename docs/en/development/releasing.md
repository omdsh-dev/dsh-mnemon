# Releasing independent packages

[简体中文](../../zh-CN/development/releasing.md) | **English** | [Development and verification](./README.md)

Use a release PR; do not publish directly from a feature branch. README and other files shipped in npm artifacts also require release intent. Site-only documentation and historical evidence do not change package versions.

```text
Change + changeset → reviewed PR → release-version PR → main revision
→ verify and pack changed packages → npm-release Environment approval
→ publish changed dependency layers → install the full pinned combination
→ publish Starter → Registry upgrade smoke → GitHub Release
```

Official packages use independent versions. The `dsh-mnemon` Starter is a tested bill of materials: it pins every included plugin exactly, while plugin peer dependencies describe compatibility across the current minor line. A plugin version advances only when its own artifact or published metadata changes; the Starter advances whenever that pinned composition changes. Packages that are only reverse-dependency test targets are not republished.

Add a release intent with `pnpm changeset` to every pull request that changes a published artifact, and select only the packages whose own artifact or published metadata changes. Test-only, documentation-site and CI-only changes need none; they may add an empty changeset when an explicit no-release record helps review. `pnpm release:status` previews the resulting package bumps, while the existing source CI job compares the PR with its exact base revision and rejects any changed published package missing from the new changesets. A pull request that adds a package includes a release intent for it too; the package first publishes with the next release pull request, at the version that intent produces. A dedicated release pull request runs `pnpm release:version`, which applies all intents, synchronizes the exact Starter and external-fixture pins, updates generated Provider version declarations, and refreshes the lockfile. Workspace peer and development relationships use compatible minor-line ranges so an unchanged package's manifest remains unchanged. When a changed plugin starts using a Starter SDK export added in the same release, the release pull request also raises that plugin's `dsh-mnemon` peer floor to the new Starter version. `pnpm release:check` is read-only and validates the complete mixed-version composition, compatible internal ranges, exact Starter pins, repository metadata, and each package's npm channel.

## The release pull request

Besides the version bump, the release pull request writes the release's notes, updates the pages that name the newest version, and adds its acceptance record:

- `.github/release-notes/vX.Y.Z.md`, the GitHub Release body, with both languages in one file and links pinned to the release tag. The publication workflow reads it from the frozen revision and stops if it is missing.
- `docs/en/releases/vX.Y.Z.md` and `docs/zh-CN/releases/vX.Y.Z.md`, the release notes, each with a line in its releases index, and the release in **What is new** on the English and Chinese [Documentation](../README.md) pages.
- The release-day example under **Common problems** in `docs/en/guides/installation.md` and `docs/zh-CN/guides/installation.md`, which names the new version (`dsh-mnemon@X.Y.Z`).
- `docs/pr-assets/release-vX.Y.Z/`, the acceptance record: `README.md` and `README.zh-CN.md` with the date and the hosts, the candidate packages installed through **Add plugin** on a fresh host of each supported DSH release and updated from the previous release, the checks that passed, screenshots of the steps, and a `validation.json` with the package digests and results, plus a row at the top of the [evidence index](../../pr-assets/README.md).

The release pull request also compares the measured package size with the ceiling in `scripts/verify-package-contents.mjs` and raises it once the package comes within about 10% of it.

## Publication

The manually dispatched npm workflow accepts a full commit SHA that must already equal `main`. It derives the preceding release revision from Git history and selects only packages whose versions advanced. Before requesting any npm credential, it runs the complete workspace and independent-plugin suites, then packs the selected plugins plus the Starter once and records the full composition, both revisions, byte sizes, and SHA-512 integrity. The protected `npm-release` Environment gates Registry writes. After approval, changed plugins publish concurrently within dependency-safe layers; every layer becomes readable before its dependents continue. The workflow installs the complete mixed-version composition through the frozen local Starter, publishes the Starter last, verifies a clean Registry install, and runs the real Registry upgrade before creating the GitHub Release.

Interrupted runs are resumable: an existing selected version is reused only when its Registry integrity exactly matches the frozen tarball. A different artifact at the same version stops the release. Stable packages use `latest`; prereleases use their explicit `alpha`, `beta`, or `rc` channel. Unchanged packages must already exist on the Registry and are verified through the complete Starter install, but they are neither packed nor published again.

npm publication is not transactional. On failure, preserve the frozen artifacts and rerun the same revision; the integrity checks safely skip matching packages and continue missing ones. Never overwrite or unpublish an immutable version. A release is complete only after the new Starter and every version in its pinned composition are installable. Development verification never creates a Git tag, GitHub Release or npm publication.

Independent-plugin verification bounds package concurrency with `MNEMON_PLUGIN_VERIFY_CONCURRENCY` (four by default). The CI and publication workflows set it to two so filesystem/UI suites contend less for runner resources within the existing 180-second command deadline. Each package's Vitest command uses one worker inside that outer pool, avoiding nested worker multiplication on CI runners. All test files, assertions and their existing timeouts remain in effect; standalone type checks and builds still use each package's own commands.
