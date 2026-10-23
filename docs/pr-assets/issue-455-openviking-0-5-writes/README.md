# Storing memories on OpenViking 0.5.1 and later — issue #455

[简体中文](./README.zh-CN.md) | [Issue #455](https://github.com/omdsh-dev/dsh-mnemon/issues/455) | [Verification record](./verification.json)

Issue #455 reports that after an upgrade to OpenViking 0.5.1.1, every write to an OpenViking Memory Space fails with
`body.timeout: Extra inputs are not permitted`, while the server's own MCP `write` tool stores the same path.

Baseline: main `a7e3bc54`. The runs took place on 2026-10-23 (Asia/Shanghai). Environment:

- macOS arm64 with Node 24.19.0 and pnpm 10.13.1;
- OpenViking 0.5.1.1 from PyPI on Python 3.12.13, in dev auth mode on loopback;
- OpenViking v0.4.21 from its Docker image, with API-key authentication on loopback.

Both servers used `text-embedding-ada-002` embeddings (1,536 dimensions). All memories were synthetic.

## Cause

Two changes in OpenViking 0.5.1 meet the provider's write:

1. **The `timeout` field was removed.** `WriteContentRequest` has refused undeclared fields in every
   release since 0.4.16, and 0.5.1 removed `timeout` from it. The provider sent
   `uri, content, mode, wait, timeout`, so every write was refused with HTTP 400.
2. **`written_bytes` counts more than the text.** 0.5.1 appends a reserved `MEMORY_FIELDS` trailer to
   each memory file and counts the trailer in the reply. The public read still returns the text
   alone. The provider required `written_bytes` to equal the text's UTF-8 length, so a write that
   sent only the declared fields still came back "not verified": a 26-byte text was reported as
   69 bytes, of which 43 were the trailer.

| Release | Write fields declared | `written_bytes` counts |
|---|---|---|
| 0.4.16 | `uri content mode wait timeout telemetry processing_mode` | the text |
| 0.4.21 | the same plus `tags tag_mode` | the text |
| 0.5.0 | the same plus `acl` | the text |
| 0.5.1.1, 0.5.2 | without `timeout`; 0.5.2 adds `edit_source` | the text plus the `MEMORY_FIELDS` trailer |

## Fix

- The write sends `uri, content, mode: "create", wait: true`, the four fields every release from
  0.4.16 to 0.5.2 declares. The request's own deadline (`requestTimeoutMs`) bounds the wait, as it
  did before. On 0.4.x, a server that omits `timeout` waits until indexing finishes, as 0.5.x always
  does. A deadline that passes still returns no committed receipt, and the error names the URI to
  inspect.
- `written_bytes` must be at least the text's length rather than exactly equal to it. Fewer bytes
  are still a short write. The exact readback that follows must still return the requested text, so
  any normalization or truncation is refused as before.

## Results

The plugin's opt-in loopback integration test creates a 137-byte bilingual memory and reads it back
exactly. It then finds the memory by search and by browsing, deletes it, and confirms it is gone.

| OpenViking | main | `timeout` removed only | Fix |
|---|---|---|---|
| 0.5.1.1 | fails: `OpenViking refused the write … body.timeout: Extra inputs are not permitted` | fails: `content API did not confirm this exact memory and completed indexing` | passes: stored, `vectorStatus: complete`, `tagsApplied: true`, deleted |
| 0.4.21 | passes | — | passes |

The middle column is the change the issue proposes on its own; the trailer is why it is not enough.

The provider's unit tests now check both server generations:

- a strict server modeled on each release's declared fields: 0.4.16, and 0.5.1.1 with its reply,
  including the trailer bytes and its `queue_status` and `overview_status`;
- a byte count with the trailer, which passes only with an exact readback;
- the configured timeout still bounding the request, with no `timeout` in the body.

On main, four of these fail; with the fix, all 85 pass.

## Automated checks

```text
pnpm --filter dsh-mnemon-provider-openviking exec vitest run     # 85 passed, 1 skipped (integration needs an endpoint)
MNEMON_OPENVIKING_TEST_ENDPOINT=http://127.0.0.1:<port> \
  pnpm --filter dsh-mnemon-provider-openviking exec vitest run tests/integration.spec.ts   # passes on 0.5.1.1 and 0.4.21
node scripts/verify-docs.mjs
```

## Limits

No WebUI recording was made. The interface is unchanged, and the Host reaches the provider through
the same `remember` call the integration test makes. OpenViking 0.5.2 was checked from its source
(`WriteContentRequest` declares the same four fields) but was not run.
