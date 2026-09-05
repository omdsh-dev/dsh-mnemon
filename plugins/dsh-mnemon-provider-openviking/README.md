# dsh-mnemon-provider-openviking

An adapter for an existing OpenViking HTTP service and its filesystem-shaped memory resources.

Requires a reachable OpenViking endpoint and configured resource scope. Extraction can be asynchronous; acceptance is not durable completion.

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

[Plugin author guide](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/development/extensions.md)
