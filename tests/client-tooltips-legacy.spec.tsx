// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MnemonTooltip as SpacesTooltip } from '../plugins/dsh-mnemon-source-memory-spaces/src/client/presentation.ts'
import { MnemonTooltip as SkillsTooltip } from '../plugins/dsh-mnemon-source-skills/src/client/presentation.ts'

vi.mock('dsh-mnemon/client', async importOriginal => ({
  ...await importOriginal<typeof import('dsh-mnemon/client')>(),
  MnemonTooltip: undefined,
}))

afterEach(cleanup)

it.each([SpacesTooltip, SkillsTooltip])('keeps a readable truncated label when the Starter has no shared tooltip', Tooltip => {
  const { rerender } = render(
    <Tooltip label="A full description" onlyWhenClipped><span>Displayed description</span></Tooltip>,
  )
  expect(screen.getByText('Displayed description').getAttribute('title')).toBe('A full description')

  rerender(<Tooltip label="A full description" onlyWhenClipped disabled><span>Displayed description</span></Tooltip>)
  expect(screen.getByText('Displayed description').getAttribute('title')).toBeNull()
})
