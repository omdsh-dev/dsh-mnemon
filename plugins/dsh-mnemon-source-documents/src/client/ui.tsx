import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import {
  createMemorySourcePageClient, installMemorySourceUI, MemorySourcePageFrame, translateEn,
  type MemorySourcePageProps, type MnemonSourceManagementClient, type MnemonTranslate,
} from 'dsh-mnemon/client'
import { DocumentsPage } from './pages.tsx'
import type { DocumentsPageClient } from './api.ts'
import type { DocumentMutationResult, DocumentSearchResult } from '../contracts.ts'

export function documentsPageClient(management: MnemonSourceManagementClient): DocumentsPageClient {
  let latestRevision: string | undefined = management.revision
  const tracked: MnemonSourceManagementClient = {
    ...management,
    read: async (operation, input, options) => {
      const response = await management.read(operation, input, options)
      if (typeof response.revision === 'string') latestRevision = response.revision
      return response
    },
  }
  const client = createMemorySourcePageClient(tracked)
  return {
    documents: () => client.read('snapshot', null, { coalesce: true }),
    document: id => client.read('document', { id }),
    searchDocuments: async (query, includeArchived = false, limit = 50) => {
      const result = await client.read<DocumentSearchResult>('search', { query, includeArchived, limit })
      return latestRevision === undefined ? result : { ...result, revision: latestRevision }
    },
    mutateDocument: input => input.action === 'delete'
      ? client.mutate('delete', { id: input.id, ...(input.fileRevision === undefined ? {} : { fileRevision: input.fileRevision }) }, true)
      : client.canAssist('mutate') ? client.assist('mutate', { ...input }, true) : client.mutate('mutate', { ...input }, true),
    archiveDocument: id => client.canAssist('archive') ? client.assist('archive', { id }, true) : client.mutate('archive', { id }, true),
    // Keep the revision shown by the confirmation, even if another read has
    // refreshed the shared page client while the dialog was open.
    deleteDocument: async (id, expectedRevision, fileRevision) => (await management.mutate('delete', { id, fileRevision }, { confirmed: true, expectedRevision })).value as unknown as DocumentMutationResult,
  }
}

function DocumentsSourceView(props: MemorySourcePageProps): JSX.Element | null {
  const client = useMemo(() => props.management === undefined ? undefined : documentsPageClient(props.management), [props.management])
  const [revision, setRevision] = useState(0)
  // The workspace's refresh reloads this page as well, while local mutations
  // reload once without echoing through the parent's refreshKey.
  const lastRefreshKey = useRef(props.refreshKey)
  const suppressRefreshEcho = useRef(false)
  useEffect(() => {
    if (lastRefreshKey.current === props.refreshKey) return
    lastRefreshKey.current = props.refreshKey
    if (suppressRefreshEcho.current) {
      suppressRefreshEcho.current = false
      return
    }
    setRevision(value => value + 1)
  }, [props.refreshKey])
  const handleMutate = useCallback(() => {
    if (props.onRefresh === undefined) return
    suppressRefreshEcho.current = true
    props.onRefresh()
    setTimeout(() => { suppressRefreshEcho.current = false }, 0)
  }, [props.onRefresh])
  if (client === undefined) return null
  // A conversation turn opens the document it read or wrote; each visit starts from that document.
  const navigation = props.navigationInput
  const focus = typeof navigation === 'object' && navigation !== null && !Array.isArray(navigation) && typeof navigation.seed === 'string' && navigation.seed !== '' ? navigation : undefined
  return <DocumentsPage key={typeof focus?.nonce === 'number' ? focus.nonce : 0} {...(focus === undefined ? {} : { documentId: focus.seed as string })} canCreate client={client} revision={revision} writeEnabled={props.writable === true} onMutate={handleMutate} />
}

export function DocumentsSourcePage(props: MemorySourcePageProps): ReactNode {
  return <MemorySourcePageFrame locale={props.locale}><DocumentsSourceView key={props.sourceInstanceKey} {...props} /></MemorySourcePageFrame>
}

export function installDocumentsMemoryUI(ctx: Parameters<typeof installMemorySourceUI>[0], t: MnemonTranslate = translateEn): () => void {
  return installMemorySourceUI(ctx, { sourceTypeId: 'documents', pages: [{ id: 'library', order: 200, navigation: { group: 'storage', glyph: '▤' }, label: () => t('nav.documents'), component: DocumentsSourcePage }] })
}

export const inject = ['slots', 'locale']
export function apply(ctx: Parameters<typeof installMemorySourceUI>[0]): void { installDocumentsMemoryUI(ctx, ctx.locale!.bind('mnemon')) }
