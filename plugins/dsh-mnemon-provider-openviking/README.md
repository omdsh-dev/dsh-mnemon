# dsh-mnemon-provider-openviking

An adapter for an existing OpenViking HTTP service and its filesystem-shaped memory resources.

Requires a reachable OpenViking endpoint supporting `POST /api/v1/content/write` with `mode: "create"`, `wait: true`, and tags. Agent-authored memories use unique Markdown files; the adapter verifies completed indexing and exact full-content readback before returning `stored` with a reversible `id`. It does not create extraction sessions.

The supported scope is `viking://user/<user>/memories`. Existing `viking://user/memories` settings resolve through the configured user or authenticated `/api/v1/system/status` identity, without rewriting the local registry. A failed response, timeout, or mismatched readback produces an error instead of a committed receipt. The error includes the requested URI because remote content may remain; inspect it before retrying. Existing memories remain readable, and downgrading does not remove files written by this adapter.

## Use

The default `dsh-mnemon` Starter already installs this package. Enable and configure the service in **Settings → Memory System**, then inspect its synchronized Memory Spaces.

For a custom composition, install this package alongside `dsh-mnemon-source-memory-spaces` and include it in that Source's `config.providers`:

```yaml
providers:
  - use: dsh-mnemon-provider-openviking
    instanceId: openviking
```

This is a **Memory Spaces child module**, not a top-level Source or a complete Strategy. It registers through `dsh-mnemon-source-memory-spaces/provider-sdk`; each parent Source owns its child Fibers, connection settings and lifetime. Credentials stay on the Host.

[Provider setup and capability matrix](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/guides/memory-providers.md) · [中文指南](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/zh-CN/guides/memory-providers.md)

## Develop independently

From a source checkout with the declared dependencies installed, run `pnpm verify`. Tests, build and public exports belong to this package, without importing another package's controllers or repository configuration. Use the Source's public `/testing` fixtures for child registration and driver conformance; live service tests require a separately authorized environment.

To test a disposable local OpenViking service (never a personal store), run `MNEMON_OPENVIKING_TEST_ENDPOINT=http://127.0.0.1:1933 pnpm exec vitest run tests/integration.spec.ts`. Supply `MNEMON_OPENVIKING_TEST_API_KEY` when the service requires authentication. It creates one synthetic canary in the default user's namespace, reads/searches/browses it, and deletes its exact URI. Ordinary verification skips this optional integration test. On v0.4.20, UI discovery additionally requires an explicit account and an account-admin key; ROOT keys cannot access tenant data.

[Plugin author guide](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/development/extensions.md)
