# dsh-mnemon-provider-openviking

Filesystem-shaped shared memory with tiered reads and automatic semantic extraction.

This is a Memory Spaces **child module**, not a top-level Mnemon contribution. Its manifest, descriptor, driver, build and tests live here. It uses only the public dsh-mnemon-source-memory-spaces/provider-sdk entry.

Install alongside the Memory Spaces Source, then list { use: 'dsh-mnemon-provider-openviking', instanceId: 'openviking' } in that Source's providers. Multiple Source instances own independent children. Connection settings remain Source-owned; secret fields are never projected to the LLM.

Run pnpm install && pnpm verify from this directory. No root test config or private controller is required.
