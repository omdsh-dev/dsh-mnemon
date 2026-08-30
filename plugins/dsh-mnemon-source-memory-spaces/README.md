# dsh-mnemon-source-memory-spaces

Memory Spaces owns its Provider contracts and private child-Fiber host. Provider authors depend on `dsh-mnemon-source-memory-spaces/provider-sdk`, never on the main repository's controllers or global registry.

The compatibility export `dsh-mnemon/source-memory-spaces/provider-sdk` forwards to the same implementation. It does not turn Providers into Core contributions.
