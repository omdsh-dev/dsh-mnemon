import type { JsonValue, MemorySourceManagementInstance } from '../host/protocol.ts'
import type { MnemonSourceManagementClient } from './source-contracts.ts'
import { MnemonClient } from './api.ts'

export function bindSourceManagementClient(client: MnemonClient, instance: MemorySourceManagementInstance, taskClient: MnemonClient): MnemonSourceManagementClient {
  return {
    sourceInstanceKey: instance.sourceInstanceKey,
    get revision() { return instance.revision },
    ...(instance.assistance === undefined || instance.assistance.length === 0 ? {} : { assistance: {
      operations: instance.assistance,
      execute: (operation: string, input: JsonValue, options: { expectedRevision: string; confirmed: boolean }) => {
        // These clean task-Agent workflows follow the inspected Sidebar root;
        // normal Source edits keep their existing session-aware write path.
        const task = ['agent-search', 'supervise', 'body-create', 'body-metadata-maintain'].includes(operation)
        return (task ? taskClient : client).assistSource(instance.sourceInstanceKey, operation, input, options.expectedRevision, options.confirmed)
      },
    } }),
    read: (operation, input = null) => client.readSourceManagement(instance.sourceInstanceKey, operation, input),
    mutate: (operation, input, options) => client.mutateSourceManagement(
      instance.sourceInstanceKey,
      operation,
      input,
      options.expectedRevision ?? instance.revision,
      options.confirmed,
    ),
  }
}
