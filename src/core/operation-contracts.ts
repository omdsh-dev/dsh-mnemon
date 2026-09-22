import { MEMORY_ACCESS_KINDS, MEMORY_EXECUTION_STATES, MEMORY_OPERATION_EFFECTS, MEMORY_RESULT_SHAPES, type MemoryAccessSemantics, type MemoryContextProfile, type MemoryExecutionResult, type MemoryOperationSemantics, type MemoryResourceReference } from './contracts/index.ts'
import { id, jsonClone, positiveInteger, requiredText, uniqueIds } from './definitions.ts'

export function validateMemoryManagementOperations(value: import('./contracts/index.ts').MemorySourceOperationInventory): import('./contracts/index.ts').MemorySourceOperationInventory {
  fields(value, ['reads', 'actions'], 'Management operations')
  if (!Array.isArray(value.reads) || !Array.isArray(value.actions) || value.reads.length > 128 || value.actions.length > 128) throw new Error('Management operation limit exceeded')
  const reads = value.reads.map(item => ({ id: id(item.id, 'Management read'), description: requiredText(item.description, 'Management read description', 2000), ...(item.access === undefined ? {} : { access: validateMemoryAccess(item.access) }) }))
  const actions = value.actions.map(item => {
    if (item.requiresApproval !== true) throw new Error('Human management actions must declare confirmation')
    if (item.operation?.requiresReadGrant) throw new Error('Human management cannot use a model read grant')
    return { id: id(item.id, 'Management action'), description: requiredText(item.description, 'Management action description', 2000), requiresApproval: true, ...(item.operation === undefined ? {} : { operation: validateMemoryOperation(item.operation, 'human-management') }) }
  })
  uniqueIds(reads.map(item => item.id), 'Management read'); uniqueIds(actions.map(item => item.id), 'Management action')
  return jsonClone({ reads, actions }, 'Management operations')
}

function fields(value: unknown, allowed: readonly string[], label: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`${label} has unsupported fields`)
}
function members<T extends string>(value: readonly T[], allowed: readonly T[], label: string): T[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > allowed.length || new Set(value).size !== value.length || value.some(item => !allowed.includes(item))) throw new Error(`${label} must be a distinct, nonempty list of supported values`)
  return [...value]
}
export function validateMemoryAccess(value: MemoryAccessSemantics): MemoryAccessSemantics {
  fields(value, ['kinds', 'result'], 'Memory access')
  if (!MEMORY_RESULT_SHAPES.includes(value.result)) throw new Error('Unsupported Memory access result shape')
  return jsonClone({ kinds: members(value.kinds, MEMORY_ACCESS_KINDS, 'Memory access kinds'), result: value.result }, 'Memory access')
}
export function validateMemoryOperation(value: MemoryOperationSemantics, authority?: string): MemoryOperationSemantics {
  fields(value, ['effects', 'execution', 'requiresReadGrant'], 'Memory operation')
  const effects = members(value.effects, MEMORY_OPERATION_EFFECTS, 'Memory operation effects')
  if (value.execution !== 'immediate' && value.execution !== 'deferred') throw new Error('Unsupported Memory operation execution')
  if (value.requiresReadGrant !== undefined && value.requiresReadGrant !== true) throw new Error('Memory operation requiresReadGrant must be true when declared')
  if (effects.some(effect => effect === 'execute' || effect === 'deliver') && !authority) throw new Error('Execution and delivery operations must declare external authority')
  return jsonClone({ effects, execution: value.execution, ...(value.requiresReadGrant === undefined ? {} : { requiresReadGrant: true as const }) }, 'Memory operation')
}
export function validateMemoryContext(value: MemoryContextProfile): MemoryContextProfile {
  fields(value, ['mode', 'weight'], 'Memory context profile')
  if (value.mode !== 'eager' && value.mode !== 'routed') throw new Error('Unsupported Memory context mode')
  return jsonClone({ mode: value.mode, weight: positiveInteger(value.weight, 'Memory context weight', 100) }, 'Memory context profile')
}
export function validateMemoryReference(value: MemoryResourceReference): MemoryResourceReference {
  fields(value, ['id', 'revision', 'path', 'mediaType'], 'Memory resource reference')
  const result: MemoryResourceReference = { id: requiredText(value.id, 'Memory resource id', 500) }
  if (/[\u0000-\u001f\u007f]/u.test(result.id)) throw new Error('Memory resource reference contains control characters')
  for (const [key, limit] of [['revision', 500], ['path', 4096], ['mediaType', 200]] as const) {
    if (value[key] !== undefined) {
      const text = requiredText(value[key], `Memory resource ${key}`, limit)
      if (/[\u0000-\u001f\u007f]/u.test(text)) throw new Error('Memory resource reference contains control characters')
      result[key] = text
    }
  }
  return jsonClone(result, 'Memory resource reference')
}
export function validateMemoryExecution(value: MemoryExecutionResult): MemoryExecutionResult {
  fields(value, ['id', 'state', 'exitCode'], 'Memory execution')
  if (!MEMORY_EXECUTION_STATES.includes(value.state)) throw new Error('Unsupported Memory execution state')
  if (value.exitCode !== undefined && (!Number.isSafeInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 255 || ['queued', 'running', 'unknown'].includes(value.state) || value.state === 'succeeded' && value.exitCode !== 0)) throw new Error('Memory execution exit code conflicts with its state')
  return jsonClone({ id: requiredText(value.id, 'Memory execution id', 500), state: value.state, ...(value.exitCode === undefined ? {} : { exitCode: value.exitCode }) }, 'Memory execution')
}
