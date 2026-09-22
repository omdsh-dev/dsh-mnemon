import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, IconCloseOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MnemonTranslate } from './locales.ts'
import css from './MnemonSettingsCard.module.css'

/** Keep the host navigation intact when its content column cannot fit a form. */
export function SettingsSurface({ children, t }: { children: ReactNode; t: MnemonTranslate }) {
  const frame = useRef<HTMLDivElement>(null), opener = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(false), [open, setOpen] = useState(false)
  useEffect(() => {
    if (!frame.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width
      if (width !== undefined && width > 0) setNarrow(width < 260)
    })
    observer.observe(frame.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (open) content.current?.focus({ preventScroll: true })
    else opener.current?.querySelector('button')?.focus({ preventScroll: true })
  }, [open])
  return <div className={css.settingsFrame} ref={frame} onKeyDownCapture={event => {
    if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false) }
  }}>
    {narrow || open ? <>
      <div className={css.narrowSettings} ref={opener}>
        <strong>{t('config.title')}</strong>
        <p>{t('config.openPanelHint')}</p>
        <Button type="button" variant="outline" onClick={() => setOpen(true)}>{t('config.openPanel')}</Button>
      </div>
      <Modal headless open={open} onClose={() => setOpen(false)} title={t('config.title')} className={css.fullSettings ?? ''}>
        <header className={css.fullSettingsHeader}><h2>{t('config.title')}</h2><Button type="button" size="sm" aria-label={t('config.backToSettings')} onClick={() => setOpen(false)}><IconCloseOutline16 /></Button></header>
        <div className={`${css.fullSettingsContent} ${css.fullSettingsBody}`} ref={content} tabIndex={-1}>{children}</div>
      </Modal>
    </> : children}
  </div>
}
