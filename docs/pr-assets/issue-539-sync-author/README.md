# Git sync author identity: issue #539

[简体中文](./README.zh-CN.md) | [Issue #539](https://github.com/omdsh-dev/dsh-mnemon/issues/539)

Tested on 2026-11-02 with Node 22.22.0, pnpm 10.13.1 and Apple Git 2.39.5. Base: `a4ad2d6955172b936ff9328f39cc5873c3ec9c55` (v0.5.38). Candidate source SHA-256: `4ac6b4ee6e438733fa33b9075e70ae2428279eff7f7007f7032901a99e065f30` for `src/host/git-sync.ts`; regression SHA-256: `511e248ee0d16085769e8a2b865a09ec030097d94f35921af56fee1ca2e1bf0a` for `tests/git-sync.spec.ts`.

The reusable [real-Git regression suite](../../../tests/git-sync.spec.ts) creates disposable bare remotes, source stores and global Git config files. Its executable `pre-receive` hook accepts only the synthetic identity `Corporate User <employee@company.example>` and checks every new commit. No personal Git configuration, sync directory, account or network remote is used.

```sh
pnpm exec vitest run tests/git-sync.spec.ts -t '#539'
pnpm exec vitest run tests/git-sync.spec.ts tests/sync-config.spec.ts tests/client-memory-enhancements.spec.tsx tests/client-sync.spec.tsx
pnpm run verify
```

| Check | Before | After |
|---|---|---|
| Fresh settings with configured global identity | Hook rejected placeholder | Approved author and committer; push succeeds |
| v0.5.38 saved default pair with configured identity | Hook rejected placeholder | Approved author and committer; push succeeds |
| Mirror-local, relative include, conditional include and worktree config | Four placeholder commits | Four commits use `Mirror User <mirror@example.com>` |
| Explicit author despite Git config and inherited author variables | Environment author replaced explicit choice | Explicit `dsh-mnemon sync <approved@example.com>` retained |
| Previously rejected commit; remote empty | Retry still rejected | One approved root commit; local memory retained |
| Previously rejected commit; remote has published history | Retry still rejected | Approved child of the exact published parent; local memory retained |

The nine new regressions failed against the unchanged base implementation, then all nine passed after the fix. The related four test files passed 140 tests. The existing no-identity fallback, blank-author, remote-race and read-only configuration paths also pass. The advanced-settings render test first failed on the old promise to always use the placeholder and now passes with the Git-first help text.

Complete `pnpm run verify` passed: 2,396 root tests / 7 opt-in skips and 745 component tests / 3 opt-in skips, type checks, deterministic builds, isolated Headless activation and package validation. The first complete run stopped at the reviewed bilingual-copy fingerprint; restoring only the two old help strings reproduced the old hashes. Updating those two hashes (1,399 keys per locale, unchanged) resolved that failure, and the complete command then exited 0. No suite was omitted from the successful rerun.

Minimal observed rejection on the base, with the temporary remote path removed:

```text
committed: true
pushed: false
the commit stays local because no token is available:
remote: Commit author rejected by policy: dsh-mnemon sync <mnemon@localhost>
error: failed to push some refs to '<temporary bare remote>'
```

With the fix, the remote-policy result keeps the hook detail and points to `Sync > Advanced` without blaming an absent token. After configuring the accepted Git identity, a normal sync returns `committed: true, pushed: true`. For the existing-history case, `git rev-list --count mnemon-sync` is `2`, and `git rev-parse mnemon-sync^` equals the original published commit. No force-push or history-amend operation is added.

The exact old placeholder pair is the existing Default choice and now follows Git; other explicit pairs, including a pair with only one placeholder field, remain explicit. Identity resolution writes neither sync settings nor Git config. Retrying reconstructs the disposable mirror from the remote and current source storage; manual mirror-only edits are not preserved. The [operations guide](../../en/guides/operations.md#git-repository-sync) includes recovery and rollback steps.

This verifies local Git policy hooks and identity precedence, not a live corporate GitLab account, HTTPS credentials, every possible server policy or Windows execution. Existing upstream source-map and Node SQLite experimental warnings were visible during the focused run.
