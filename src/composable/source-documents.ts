import { createDocumentsMemorySource } from '../../plugins/dsh-mnemon-source-documents/src/source.ts'
import { DocumentManager } from '../../plugins/dsh-mnemon-source-documents/src/controller.ts'
import { BUILTIN_MEMORY_BINDINGS } from './bindings.ts'

/** @deprecated Source-level compatibility for callers supplying old object bindings. */
export const DOCUMENTS_MEMORY_SOURCE = createDocumentsMemorySource({}, context => {
  const documents = context.binding<DocumentManager>(BUILTIN_MEMORY_BINDINGS.documents)
  if (documents === undefined) throw new Error('Legacy Documents Source requires its Host manager binding')
  return documents
})
