export type MnemonAnchorPage = 'status' | `${string}/${string}`

export interface MnemonAnchor {
  page: MnemonAnchorPage
  seed?: string
  sessionId?: string
}

export const MNEMON_ANCHOR_EVENT = 'mnemon:anchor'

const pendingBySession = new Map<string, MnemonAnchor>()

function keyOf(sessionId?: string): string {
  return sessionId === undefined || sessionId === '' ? '*' : sessionId
}

export function dispatchMnemonAnchor(anchor: MnemonAnchor): void {
  pendingBySession.set(keyOf(anchor.sessionId), anchor)
  window.dispatchEvent(new CustomEvent<MnemonAnchor>(MNEMON_ANCHOR_EVENT, { detail: anchor }))
}

export type MnemonAnchorFilter = (page: MnemonAnchorPage) => boolean
const EVERY_PAGE: MnemonAnchorFilter = () => true

export function consumeMnemonAnchor(sessionId?: string, accepts: MnemonAnchorFilter = EVERY_PAGE): MnemonAnchor | null {
  const key = keyOf(sessionId)
  const anchor = pendingBySession.get(key)
  if (anchor === undefined || !accepts(anchor.page)) return null
  pendingBySession.delete(key)
  return anchor
}

export function subscribeMnemonAnchor(sessionId: string | undefined, onAnchor: (anchor: MnemonAnchor) => void, accepts: MnemonAnchorFilter = EVERY_PAGE): () => void {
  const key = keyOf(sessionId)
  const handler = (event: Event): void => {
    const anchor = (event as CustomEvent<MnemonAnchor>).detail
    if (anchor !== undefined && keyOf(anchor.sessionId) === key && accepts(anchor.page)) {
      if (pendingBySession.get(key) === anchor) pendingBySession.delete(key)
      onAnchor(anchor)
    }
  }
  window.addEventListener(MNEMON_ANCHOR_EVENT, handler)
  return () => window.removeEventListener(MNEMON_ANCHOR_EVENT, handler)
}
