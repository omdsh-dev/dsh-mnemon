import { createHash } from 'node:crypto'
import { canonicalMemoryJson } from '../../core/definitions.ts'
import { validateMemoryExecution } from '../../core/operation-contracts.ts'
import type { MemoryExecutionResult, MemoryExecutionState } from '../../core/contracts/index.ts'

/** Hash semantic JSON content, independent of transport object-key ordering. */
export function memoryOperationPlanDigest(value: unknown): string {
  const serialized = canonicalMemoryJson(value, 'Operation plan')
  if (serialized.length > 256_000) throw new Error('Operation plan exceeds 256000 characters')
  return createHash('sha256').update(serialized).digest('hex')
}

/** Compare the reviewed plan with a Source-recomputed plan before its durable claim. */
export function assertMemoryOperationPlan(reviewed: unknown, current: unknown, message = 'The operation plan changed; preview and approve the current plan'): void {
  if (memoryOperationPlanDigest(reviewed) !== memoryOperationPlanDigest(current)) throw new Error(message)
}

/** Source-observed execution truth. A plan comparison never grants execution authority. */
export function createMemoryExecutionResult(id: string, state: string, exitCode?: number): MemoryExecutionResult {
  return validateMemoryExecution({ id, state: state as MemoryExecutionState, ...(exitCode === undefined ? {} : { exitCode }) })
}
