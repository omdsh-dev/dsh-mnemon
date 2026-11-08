# Windows pnpm CLI discovery acceptance

This change affects command discovery and subprocess launching, with no new UI controls. All CLI fixtures are synthetic and contain no user data, credentials, or live backend calls.

## Regression evidence

With the original `main` launcher/discovery implementations and the final regression tests, 21 tests failed and 61 passed. With this change, all 82 tests pass. Cases cover pnpm versioned global directories, package junctions, absolute targets, standard global bin fallbacks, literal query/curate arguments, rejection of unrelated targets and native Mnemon process ownership. Matching native commands remain direct children, while the npm updater still uses its verified JavaScript entry.

```sh
pnpm exec vitest run plugins/dsh-mnemon-provider-byterover/tests/windows-cli.spec.ts plugins/dsh-mnemon-source-memory-spaces/tests/npm-native-cli.spec.ts plugins/dsh-mnemon-source-memory-spaces/tests/runner.spec.ts
pnpm run verify
```

Full local verification on macOS / Node 24.22.2 passed, including 2,625 root tests (8 existing conditional skips), all workspace checks and package/headless validation. The final ByteRover package verification also passes all 38 tests; explicit executable names retain their original process resolution. Local tests simulate Windows discovery while executing real Node child processes; they do not claim a manual Windows Desktop session.

## Windows acceptance

Both Windows CI jobs (Node 22.19.0 and 24) run the regression suite and:

```sh
pnpm run verify:windows-pnpm
```

That command uses the actual CI pnpm to pack and install two synthetic CLI packages into isolated global bin/store directories. It removes the global bin from the simulated Desktop PATH and verifies that both commands are found through PNPM_HOME and run through their real package entries, preserving the complete argument array, working directory and Electron-as-Node environment. It does not install or authenticate the real Mnemon or ByteRover services. The CI result is linked in the PR.

中文：本轮没有新增界面，验证针对 Windows 命令发现与真实子进程启动。回归测试使用合成数据；原实现有 21 项失败，修复后 82 项全部通过。本地完整验证通过；Windows CI 还用真实 pnpm 全局安装合成 CLI，验证 PATH 缺少新全局目录时的发现、包入口与参数传递。未使用真实账号或付费模型，也未声称完成真实 Windows Desktop 的手工操作验收。
