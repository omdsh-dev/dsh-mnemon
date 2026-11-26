import {
  cloneElement,
  forwardRef,
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

function isElementClipped(anchor: HTMLElement, selector: string | undefined): boolean {
  const target = selector === undefined ? anchor : anchor.querySelector<HTMLElement>(selector) ?? anchor
  return target.scrollWidth > target.clientWidth + 1 || target.scrollHeight > target.clientHeight + 1
}

interface ClippingAnchorProps extends TooltipAnchorProps {
  child: ReactElement<TooltipAnchorProps>
  clippedSelector: string | undefined
}

const ClippingAnchor = forwardRef<HTMLElement, ClippingAnchorProps>(function ClippingAnchor(
  { child, clippedSelector, onMouseEnter, onFocus, ...anchor }, ref,
) {
  return cloneElement(child, {
    ...anchor,
    ref,
    onMouseEnter: event => {
      child.props.onMouseEnter?.(event)
      if (isElementClipped(event.currentTarget, clippedSelector)) onMouseEnter?.(event)
    },
    onFocus: event => {
      child.props.onFocus?.(event)
      if (isElementClipped(event.currentTarget, clippedSelector)) onFocus?.(event)
    },
  })
})

export function MnemonTooltip(props: MnemonTooltipProps): JSX.Element {
  const label = props.label?.trim() ?? ''
  const disabled = props.disabled === true || label === '' || typeof ResizeObserver !== 'function'
  const child = props.children as ElementWithRef
  const anchor = props.onlyWhenClipped !== true ? child : (
    <ClippingAnchor
      child={child}
      clippedSelector={props.clippedSelector}
      ref={child.ref}
      aria-describedby={child.props['aria-describedby']}
      onMouseLeave={child.props.onMouseLeave}
      onClick={child.props.onClick}
      onBlur={child.props.onBlur}
    />
  )
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
      {anchor}
    </Tooltip>
  )
}
