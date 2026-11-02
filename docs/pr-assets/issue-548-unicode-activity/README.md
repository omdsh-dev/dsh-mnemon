# Issue #548: Unicode-safe memory activity

[简体中文](./README.zh-CN.md) | **English**

The reproducer starts from main `a4ad2d6955172b936ff9328f39cc5873c3ec9c55`.
All memory, requests, and sessions are synthetic, under temporary directories.
No personal Desktop profile or remote model service is used.

## Reproduction and result

`mnemon_runtime_memory` receives 158 ASCII characters, `\u{1F600}`, and a suffix.
Before this change, the activity title consists of those 158 characters,
the unpaired high surrogate `\uD83D`, and an ellipsis. `JSON.stringify` escapes
the invalid surrogate; it does not repair it. A strict Unicode request decoder
can reject this escaped string, as reported in [#548](https://github.com/omdsh-dev/dsh-mnemon/issues/548).

Activity summaries now reuse the existing SDK truncation helper. At this
boundary, the entire supplementary character is omitted before the ellipsis;
complete code points that fit are retained. UTF-16 length limits, whitespace
normalization, receipts, and original memory content stay unchanged.
The same helper covers read/write titles, excerpts, IDs and View references.

## Regression evidence

```sh
pnpm exec vitest run tests/activity.spec.ts tests/source-tool-lifecycle-host.spec.ts
```

- Before the fix: 8 failing regressions, 17 passing cases.
- After the fix: 25 passing cases, including 12 new cases.
- Real published DSH Host execution covers Runtime add and replace, the next
  model step, a second turn, and a JSONL write/read round trip. Decoded persisted
  strings are checked for well-formed UTF-16, not merely successful JSON parsing.
- Runtime snapshots retain the complete original content, including the
  supplementary character. Read summaries, generic View writes, BMP text,
  exact-limit strings and fully fitting surrogate pairs are also covered.

## Full verification

On macOS with Node 22.22.0, `pnpm run verify` passed: 2,399 root tests
and 745 component tests, with 7 and 3 existing conditional skips respectively.
Type checks, documentation checks, deterministic builds, the real isolated
Headless profile, public imports, package contents, publint and attw passed.
The installed-DSH root suite also passed on `0.2.1-rc.5` (2,399 passed / 7 skipped)
and `0.2.0-rc.2` (2,396 passed / 10 skipped).

The initial old-host run hit 27 UI suite collection errors because its temporary
path used the macOS `/tmp` alias while module importers used `/private/tmp`,
preventing the existing test resolver's dependency fallback. Rerunning with the
canonical Host path passed the full suite without a code or dependency change.
The independent reviewer reran the 25 targeted tests and found no required fixes.

## Boundaries

This fixes newly generated Mnemon activity metadata. It does not rewrite old
session history or sanitize arbitrary malformed strings supplied by another
plugin. Existing affected conversations need separate recovery; after updating
and restarting DSH, a new conversation can use the same retained memory.
The local model adapter is scripted: no live DeepSeek account request or the
reporter's Windows desktop installation was exercised. No HTTP 200 claim is
made for an external service. The display limit protects Unicode code points,
not entire multi-code-point grapheme clusters.
