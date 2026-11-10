# Issue #602: keep idle-review admission inside a real step

[中文](./README.zh-CN.md)

Validated on 2026-11-10, based on main `e9da7d1d717737defc088ac9afd32c4ca99ff9ef`. All inputs are synthetic; no credentials or user sessions are used.

The awaited `agent/request` hook executes at most one guarded admission challenge per turn and policy. `agent/turn-stopping` consumes that result without executing parent tools after `step/end`. No synthetic turn or step boundaries are appended.

| Check | Result |
| --- | --- |
| New regressions against unchanged main production files | 5 fail, 1 passes, 159 outside the selection |
| `pnpm run verify`, published development Host 0.2.1-rc.5 | Pass; root tests 2678 pass, 8 conditional skips; workspace tests, typecheck, builds and package contracts pass |
| Published DSH 0.2.2-rc.1, focused Host/lifecycle/session-repair tests | 294 pass |
| Published Auto review plugin, native and PTC tool modes | After two admission turns, switching to Auto still permits two subsequent foreground tool calls |
| Plain and compressed v4 history recovery | Only strictly paired out-of-step idle probes are converted in a new copy; the original and valid in-step probes remain unchanged |

Commands:

```sh
pnpm run verify
DSH_HOST_ROOT=<published-rc1-install>/node_modules/@deepseek-ai/dsh   pnpm exec vitest run --config scripts/installed-dsh.config.ts   tests/idle-review-tool-access-host.spec.ts tests/lifecycle.spec.ts   tests/legacy-session-repair.spec.ts tests/plugin.spec.ts
```

The real Host tools and published Auto reviewer run in-process; the model and reviewer risk response are scripted to avoid network calls. Auto may still refuse a background admission probe because it has no model-authored root call. This fix does not bypass that policy: it prevents the refusal from corrupting later foreground tool review. Existing damaged histories require the documented preview-and-copy recovery command; no live session is rewritten automatically. This is a Host lifecycle change, with no UI layout changes.
