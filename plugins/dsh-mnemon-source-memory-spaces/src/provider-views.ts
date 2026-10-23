import type { MemoryProviderChange, MemoryProviderViewEntry, MemoryProviderViewResult, MemorySpaceIntegration, MemorySpaceIntegrationNote } from './contracts.ts'

/** The most a view lists, and the longest text or image it carries to the page. */
export const PROVIDER_VIEW_LIMITS = Object.freeze({ entries: 500, changes: 50, operations: 200, text: 64_000, change: 8_000, dataUrl: 4_000_000 })

/** The most notes a Provider states about a vendor plugin, and the longest one. */
const INTEGRATION_NOTES = 6
const INTEGRATION_NOTE_CHARACTERS = 300

const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/u

function text(value: unknown, max: number): string | undefined {
  return typeof value === 'string' ? value.slice(0, max) : undefined
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function required(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`Provider view returned no ${label}`)
  return value.slice(0, 2_000)
}

function entry(value: MemoryProviderViewEntry): MemoryProviderViewEntry {
  const size = count(value.size)
  const modifiedAt = text(value.modifiedAt, 100)
  const summary = text(value.summary, 2_000)
  return {
    uri: required(value.uri, 'entry location'), name: required(value.name, 'entry name').slice(0, 500), directory: value.directory === true,
    ...(size === undefined ? {} : { size }), ...(modifiedAt === undefined ? {} : { modifiedAt }), ...(summary === undefined ? {} : { summary }),
  }
}

function change(value: MemoryProviderChange): MemoryProviderChange {
  const operations = Array.isArray(value.operations) ? value.operations : []
  const at = text(value.at, 100)
  const origin = text(value.origin, 500)
  const skipped = count(value.skipped)
  return {
    id: required(value.id, 'change id'),
    ...(at === undefined ? {} : { at }), ...(origin === undefined ? {} : { origin }),
    operations: operations.slice(0, PROVIDER_VIEW_LIMITS.operations).map(operation => {
      if (operation.action !== 'add' && operation.action !== 'update' && operation.action !== 'delete') throw new Error('Provider view returned an unknown change')
      const kind = text(operation.kind, 100)
      const before = text(operation.before, PROVIDER_VIEW_LIMITS.change)
      const after = text(operation.after, PROVIDER_VIEW_LIMITS.change)
      return {
        action: operation.action, uri: required(operation.uri, 'changed location'),
        ...(kind === undefined ? {} : { kind }), ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }),
      }
    }),
    ...(skipped === undefined ? {} : { skipped }),
  }
}

/**
 * What a Provider's view may hand the page: the declared shapes only, and bounded. A Provider is
 * installed code, so a field it adds, an oversized list or a script as an image stops here.
 */
export function boundProviderView(value: MemoryProviderViewResult): MemoryProviderViewResult {
  if (typeof value !== 'object' || value === null) throw new Error('Provider view returned nothing')
  if (value.kind === 'entries') {
    const entries = Array.isArray(value.entries) ? value.entries : []
    return {
      kind: 'entries', uri: required(value.uri, 'location'), entries: entries.slice(0, PROVIDER_VIEW_LIMITS.entries).map(entry),
      ...(value.truncated === true || entries.length > PROVIDER_VIEW_LIMITS.entries ? { truncated: true } : {}),
    }
  }
  if (value.kind === 'file') {
    const size = count(value.size)
    const mediaType = text(value.mediaType, 100)
    const summary = text(value.summary, 4_000)
    const fileText = text(value.text, PROVIDER_VIEW_LIMITS.text)
    const dataUrl = typeof value.dataUrl === 'string' && value.dataUrl.length <= PROVIDER_VIEW_LIMITS.dataUrl && IMAGE_DATA_URL.test(value.dataUrl) ? value.dataUrl : undefined
    return {
      kind: 'file', uri: required(value.uri, 'location'), name: required(value.name, 'file name').slice(0, 500),
      ...(size === undefined ? {} : { size }), ...(mediaType === undefined ? {} : { mediaType }),
      ...(fileText === undefined ? {} : { text: fileText }), ...(dataUrl === undefined ? {} : { dataUrl }), ...(summary === undefined ? {} : { summary }),
      ...(value.truncated === true || (typeof value.text === 'string' && value.text.length > PROVIDER_VIEW_LIMITS.text) ? { truncated: true } : {}),
    }
  }
  if (value.kind === 'changes') {
    const changes = Array.isArray(value.changes) ? value.changes : []
    return {
      kind: 'changes', changes: changes.slice(0, PROVIDER_VIEW_LIMITS.changes).map(change),
      ...(value.truncated === true || changes.length > PROVIDER_VIEW_LIMITS.changes ? { truncated: true } : {}),
    }
  }
  throw new Error('Provider view returned an unknown kind')
}

/** What a Provider says about a vendor plugin beside it, as the page may show it: named fields only, no credential. */
export function boundIntegration(value: MemorySpaceIntegration): MemorySpaceIntegration | undefined {
  if (typeof value !== 'object' || value === null || typeof value.packageName !== 'string' || typeof value.label !== 'string') return undefined
  const flag = (key: 'autoRecall' | 'autoCapture' | 'skipSubagentSessions') => typeof value.automation?.[key] === 'boolean' ? { [key]: value.automation[key] } : {}
  const version = text(value.version, 100)
  const endpoint = text(value.endpoint, 500)
  const account = text(value.account, 200)
  const user = text(value.user, 200)
  const notes = (Array.isArray(value.notes) ? value.notes : []).flatMap((note): MemorySpaceIntegrationNote[] => {
    if (typeof note?.id !== 'string' || note.id === '' || typeof note.text !== 'string' || note.text === '') return []
    const key = text(note.textI18nKey, 200)
    return [{ id: note.id.slice(0, 100), tone: note.tone === 'caution' ? 'caution' : 'info', text: note.text.slice(0, INTEGRATION_NOTE_CHARACTERS), ...(key === undefined ? {} : { textI18nKey: key }) }]
  }).slice(0, INTEGRATION_NOTES)
  return {
    packageName: value.packageName.slice(0, 214), label: value.label.slice(0, 100),
    ...(version === undefined ? {} : { version }),
    automation: { ...flag('autoRecall'), ...flag('autoCapture'), ...flag('skipSubagentSessions') },
    ...(endpoint === undefined ? {} : { endpoint }), ...(account === undefined ? {} : { account }), ...(user === undefined ? {} : { user }),
    ...(typeof value.sameNamespace === 'boolean' ? { sameNamespace: value.sameNamespace } : {}),
    ...(value.state === 'active' || value.state === 'unavailable' ? { state: value.state } : {}),
    ...(notes.length === 0 ? {} : { notes }),
  }
}
