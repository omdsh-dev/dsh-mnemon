import type { JSX } from 'react'
import css from './MnemonSettingsCard.module.css'

export type Feedback = { tone: 'success' | 'error'; text: string }

export function FeedbackLine({ value }: { value: Feedback | null }): JSX.Element | null {
  if (value === null) return null
  return <span className={[css.syncFeedbackLine, value.tone === 'error' ? css.error : css.syncSuccess].join(' ')} role={value.tone === 'error' ? 'alert' : 'status'}>{value.text}</span>
}
