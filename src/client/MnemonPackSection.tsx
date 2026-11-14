import { useEffect, useMemo, useRef, useState, type ChangeEvent, type JSX } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientConnectionHandle, MnemonPackExport, MnemonPackPreview, MnemonPackTarget } from "../host/protocol.ts"
import { MnemonClient } from './api.ts'
import type { MnemonTranslate } from './locales.ts'
import { humanBytes, message } from './page-kit.tsx'
import css from './MnemonSettingsCard.module.css'
import { runtimeArchiveNotice } from './sync-view.ts'
import { SettingRow } from './settings-controls.tsx'

/**
 * The data directory the running Host reads and writes now, and its default
 * one. A Host that does not report the default leaves it out.
 */
export type PackTarget = Omit<MnemonPackTarget, 'defaultRoot'> & { defaultRoot?: string }

/** Where memory lives now, read again whenever `refreshKey` moves. */
export function usePackTarget(
  connection: ClientConnectionHandle | undefined,
  sessionId: string | undefined,
  workspaceId: string | undefined,
  refreshKey: number,
  sharedClient?: MnemonClient,
): { target: PackTarget | null; failed: string | null } {
  const client = useMemo(
    () => sharedClient ?? (connection === undefined ? null : new MnemonClient(connection, sessionId, workspaceId)),
    [connection, sessionId, sharedClient, workspaceId],
  )
  const [state, setState] = useState<{ target: PackTarget | null; failed: string | null }>({ target: null, failed: null })
  useEffect(() => {
    if (client === null) return
    let active = true
    void client.packTarget().then(target => { if (active) setState({ target, failed: null }) }, reason => { if (active) setState({ target: null, failed: message(reason) }) })
    return () => { active = false }
  }, [client, refreshKey])
  return state
}

interface MnemonPackSectionProps {
  client?: MnemonClient
  connection?: ClientConnectionHandle
  sessionId?: string
  workspaceId?: string
  /** The directory a backup exports and an import merges into. */
  target: PackTarget | null
  /** An import ran and may have merged a backup into memory. */
  onImported?: () => void
  t: MnemonTranslate
}

interface PendingZip {
  base64: string
  preview: MnemonPackPreview
}

const ZIP_ACCEPT = '.zip,application/zip'
/** 24 KiB (8192 * 3) aligns on 3-byte base64 blocks and stays well below Function.prototype.apply stack limits. */
const BASE64_ENCODE_CHUNK_BYTES = 24_576
/** 32 KiB (divisible by 4) decodes 24 KiB per chunk without allocating a full-archive binary string. */
const BASE64_DECODE_CHUNK_CHARS = 32_768

export function base64FromBytes(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) return ''
  const parts: string[] = []
  for (let offset = 0; offset < bytes.byteLength; offset += BASE64_ENCODE_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, Math.min(offset + BASE64_ENCODE_CHUNK_BYTES, bytes.byteLength))
    parts.push(btoa(String.fromCharCode.apply(null, chunk as unknown as number[])))
  }
  return parts.join('')
}

export function bytesFromBase64(base64: string): ArrayBuffer {
  const clean = base64.replace(/\s+/gu, '')
  if (clean.length === 0) return new ArrayBuffer(0)
  if (clean.length % 4 !== 0) throw new Error('Invalid base64 archive length')
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
  const totalBytes = (clean.length * 3) / 4 - padding
  const buffer = new ArrayBuffer(totalBytes)
  const bytes = new Uint8Array(buffer)
  let writeOffset = 0
  for (let readOffset = 0; readOffset < clean.length; readOffset += BASE64_DECODE_CHUNK_CHARS) {
    const slice = clean.slice(readOffset, Math.min(readOffset + BASE64_DECODE_CHUNK_CHARS, clean.length))
    const decoded = atob(slice)
    for (let index = 0; index < decoded.length; index += 1) {
      bytes[writeOffset + index] = decoded.charCodeAt(index)
    }
    writeOffset += decoded.length
  }
  return buffer
}

async function fileBase64(file: File): Promise<string> {
  if (typeof FileReader === 'function') {
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(reader.error ?? new Error('Could not read ZIP file'))
      reader.onload = () => {
        const value = reader.result
        if (typeof value !== 'string') return reject(new Error('Could not read ZIP file'))
        const separator = value.indexOf(',')
        if (separator < 0) return reject(new Error('ZIP file encoding is invalid'))
        resolve(value.slice(separator + 1))
      }
      reader.readAsDataURL(file)
    })
  }
  return base64FromBytes(new Uint8Array(await file.arrayBuffer()))
}

function download(result: MnemonPackExport): void {
  const blob = new Blob([bytesFromBase64(result.base64)], { type: result.mimeType })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = result.fileName; anchor.hidden = true
  document.body.append(anchor); anchor.click(); anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** Backup and migration of the data directory as one ZIP; the directory itself shows beside the storage choice. */
export function MnemonPackSection({ client: sharedClient, connection, sessionId, workspaceId, target, onImported, t }: MnemonPackSectionProps): JSX.Element {
  const client = useMemo(
    () => sharedClient ?? (connection === undefined ? null : new MnemonClient(connection, sessionId, workspaceId)),
    [connection, sessionId, sharedClient, workspaceId],
  )
  const input = useRef<HTMLInputElement | null>(null)
  const [pending, setPending] = useState<PendingZip | null>(null)
  const [busy, setBusy] = useState<'export' | 'inspect' | 'import' | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const exportZip = async (): Promise<void> => {
    if (client === null || busy !== null) return
    setBusy('export'); setFailed(null); setNotice(null)
    try {
      const result = await client.exportPack()
      download(result)
      setNotice(t('config.packExported', { file: result.fileName, size: humanBytes(result.bytes) }))
    } catch (reason) {
      setFailed(message(reason))
    } finally { setBusy(null) }
  }

  const inspectZip = async (file: File): Promise<void> => {
    if (client === null || busy !== null) return
    setBusy('inspect'); setFailed(null); setNotice(null); setPending(null)
    try {
      const base64 = await fileBase64(file)
      const preview = await client.inspectPack(base64, file.name)
      setPending({ base64, preview })
    } catch (reason) {
      setFailed(message(reason))
    } finally { setBusy(null) }
  }

  const chooseFile = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (file !== undefined) void inspectZip(file)
  }

  const importZip = async (): Promise<void> => {
    if (client === null || pending === null || busy !== null) return
    setBusy('import'); setFailed(null); setNotice(null)
    try {
      const result = await client.importPack(pending.base64)
      setNotice(t('config.packImportedWhole', { root: result.targetRoot }) + runtimeArchiveNotice(t, result.runtime?.archived))
      setPending(null)
    } catch (reason) {
      setFailed(message(reason))
    } finally {
      setBusy(null)
      // An import that reports a failure can have merged already: the Host reads Memory
      // Spaces again after the write, and that read can fail on its own.
      onImported?.()
    }
  }

  const items = pending?.preview.manifest.summary.reduce((sum, component) => sum + component.items, 0) ?? 0

  return <div className={css.packRow} role="group" aria-labelledby="mnemon-pack-heading">
    <SettingRow title={t('config.packTitle')} titleId="mnemon-pack-heading" hint={t('config.packSimpleDescription')}>
      <div className={css.rowActions}>
        <Button variant="outline" size="sm" disabled={client === null || busy !== null} onClick={() => input.current?.click()}>{busy === 'inspect' ? t('config.packInspecting') : t('config.packImportZip')}</Button>
        <Button variant="outline" size="sm" disabled={client === null || busy !== null || target === null} onClick={() => void exportZip()}>{busy === 'export' ? t('config.packExporting') : t('config.packExportZip')}</Button>
      </div>
      <input ref={input} className={css.visuallyHidden} type="file" accept={ZIP_ACCEPT} aria-label={t('config.packChooseZip')} onChange={chooseFile} />
    </SettingRow>
    {pending !== null && <div className={css.importBar} role="status">
      <div><strong>{pending.preview.fileName ?? t('config.packUnnamedZip')}</strong><small>{t('config.packZipReady', { components: pending.preview.manifest.components.length, items, size: humanBytes(pending.preview.archiveBytes) })}</small></div>
      <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setPending(null)}>{t('common.cancel')}</Button>
      <Button variant="primary" size="sm" disabled={busy !== null} onClick={() => void importZip()}>{busy === 'import' ? t('config.packImporting') : t('config.packImportZipAction')}</Button>
    </div>}
    <div className={css.packFeedback} aria-live="polite">
      {failed !== null && <p className={css.error} role="alert">{t('config.packFailed', { error: failed })}</p>}
      {notice !== null && <p className={css.packSuccess}>{notice}</p>}
      {client === null && <p className={css.readOnly}>{t('config.packUnavailable')}</p>}
    </div>
  </div>
}
