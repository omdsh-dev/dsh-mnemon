import { expect, it } from 'vitest'
import { capacityReading } from '../src/capacity.tsx'
it('uses native projected context usage and distinguishes unknown capacity from zero', () => {
  expect(capacityReading(undefined)).toBeNull()
  expect(capacityReading({ projectedTokens: 100, contextWindow: 0 })).toBeNull()
  expect(capacityReading({ pressureTokens: 450, projectedTokens: 0, contextWindow: 1000 })).toEqual({ percent: 0, level: 'low' })
  expect(capacityReading({ projectedTokens: 300, contextWindow: 1000 })).toEqual({ percent: 30, level: 'moderate' })
  expect(capacityReading({ projectedTokens: 400, contextWindow: 1000 })).toEqual({ percent: 40, level: 'high' })
  expect(capacityReading({ pressureTokens: 2000, contextWindow: 1000 })).toEqual({ percent: 100, level: 'high' })
})
