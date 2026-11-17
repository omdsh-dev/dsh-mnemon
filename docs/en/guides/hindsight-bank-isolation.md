# Read legacy Hindsight banks, write only to a dedicated bank

[简体中文](../../zh-CN/guides/hindsight-bank-isolation.md) | **English** | [Providers](./memory-providers.md)

Existing Source isolation and backend-restricted credentials support the two-connection alternative in [#434](https://github.com/omdsh-dev/dsh-mnemon/issues/434). This optional deployment recipe adds no per-bank ACL to Mnemon and changes no existing configuration.

| Connection | Source configuration | Backend access |
| --- | --- | --- |
| Legacy banks | Separate directory; `writeEnabled: false` | Recall/browse legacy banks |
| New DSH bank | Separate directory; `writeEnabled: true` | Credential restricted to the dedicated bank |

The first boundary rejects model and management mutations before Provider dispatch. The second prevents a writable connection alias, rediscovery, or a changed local bank ID from gaining authority over a legacy bank. Such an alias request reaches the backend and returns an error; it is not a Host-side per-namespace denial. Activation, default `bankId`, prompts, and Strategy selection cannot replace these boundaries.

## Backend prerequisite

Create the dedicated bank through backend administration. On Hindsight Cloud/Enterprise deployments with bank-scoped API keys, restrict the new credential to that bank; [Hindsight documents 403 for other banks](https://docs.hindsight.vectorize.io/enterprise/api-keys/). Never put an unrestricted administrator key in the writable Source. Confirm that discovery works with the restricted credential and lists only authorized banks on your deployment.

Open-source [shared API-key authentication](https://hindsight.vectorize.io/developer/configuration#authentication) authenticates requests; it does not itself isolate banks. Without bank-scoped credentials, use a separately restricted backend endpoint/tenant. Two unrestricted keys with identical access do not provide isolation. This recipe does not configure a proxy or certify an external authorization service.

## Configure the Sources

1. Stop conversations and background tasks during setup. Keep original data directories and remote memories.
2. Add two explicit Memory Spaces entries with distinct IDs and absolute `dataDir` paths, each containing only the Hindsight Provider. Configure endpoint and credential separately in each Source's Provider settings and discover the intended banks. Initial connection setup requires `writeEnabled: true`: do it before accepting Agent work, then set the legacy Source to `false` and restart. Read-only mode also blocks later connection/activation edits; perform those in another stopped maintenance window.
3. Enable **Scoped composition** under the existing **Layered strategy**. Select both Sources plus existing Runtime/Documents Sources you want to retain. Only the new DSH Source should be writable among durable-memory Sources; preserve Runtime/Documents permissions. Use exact Source catalog keys, including any profile prefix. Without scoped selection, two durable-evidence Sources are ambiguous for the default layered Strategy.
4. Remove other writable connections to legacy banks from the deployment. An unrestricted Source retains its own authority. Do not configure another durable-memory Provider as a fallback when the DSH bank is unavailable.

Final Entry fragment; replace paths for your OS and enter credentials through Provider settings:

```yaml
- id: legacy-memory
  name: dsh-mnemon-source-memory-spaces
  config:
    dataDir: /absolute/path/to/legacy-source
    writeEnabled: false
    providers:
      - use: dsh-mnemon-provider-hindsight
        instanceId: hindsight
- id: dsh-memory
  name: dsh-mnemon-source-memory-spaces
  config:
    dataDir: /absolute/path/to/dsh-source
    writeEnabled: true
    providers:
      - use: dsh-mnemon-provider-hindsight
        instanceId: hindsight
```

For these two entries alone, Scoped composition uses `sourceKeys: [source:dsh-memory, source:legacy-memory]` and `writableSourceKeys: [source:dsh-memory]`. Extend these lists with existing Runtime/Documents keys to preserve their participation and permissions. Source order expresses preference, not authority. With multiple Sources/spaces, use exact offered routes/actions and `memoryBodyId` rather than ambiguous defaults.

## Verify before use

- Recall and Related return legacy evidence; the legacy Source offers no write Actions. Management Remember/Forget is rejected before Provider mutation calls.
- Only the dedicated bank is discovered through the writable connection. Hindsight's `queued` receipt means extraction was accepted, not that facts are already durably queryable.
- Disabling the new connection preserves legacy reads and removes durable write Actions. An empty destination set stays empty, without fallback to an old bank.
- Check backend denial using isolated test namespaces/accounts, including aliases and changed local bank IDs. Do not test unknown permissions with destructive requests to production legacy banks.
- Apply authority changes during stopped maintenance and restart before use. Settings cannot recall an already dispatched remote operation; Strategy selection alone is not immediate revocation of older Views.

The [isolation regression](../../../tests/hindsight-source-isolation.spec.ts) runs real Sources, layered/scoped Strategies and the Hindsight adapter against a loopback authorization fixture. It covers two legacy banks, Recall/Related, Host denials, queued receipts, backend-denied aliases and empty write destinations. It does not call or certify live Hindsight. No storage/credential format or Provider behavior changes; removing the optional composition preserves its data directories.
