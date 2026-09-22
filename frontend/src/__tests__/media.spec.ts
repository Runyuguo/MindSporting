import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useMediaQuery } from '../hooks/useMediaQuery'

describe('useMediaQuery', () => {
  it('reflects the current match state', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: true,
      media: q,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }))
    const { result } = renderHook(() => useMediaQuery('(min-width: 1280px)'))
    expect(result.current).toBe(true)
  })

  it('degrades to false when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined)
    const { result } = renderHook(() => useMediaQuery('(min-width: 1280px)'))
    expect(result.current).toBe(false)
  })
})
