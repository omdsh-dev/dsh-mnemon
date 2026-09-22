import { describe, expect, it } from 'vitest'
import { reviewCheckpoint } from '../src/host/review-checkpoint.ts'
import type { HostSessionEvent } from '../src/host/dsh.ts'

describe('bounded review checkpoint', () => {
  it('uses whole visible messages and excludes rewound, plugin and unfinished evidence', () => {
    const message = (seq: number, text: string, type = 'user/message', kind = 'user'): HostSessionEvent => ({ seq, type, data: { message: { source: { kind }, content: [{ type: 'text', text }] } } })
    const events = [message(0, 'rewound fact'), message(1, 'plugin assertion', 'user/message', 'plugin'),
      message(2, 'Please remember the explicit decision to use SQLite.'), message(3, 'oversized '.repeat(500)),
      message(4, 'bounded artifact', 'assistant/message'), message(5, 'successful tool evidence', 'tool/result'),
      { seq: 6, type: 'turn/end', data: {} }, message(7, 'unfinished fact')]
    const prompt = reviewCheckpoint({ events, surface: { nodes: [1, 2, 3, 4, 5, 7] } }, 1_000)
    expect(prompt.length).toBeLessThanOrEqual(1_000)
    expect(prompt).toContain('Please remember the explicit decision to use SQLite.')
    expect(prompt).toContain('bounded artifact')
    expect(prompt).toContain('successful tool evidence')
    expect(prompt).not.toMatch(/rewound fact|plugin assertion|oversized|unfinished fact/)
    expect(prompt).toContain('skip candidates needing missing evidence')
  })

  it('does not reconstruct discarded context when the current public surface is unavailable', () => {
    expect(reviewCheckpoint({ events: [] }, 1_000)).toContain('Skip this review without a mutation')
    expect(reviewCheckpoint({ events: [], surface: { nodes: [] } }, 1_000)).toContain('No completed checkpoint')
  })
})
