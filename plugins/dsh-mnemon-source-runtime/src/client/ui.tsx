import { useMemo, useState, type JSX, type ReactNode } from 'react'
import {
  createMemorySourcePageClient, installMemorySourceUI, MemorySourcePageFrame, translateEn,
  type MemorySourcePageProps, type MnemonSourceManagementClient, type MnemonTranslate,
} from 'dsh-mnemon/client'
import { RuntimePage } from './pages.tsx'
import type { RuntimePageClient } from './api.ts'

export function runtimePageClient(management: MnemonSourceManagementClient): RuntimePageClient {
  const client = createMemorySourcePageClient(management)
  return {
    runtimeMemory: () => client.read('snapshot'),
    mutateRuntimeMemory: input => client.canAssist('mutate') ? client.assist('mutate', { ...input, ...(input.old_text === undefined ? {} : { oldText: input.old_text }) }, true) : client.mutate('mutate', { ...input }, true),
  }
}

function RuntimeSourceView(props: MemorySourcePageProps): JSX.Element | null {
  const client = useMemo(() => props.management === undefined ? undefined : runtimePageClient(props.management), [props.management])
  const [revision, setRevision] = useState(0)
  if (client === undefined) return null
  return <RuntimePage client={client} revision={revision} writeEnabled={props.writable === true} onMutate={() => { setRevision(value => value + 1); props.onRefresh?.() }} />
}

export function RuntimeSourcePage(props: MemorySourcePageProps): ReactNode {
  return <MemorySourcePageFrame locale={props.locale}><RuntimeSourceView key={props.sourceInstanceKey} {...props} /></MemorySourcePageFrame>
}

export function installRuntimeMemoryUI(ctx: Parameters<typeof installMemorySourceUI>[0], t: MnemonTranslate = translateEn): () => void {
  return installMemorySourceUI(ctx, { sourceTypeId: 'runtime', pages: [{ id: 'entries', order: 100, navigation: { group: 'storage', glyph: '◫', detail: () => t('nav.runtime.detail') }, label: () => t('nav.runtime'), component: RuntimeSourcePage }] })
}

export const inject = ['slots', 'locale']
export function apply(ctx: Parameters<typeof installMemorySourceUI>[0]): void { installRuntimeMemoryUI(ctx, ctx.locale?.bind('mnemon') ?? translateEn) }
