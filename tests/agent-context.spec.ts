import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { contextIsActive, isInactiveContextError } from '../src/host/agent-compat.ts'

it('checks the published Cordis lifetime and accepts adapters without a fiber', async () => {
  const ctx = new Context()
  const fiber = await ctx.plugin({ name: 'mnemon-context-lifetime', apply() {} })
  expect(contextIsActive({ fiber })).toBe(true)
  await fiber.dispose()
  expect(contextIsActive({ fiber })).toBe(false)
  expect(contextIsActive(undefined)).toBe(true)
})

it('recognizes wrapped inactive errors without hiding unrelated failures or looping on causes', () => {
  const inactive = Object.assign(new Error('localized'), { code: 'INACTIVE_EFFECT' })
  expect(isInactiveContextError(new Error('Review interrupted', { cause: inactive }))).toBe(true)
  expect(isInactiveContextError(new Error('cannot create effect on inactive context'))).toBe(true)
  const unrelated = new Error('Provider mentioned an inactive context')
  Object.assign(unrelated, { cause: unrelated })
  expect(isInactiveContextError(unrelated)).toBe(false)
  expect(() => contextIsActive({ fiber: { assertActive() { throw unrelated } } })).toThrow(unrelated)
})
