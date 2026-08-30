import { createRuntimeMemorySource } from '../../plugins/dsh-mnemon-source-runtime/src/source.ts'
import { RuntimeMemoryController } from '../../plugins/dsh-mnemon-source-runtime/src/controller.ts'
import { BUILTIN_MEMORY_BINDINGS } from './bindings.ts'

/** @deprecated Source-level compatibility for callers supplying old object bindings. */
export const RUNTIME_MEMORY_SOURCE = createRuntimeMemorySource({}, context => {
  const controller = context.binding<RuntimeMemoryController>(BUILTIN_MEMORY_BINDINGS.runtime)
  if (controller === undefined) throw new Error('Legacy Runtime Source requires its Host runtime binding')
  return controller
})
