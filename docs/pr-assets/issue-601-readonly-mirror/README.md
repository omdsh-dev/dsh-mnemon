# Issue #601: recover read-only Git mirrors

[中文](./README.zh-CN.md)

Validated on 2026-11-10 against main `e9da7d1d717737defc088ac9afd32c4ca99ff9ef`, Node 24.22.2. All repositories and memory are synthetic temporary fixtures.

`pnpm run verify` passes: 2677 root tests pass, 8 conditional skips; workspace tests, typechecks, builds and package checks pass. The focused command below passes six checks:

```sh
pnpm exec vitest run tests/disposable-directory.spec.ts tests/git-sync.spec.ts tests/sync-config.spec.ts -t 'read-only'
```

Three real-Git scenarios first push local Runtime memory, generate packed objects with `git gc`, mark the packs read-only, then recover after a missing origin marker, partially removed `.git`, or a different remote. A subsequent update publishes successfully; original local memory survives. The different-remote case verifies that the old repository's history is not published to the new remote.

Cleanup also covers missing directories, read-only pack/idx/rev fixtures, and nested or root directory links. External target bytes and permissions stay unchanged. Settings survive clearing a mirror.

Local execution is on macOS. The PR adds this focused suite to both Windows CI Node versions (22.19.0 and 24); see the current CI results for native Windows acceptance. The fallback handles only Windows EPERM/EACCES/ENOTEMPTY/EBUSY, never follows symlinks or junctions, and reports a remaining failure after bounded retries. No storage format or UI changes.
