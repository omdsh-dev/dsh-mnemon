# Workspace integration library

This optional library owns the DSH session adapter and workspace event integration. Generic storage, file, asset, lookup and transfer helpers now live in `dsh-mnemon/source-sdk`. Shared collection, action and lookup panels live in `dsh-mnemon/client`; existing library imports remain compatibility exports.

Each Source keeps its own store, schema and external adapters. This library does not register Sources or govern their behavior. Run `pnpm verify` for standalone checks.
