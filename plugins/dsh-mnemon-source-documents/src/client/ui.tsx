import { useMemo, useState, type JSX, type ReactNode } from 'react'
import {
  createMemorySourcePageClient, installMemorySourceUI, MemorySourcePageFrame, translateEn,
  type MemorySourceUIOptions, type MemorySourcePageProps, type MnemonSourceManagementClient, type MnemonTranslate,
} from 'dsh-mnemon/client'
import { DocumentsPage } from './pages.tsx'
import type { DocumentsPageClient } from './api.ts'

export function documentsPageClient(management: MnemonSourceManagementClient): DocumentsPageClient {
  const client = createMemorySourcePageClient(management)
  return {
    documents: () => client.read('snapshot'),
    document: id => client.read('document', { id }),
    searchDocuments: (query, includeArchived = false, limit = 50) => client.read('search', { query, includeArchived, limit }),
    mutateDocument: input => client.mutate('mutate', { ...input }, true),
    archiveDocument: id => client.mutate('archive', { id }, true),
  }
}

function DocumentsSourceView(props: MemorySourcePageProps): JSX.Element | null {
  const client = useMemo(() => props.management === undefined ? undefined : documentsPageClient(props.management), [props.management])
  const [revision, setRevision] = useState(0)
  if (client === undefined) return null
  return <DocumentsPage canCreate client={client} revision={revision} writeEnabled={props.writable === true} onMutate={() => setRevision(value => value + 1)} />
}

export function DocumentsSourcePage(props: MemorySourcePageProps): ReactNode {
  if (props.children !== undefined) return props.children
  return <MemorySourcePageFrame locale={props.locale}><DocumentsSourceView key={props.sourceInstanceKey} {...props} /></MemorySourcePageFrame>
}

export function installDocumentsMemoryUI(ctx: Parameters<typeof installMemorySourceUI>[0], t: MnemonTranslate = translateEn, options: MemorySourceUIOptions = {}): () => void {
  return installMemorySourceUI(ctx, { sourceTypeId: 'documents', pages: [{ id: 'library', label: () => t('nav.documents'), component: DocumentsSourcePage }] }, options)
}

export const inject = ['slots']
export function apply(ctx: Parameters<typeof installMemorySourceUI>[0]): void { installDocumentsMemoryUI(ctx) }
