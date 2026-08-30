# dsh-mnemon-provider-mnemon-native

Owns the native Mnemon CLI read/write/graph protocol, including legacy response decoding and batch import receipt validation. The parent Source supplies a scoped command runner, never a ready-made adapter.

This package is a Memory Spaces child, loaded explicitly in the Source's providers list. Run pnpm verify here to typecheck, test and build independently.
