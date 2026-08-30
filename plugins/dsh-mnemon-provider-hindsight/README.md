# dsh-mnemon-provider-hindsight

Knowledge-graph memory with entity resolution, observations, multi-strategy recall, and reflection.

This is a Memory Spaces **child module**, not a top-level Mnemon contribution. Its manifest, descriptor, driver, build and tests live here. It uses only the public dsh-mnemon-source-memory-spaces/provider-sdk entry.

Install alongside the Memory Spaces Source, then list { use: 'dsh-mnemon-provider-hindsight', instanceId: 'hindsight' } in that Source's providers. Multiple Source instances own independent children. Connection settings remain Source-owned; secret fields are never projected to the LLM.

Run pnpm install && pnpm verify from this directory. No root test config or private controller is required.
