import { useCallback, useEffect, useMemo, useState, type JSX, type ReactNode } from 'react'
import type { MemoryJsonValue } from 'dsh-mnemon/contracts'
import {
  createMemorySourcePageClient, installMemorySourceUI, MemorySourcePageFrame, translateEn, message,
  memoryPageStyles as css, type MemorySourceUIOptions, type MemorySourcePageProps, type MnemonSourceManagementClient, type MnemonTranslate,
} from 'dsh-mnemon/client'
import type { Insight, MemorySpacesStatus } from '../contracts.ts'
import { OverviewPage, ExplorePage, EntitiesPage, RememberPage, ListPage } from './pages.tsx'
import type { MemorySpacesPageClient } from './api.ts'

/** The adapter never gets a transport or chooses another Source instance. */
export function memorySpacesPageClient(management: MnemonSourceManagementClient): MemorySpacesPageClient & { status(): Promise<MemorySpacesStatus> } {
  const client = createMemorySourcePageClient(management)
  const input = (value: unknown): MemoryJsonValue => JSON.parse(JSON.stringify(value)) as MemoryJsonValue
  const hostAssistance = async (): Promise<never> => { throw new Error('Agent-assisted maintenance requires an explicit Host adapter.') }
  return {
    status: () => client.read('status-summary'),
    bodies: () => client.read('bodies'),
    bodyDirectory: () => client.read('body-directory'),
    graph: memoryBodyIds => client.read('graph', input({ memoryBodyIds })),
    list: request => client.read('list', input(request ?? {})),
    entities: (entity, limit) => client.read('entities', input({ entity, limit })),
    search: request => client.read('search', input(request)),
    related: (id, memoryBodyId) => client.read('related', input({ id, memoryBodyId })),
    reconnectBody: memoryBodyId => client.read('body-reconnect', { memoryBodyId }),
    remember: request => client.mutate('remember', input(request), true),
    forget: (id, memoryBodyId) => client.mutate('forget', input({ id, memoryBodyId }), true),
    createBody: request => client.mutate('body-create', input(request), true),
    updateBody: (memoryBodyId, request) => client.mutate('body-update', input({ memoryBodyId, ...request }), true),
    deleteBody: memoryBodyId => client.mutate('body-delete', { memoryBodyId }, true),
    agentSearch: hostAssistance, supervise: hostAssistance, maintainBodyMetadata: hostAssistance,
  }
}

type Page = 'spaces' | 'explore' | 'entities' | 'remember' | 'content'

function MemorySpacesSourceView(props: MemorySourcePageProps & { page: Page }): JSX.Element | null {
  const client = useMemo(() => props.management === undefined ? undefined : memorySpacesPageClient(props.management), [props.management])
  const [revision, setRevision] = useState(0)
  const [status, setStatus] = useState<MemorySpacesStatus | null>(null)
  const [page, setPage] = useState(props.page)
  const [seed, setSeed] = useState('')
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(() => setRevision(value => value + 1), [])
  useEffect(() => { setPage(props.page); setSeed('') }, [props.page])
  useEffect(() => {
    let active = true
    setError(null)
    void client?.status().then(value => { if (active) setStatus(value) }).catch(reason => { if (active) setError(message(reason)) })
    return () => { active = false }
  }, [client, revision])
  if (client === undefined) return null
  const writable = props.writable === true && status?.writeEnabled === true
  const explore = (query: string) => { setSeed(query); setPage('explore') }
  const forget = async (insight: Insight) => { await client.forget(insight.id, insight.memoryBodyId); refresh() }
  const bodies = status?.memoryBodies ?? []
  return <>
    {error !== null && <div className={css.inlineError} role="alert">{error}</div>}
    {page === 'spaces' && <OverviewPage client={client} metadataClient={client} revision={revision} activationEnabled={writable} writeEnabled={writable} agentAvailable={false} fallbackBodies={bodies} fallbackDirectory={status?.memoryBodyDirectory} catalogKnown={status !== null} onMutate={refresh} onAgentRefresh={refresh} onBodyReconnect={refresh} onBodyMetadata={refresh} onExplore={explore} />}
    {page === 'explore' && <ExplorePage client={client} agentClient={client} agentAvailable={false} status={status} seed={seed} writeEnabled={writable} onForget={forget} />}
    {page === 'entities' && <EntitiesPage client={client} revision={revision} writeEnabled={writable} onForget={forget} onExplore={explore} />}
    {page === 'remember' && <RememberPage client={client} agentAvailable={false} memoryBodies={bodies} writeEnabled={writable} seed={seed} onMutate={refresh} />}
    {page === 'content' && <ListPage client={client} revision={revision} writeEnabled={writable} onForget={forget} onClone={insight => { setSeed(insight.content); setPage('remember') }} onExplore={explore} />}
  </>
}

export function MemorySpacesSourcePage(props: MemorySourcePageProps & { page: Page }): ReactNode {
  if (props.children !== undefined) return props.children
  return <MemorySourcePageFrame locale={props.locale}><MemorySpacesSourceView key={props.sourceInstanceKey} {...props} /></MemorySourcePageFrame>
}

export function installMemorySpacesUI(ctx: Parameters<typeof installMemorySourceUI>[0], t: MnemonTranslate = translateEn, options: MemorySourceUIOptions = {}): () => void {
  const pages: Array<{ id: Page; key: Parameters<MnemonTranslate>[0] }> = [
    { id: 'spaces', key: 'nav.bodies' }, { id: 'explore', key: 'nav.search' }, { id: 'entities', key: 'nav.entities' },
    { id: 'remember', key: 'nav.remember' }, { id: 'content', key: 'nav.content' },
  ]
  return installMemorySourceUI(ctx, { sourceTypeId: 'memory-spaces', pages: pages.map(page => ({
    id: page.id, label: () => t(page.key), component: props => <MemorySpacesSourcePage {...props} page={page.id} />,
  })) }, options)
}

export const inject = ['slots']
export function apply(ctx: Parameters<typeof installMemorySourceUI>[0]): void { installMemorySpacesUI(ctx) }
