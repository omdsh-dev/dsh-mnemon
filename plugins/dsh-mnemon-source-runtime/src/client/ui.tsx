import { useMemo, useState, type JSX, type ReactNode } from 'react'
import {
  createMemorySourcePageClient, installMemorySourceUI, MemorySourcePageFrame, translateEn,
  type MemorySourceUIOptions, type MemorySourcePageProps, type MnemonSourceManagementClient, type MnemonTranslate,
} from 'dsh-mnemon/client'
import { RuntimePage } from './pages.tsx'
import type { RuntimePageClient } from './api.ts'

export function runtimePageClient(management: MnemonSourceManagementClient): RuntimePageClient {
  const client = createMemorySourcePageClient(management)
  return {
    runtimeMemory: () => client.read('snapshot'),
    mutateRuntimeMemory: input => client.mutate('mutate', { ...input }, true),
  }
}

function RuntimeSourceView(props: MemorySourcePageProps): JSX.Element | null {
  const client = useMemo(() => props.management === undefined ? undefined : runtimePageClient(props.management), [props.management])
  const [revision, setRevision] = useState(0)
  if (client === undefined) return null
  return <RuntimePage client={client} revision={revision} writeEnabled={props.writable === true} onMutate={() => setRevision(value => value + 1)} />
}

export function RuntimeSourcePage(props: MemorySourcePageProps): ReactNode {
  // The default bundle supplies the same Source-owned component with its
  // legacy maintenance callbacks. Independent installs use only management.
  if (props.children !== undefined) return props.children
  return <MemorySourcePageFrame locale={props.locale}><RuntimeSourceView key={props.sourceInstanceKey} {...props} /></MemorySourcePageFrame>
}

export function installRuntimeMemoryUI(ctx: Parameters<typeof installMemorySourceUI>[0], t: MnemonTranslate = translateEn, options: MemorySourceUIOptions = {}): () => void {
  return installMemorySourceUI(ctx, { sourceTypeId: 'runtime', pages: [{ id: 'entries', label: () => t('nav.runtime'), component: RuntimeSourcePage }] }, options)
}

export const inject = ['slots']
export function apply(ctx: Parameters<typeof installMemorySourceUI>[0]): void { installRuntimeMemoryUI(ctx) }
