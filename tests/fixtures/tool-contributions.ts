import { COMPOSABLE_MEMORY_API_VERSION } from '../../src/core/contracts/index.ts'
import { MemoryRuntime } from '../../src/core/runtime.ts'
import { defineMemorySource } from '../../src/sdk/index.ts'

/** Tool/schema-only fixtures need live definitions, without starting Source storage. */
export function toolContributions() {
  const runtime = new MemoryRuntime()
  for (const typeId of ['runtime', 'documents', 'memory-spaces']) {
    runtime.service.installContributions({ sources: [defineMemorySource({
      manifest: { apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'source', typeId, packageName: 'test-tool-source', role: 'external-memory', capabilities: ['project'], consistency: 'exact-snapshot' },
      create: () => { throw new Error('Tool definition fixture must not instantiate storage') },
    })] }, { instanceId: typeId })
  }
  return runtime
}
