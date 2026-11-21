import { useCallback, useEffect, useId, useRef, useState, type JSX, type ReactNode } from 'react'
import { Button, IconWarningOutlineRegular, StateDot, TextShimmer, Toast, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './MnemonFeedback.module.css'

export interface MnemonToast {
  text: string
  tone: 'success' | 'warning' | 'info'
  actions?: ReadonlyArray<{ label: string; run: () => void }>
}

function holdMs(toast: MnemonToast): number {
  const reading = Math.min(8000, Math.max(3000, toast.text.length * 80))
  return toast.actions === undefined || toast.actions.length === 0 ? reading : Math.max(reading, 6000)
}

export function useToast(): { show: (toast: MnemonToast) => void; element: ReactNode } {
  const [current, setCurrent] = useState<{ seq: number; toast: MnemonToast } | null>(null)
  const seq = useRef(0)
  const show = useCallback((toast: MnemonToast) => {
    seq.current += 1
    setCurrent({ seq: seq.current, toast })
  }, [])
  if (current === null) return { show, element: null }
  const dismiss = (): void => setCurrent(existing => existing?.seq === current.seq ? null : existing)
  const { toast } = current
  const element = <Toast key={current.seq} text={toast.text} holdMs={holdMs(toast)} onDone={dismiss}
    {...(toast.tone === 'success' ? { tone: 'success' as const } : toast.tone === 'warning' ? { icon: <IconWarningOutlineRegular /> } : {})}
    {...(toast.actions === undefined ? {} : { actions: toast.actions.map(action => ({ label: action.label, onClick: () => { dismiss(); action.run() } })) })} />
  return { show, element }
}

const REVEAL_MS = 220

export function Reveal({ children, className }: { children: ReactNode; className?: string | undefined }): JSX.Element | null {
  const open = children !== null && children !== undefined && children !== false
  const last = useRef<ReactNode>(null)
  if (open) last.current = children
  const [closing, setClosing] = useState(false)
  const wasOpen = useRef(open)
  useEffect(() => {
    if (open) {
      wasOpen.current = true
      setClosing(false)
      return
    }
    if (!wasOpen.current) return
    wasOpen.current = false
    setClosing(true)
    const timer = setTimeout(() => {
      last.current = null
      setClosing(false)
    }, REVEAL_MS)
    return () => clearTimeout(timer)
  }, [open])
  if (!open && !closing) return null
  return <div className={[css.reveal, className].filter(Boolean).join(' ')} data-state={open ? 'open' : 'closing'} aria-hidden={open ? undefined : true}>
    <div className={css.revealBody}>{open ? children : last.current}</div>
  </div>
}

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

export const TARGET = 'data-mnemon-target'

export function locate(root: HTMLElement | null, targets: readonly string[], options: { scroll?: boolean } = {}): void {
  if (root === null) return
  const marked = [...root.querySelectorAll<HTMLElement>(`[${TARGET}]`)]
  const elements = targets.flatMap(target => marked.filter(element => element.getAttribute(TARGET) === target))
  if (elements.length === 0) return
  const still = reducedMotion()
  if (options.scroll === true) elements[0]!.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' })
  if (still) return
  for (const element of elements) {
    element.removeAttribute('data-mnemon-flash')
    void element.offsetWidth
    element.setAttribute('data-mnemon-flash', '')
    setTimeout(() => { element.removeAttribute('data-mnemon-flash') }, 1400)
  }
}

export type MnemonTone = StateDotState

export function Callout(props: { tone: MnemonTone; title: ReactNode; children?: ReactNode; actions?: ReactNode; className?: string | undefined; live?: boolean }): JSX.Element {
  const role = props.live === false ? undefined : props.tone === 'error' ? 'alert' : 'status'
  const titleId = useId()
  return <div className={[css.callout, props.className].filter(Boolean).join(' ')} data-tone={props.tone} aria-labelledby={titleId} {...(role === undefined ? {} : { role })}>
    <StateDot state={props.tone} className={css.calloutDot} />
    <div className={css.calloutCopy}>
      <strong id={titleId}>{props.title}</strong>
      {props.children !== undefined && <span>{props.children}</span>}
    </div>
    {props.actions !== undefined && <div className={css.calloutActions}>{props.actions}</div>}
  </div>
}

export function ActionButton(props: { label: string; pendingLabel?: string; pending?: boolean; disabled?: boolean; primary?: boolean; ariaLabel?: string; onClick: () => void }): JSX.Element {
  const pending = props.pending === true
  return <Button variant={props.primary === true ? 'primary' : 'outline'} size="sm" className={css.actionButton}
    disabled={props.disabled === true || pending} aria-busy={pending || undefined}
    {...(props.ariaLabel === undefined ? {} : { 'aria-label': props.ariaLabel })}
    onClick={props.onClick}>
    {pending ? <TextShimmer active>{props.pendingLabel ?? props.label}</TextShimmer> : props.label}
  </Button>
}
