// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SettingsSurface } from '../src/client/SettingsSurface.tsx'
import { translateZh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function surface() {
  let resize!: (width: number) => void
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resize = width => callback([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver) }
    observe() {}
    disconnect() {}
  })
  function Parent() {
    const [value, setValue] = useState('saved')
    return <SettingsSurface t={translateZh}><input aria-label="草稿" value={value} onChange={event => setValue(event.target.value)} /></SettingsSurface>
  }
  render(<Parent />)
  return (width: number) => act(() => resize(width))
}
it('opens a full native dialog for a constrained column and preserves the parent draft on return', () => {
  const resize = surface()
  resize(560)
  expect(screen.getByLabelText('草稿')).toBeTruthy()
  resize(100)
  expect(screen.queryByLabelText('草稿')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '打开记忆设置' }))
  const dialog = screen.getByRole('dialog', { name: '记忆系统设置' })
  expect(dialog.contains(document.activeElement)).toBe(true)
  fireEvent.change(screen.getByLabelText('草稿'), { target: { value: 'unsaved draft' } })
  const outerEscape = vi.fn()
  document.addEventListener('keydown', outerEscape)
  fireEvent.keyDown(screen.getByLabelText('草稿'), { key: 'Escape' })
  document.removeEventListener('keydown', outerEscape)
  expect(outerEscape).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '打开记忆设置' }))
  fireEvent.click(screen.getByRole('button', { name: '打开记忆设置' }))
  expect((screen.getByLabelText('草稿') as HTMLInputElement).value).toBe('unsaved draft')
})
it('keeps an open form in place while the host is resized wider', () => {
  const resize = surface()
  resize(100)
  fireEvent.click(screen.getByRole('button', { name: '打开记忆设置' }))
  resize(560)
  expect(screen.getByRole('dialog')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '返回设置' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByLabelText('草稿')).toBeTruthy()
})
