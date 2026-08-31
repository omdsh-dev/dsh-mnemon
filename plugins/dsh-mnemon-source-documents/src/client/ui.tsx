import { useMemo, useState, type JSX, type ReactNode } from 'react'
import {
  createMemorySourcePageClient, installMemorySourceUI, MemorySourcePageFrame, translateEn,
  type MemorySourcePageProps, type MnemonSourceManagementClient, type MnemonTranslate,
} from 'dsh-mnemon/client'
import { DocumentsPage } from './pages.tsx'
import type { DocumentsPageClient } from './api.ts'

export function documentsPageClient(management: MnemonSourceManagementClient): DocumentsPageClient {
  const client = createMemorySourcePageClient(management)
  return {
    documents: () => client.read('snapshot'),
    document: id => client.read('document', { id }),
    searchDocuments: (query, includeArchived = false, limit = 50) => client.read('search', { query, includeArchived, limit }),
    mutateDocument: input => client.canAssist('mutate') ? client.assist('mutate', { ...input }, true) : client.mutate('mutate', { ...input }, true),
    archiveDocument: id => client.canAssist('archive') ? client.assist('archive', { id }, true) : client.mutate('archive', { id }, true),
  }
}

function DocumentsSourceView(props: MemorySourcePageProps): JSX.Element | null {
  const client = useMemo(() => props.management === undefined ? undefined : documentsPageClient(props.management), [props.management])
  const [revision, setRevision] = useState(0)
  if (client === undefined) return null
  return <DocumentsPage canCreate client={client} revision={revision} writeEnabled={props.writable === true} onMutate={() => { setRevision(value => value + 1); props.onRefresh?.() }} />
}

export function DocumentsSourcePage(props: MemorySourcePageProps): ReactNode {
  return <MemorySourcePageFrame locale={props.locale}><DocumentsSourceView key={props.sourceInstanceKey} {...props} /></MemorySourcePageFrame>
}

export function installDocumentsMemoryUI(ctx: Parameters<typeof installMemorySourceUI>[0], t: MnemonTranslate = translateEn): () => void {
  return installMemorySourceUI(ctx, { sourceTypeId: 'documents', pages: [{ id: 'library', order: 200, navigation: { group: 'storage', glyph: '▤' }, label: () => t('nav.documents'), component: DocumentsSourcePage }] })
}

export const inject = ['slots', 'locale']
export function apply(ctx: Parameters<typeof installMemorySourceUI>[0]): void { installDocumentsMemoryUI(ctx, ctx.locale?.bind('mnemon') ?? translateEn) }
