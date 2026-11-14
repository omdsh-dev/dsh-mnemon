import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import {
  createMemorySourcePageClient, installMemorySourceUI, MemorySourcePageFrame, translateEn,
  type MemorySourcePageProps, type MnemonSourceManagementClient, type MnemonTranslate,
} from 'dsh-mnemon/client'
import { RuntimePage } from './pages.tsx'
import type { RuntimePageClient } from './api.ts'

export function runtimePageClient(management: MnemonSourceManagementClient): RuntimePageClient {
  const client = createMemorySourcePageClient(management)
  return {
    runtimeMemory: () => client.read('snapshot', null, { coalesce: true }),
    pinRuntimeMemory: input => client.mutate('pin', { ...input }, true),
    mutateRuntimeMemory: input => client.canAssist('mutate') ? client.assist('mutate', { ...input, ...(input.old_text === undefined ? {} : { oldText: input.old_text }) }, true) : client.mutate('mutate', { ...input }, true),
  }
}

function RuntimeSourceView(props: MemorySourcePageProps): JSX.Element | null {
  const client = useMemo(() => props.management === undefined ? undefined : runtimePageClient(props.management), [props.management])
  const [revision, setRevision] = useState(0)
  // The workspace's refresh reloads this page as well, while local mutations
  // update or reload once without echoing through the parent's refreshKey.
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
  // Switching sessions refreshes session-scoped entries without unmounting the view.
  const lastSessionId = useRef(props.sessionId)
  const lastManagement = useRef(props.management)
  useEffect(() => {
    const managementChanged = lastManagement.current !== props.management
    lastManagement.current = props.management
    if (lastSessionId.current === props.sessionId) return
    lastSessionId.current = props.sessionId
    if (!managementChanged) setRevision(value => value + 1)
  }, [props.management, props.sessionId])
  const handleMutate = useCallback(() => {
    if (props.onRefresh === undefined) return
    suppressRefreshEcho.current = true
    props.onRefresh()
    setTimeout(() => { suppressRefreshEcho.current = false }, 0)
  }, [props.onRefresh])
  if (client === undefined) return null
  // A conversation turn opens the entry it wrote; each visit starts from that entry.
  const navigation = props.navigationInput
  const focus = typeof navigation === 'object' && navigation !== null && !Array.isArray(navigation) && typeof navigation.seed === 'string' && navigation.seed !== '' ? navigation : undefined
  return <RuntimePage key={typeof focus?.nonce === 'number' ? focus.nonce : 0} {...(focus === undefined ? {} : { focusText: focus.seed as string })} {...(props.onRevealElement === undefined ? {} : { onRevealElement: props.onRevealElement })} client={client} revision={revision} writeEnabled={props.writable === true} onMutate={handleMutate} />
}

export function RuntimeSourcePage(props: MemorySourcePageProps): ReactNode {
  return <MemorySourcePageFrame locale={props.locale}><RuntimeSourceView key={props.sourceInstanceKey} {...props} /></MemorySourcePageFrame>
}

export function installRuntimeMemoryUI(ctx: Parameters<typeof installMemorySourceUI>[0], t: MnemonTranslate = translateEn): () => void {
  return installMemorySourceUI(ctx, { sourceTypeId: 'runtime', pages: [{ id: 'entries', order: 100, navigation: { group: 'storage', glyph: '◫' }, label: () => t('nav.runtime'), component: RuntimeSourcePage }] })
}

export const inject = ['slots', 'locale']
export function apply(ctx: Parameters<typeof installMemorySourceUI>[0]): void { installRuntimeMemoryUI(ctx, ctx.locale!.bind('mnemon')) }
