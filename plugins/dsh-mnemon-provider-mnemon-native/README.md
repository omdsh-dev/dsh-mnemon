# dsh-mnemon-provider-mnemon-native

The default local Mnemon CLI backend: exact writes, typed relationships, recall and soft deletion.

Install the `mnemon` CLI separately and ensure the DSH Host can resolve it. The npm package contains the driver, not the binary.

## Use

The default `dsh-mnemon` Starter already installs this package. Native is the default backend.

For a custom composition, install this package alongside `dsh-mnemon-source-memory-spaces` and include it in that Source's `config.providers`:

```yaml
providers:
  - use: dsh-mnemon-provider-mnemon-native
    instanceId: mnemon-native
```

This is a **Memory Spaces child module**, not a top-level Source or a complete Strategy. It registers through `dsh-mnemon-source-memory-spaces/provider-sdk`; each parent Source owns its child Fibers, connection settings and lifetime. Credentials stay on the Host.

[Provider setup and capability matrix](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/guides/memory-providers.md) · [中文指南](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/zh-CN/guides/memory-providers.md)

## Develop independently

From a source checkout with the declared dependencies installed, run `pnpm verify`. Tests, build and public exports belong to this package, without importing another package's controllers or repository configuration. Use the Source's public `/testing` fixtures for child registration and driver conformance; live service tests require a separately authorized environment.

[Plugin author guide](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/development/extensions.md)
