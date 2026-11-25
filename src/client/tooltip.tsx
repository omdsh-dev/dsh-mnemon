import {
  cloneElement,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type JSX,
  type MouseEvent,
  type ReactElement,
  type Ref,
} from 'react'
import { Tooltip, type TooltipSide } from '@deepseek-ai/dsh-client-ui-primitives'

export interface TooltipAnchorProps {
  'aria-describedby'?: string | undefined
  ref?: Ref<HTMLElement> | undefined
  onMouseEnter?: ((event: MouseEvent<HTMLElement>) => void) | undefined
  onMouseLeave?: ((event: MouseEvent<HTMLElement>) => void) | undefined
  onClick?: ((event: MouseEvent<HTMLElement>) => void) | undefined
  onFocus?: ((event: FocusEvent<HTMLElement>) => void) | undefined
  onBlur?: ((event: FocusEvent<HTMLElement>) => void) | undefined
}

export interface MnemonTooltipProps {
  label?: string | undefined
  side?: TooltipSide | undefined
  align?: 'center' | 'end' | undefined
  delayMs?: number | undefined
  focusDelayMs?: number | undefined
  disabled?: boolean | undefined
  portal?: boolean | undefined
  maxWidth?: number | undefined
  onlyWhenClipped?: boolean | undefined
  clippedSelector?: string | undefined
  children: ReactElement<TooltipAnchorProps>
}

type ElementWithRef = ReactElement<TooltipAnchorProps> & { ref?: Ref<HTMLElement> | null }

function assignRef(ref: Ref<HTMLElement> | null | undefined, value: HTMLElement | null): void {
  if (typeof ref === 'function') ref(value)
  else if (ref !== undefined && ref !== null) (ref as { current: HTMLElement | null }).current = value
}

function isElementClipped(element: HTMLElement): boolean {
  return element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1
}

function ClippedTooltip(props: MnemonTooltipProps & { label: string; disabled: boolean }): JSX.Element {
  const anchorRef = useRef<HTMLElement | null>(null)
  const [clipped, setClipped] = useState(false)
  const child = props.children as ElementWithRef
  const childRef = child.ref

  const measure = useCallback((): void => {
    const anchor = anchorRef.current
    if (anchor === null) {
      setClipped(false)
      return
    }
    const target = props.clippedSelector === undefined ? anchor : anchor.querySelector<HTMLElement>(props.clippedSelector) ?? anchor
    setClipped(isElementClipped(target))
  }, [props.clippedSelector])

  const mergedRef = useCallback((element: HTMLElement | null) => {
    anchorRef.current = element
    assignRef(childRef, element)
  }, [childRef])

  useLayoutEffect(() => {
    if (props.disabled) {
      setClipped(false)
      return
    }
    measure()
    const anchor = anchorRef.current
    if (anchor === null || typeof ResizeObserver === 'undefined') return
    const target = props.clippedSelector === undefined ? anchor : anchor.querySelector<HTMLElement>(props.clippedSelector) ?? anchor
    const observer = new ResizeObserver(measure)
    observer.observe(anchor)
    if (target !== anchor) observer.observe(target)
    return () => { observer.disconnect() }
  }, [measure, props.clippedSelector, props.disabled, props.label])

  const anchor = cloneElement(child, {
    ref: mergedRef,
    onMouseEnter: event => {
      child.props.onMouseEnter?.(event)
      if (!props.disabled) measure()
    },
    onFocus: event => {
      child.props.onFocus?.(event)
      if (!props.disabled) measure()
    },
  })

  return (
    <Tooltip
      label={props.label}
      side={props.side ?? 'top'}
      {...(props.align === undefined ? {} : { align: props.align })}
      {...(props.delayMs === undefined ? {} : { delayMs: props.delayMs })}
      {...(props.focusDelayMs === undefined ? {} : { focusDelayMs: props.focusDelayMs })}
      {...(props.maxWidth === undefined ? {} : { maxWidth: props.maxWidth })}
      disabled={props.disabled || !clipped}
      portal={props.portal !== false}
    >
      {anchor}
    </Tooltip>
  )
}

export function MnemonTooltip(props: MnemonTooltipProps): JSX.Element {
  const label = props.label?.trim() ?? ''
  const disabled = props.disabled === true || label === '' || typeof ResizeObserver !== 'function'
  if (props.onlyWhenClipped === true) return <ClippedTooltip {...props} label={label} disabled={disabled} />
  return (
    <Tooltip
      label={label}
      side={props.side ?? 'top'}
      {...(props.align === undefined ? {} : { align: props.align })}
      {...(props.delayMs === undefined ? {} : { delayMs: props.delayMs })}
      {...(props.focusDelayMs === undefined ? {} : { focusDelayMs: props.focusDelayMs })}
      {...(props.maxWidth === undefined ? {} : { maxWidth: props.maxWidth })}
      disabled={disabled}
      portal={props.portal !== false}
    >
      {props.children}
    </Tooltip>
  )
}
