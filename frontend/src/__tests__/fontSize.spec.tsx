import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { FontSizeControl } from '../components/FontSizeControl'
import {
  FONT_PT_DEFAULT,
  FONT_PT_KEY,
  FONT_PT_MAX,
  FONT_PT_MIN,
  clampFontPt,
  loadFontPt,
  saveFontPt,
} from '../lib/fontSize'

/**
 * 全站字号的**可调区间收窄为 12–18pt**（使用者 2026-09-19 要求；区间此前无处可查，
 * T56 一并回写为 001 §8 的 C-21）。
 *
 * 本条的重点不是改一个数字，而是**存量值**：已有使用者把字号存在 localStorage 里
 * （键 `ragqa:font-pt`），其中会有上限还是 30 时存下的 25 / 30。载入必须把它们**夹到新区间**，
 * 否则根字号会按 30pt 渲染，而控件（max=18）显示与之一致不了 —— 用户看到的是
 * 「拖不动、但字确实比最大档还大」这种自相矛盾的状态。
 */

/** 存储里的存量值：模拟「上一个版本存下的越界字号」。 */
function seed(pt: string | null) {
  localStorage.clear()
  if (pt !== null) localStorage.setItem(FONT_PT_KEY, pt)
}

afterEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('style')
  vi.unstubAllGlobals()
})

describe('字号区间与默认值', () => {
  it('区间 12–18pt、默认 16pt', () => {
    expect(FONT_PT_MIN).toBe(12)
    expect(FONT_PT_MAX).toBe(18)
    expect(FONT_PT_DEFAULT).toBe(16)
  })

  it('夹紧：越界一律落到 12 / 18，区间内原样，非有限数回落默认', () => {
    expect(clampFontPt(30)).toBe(18)
    expect(clampFontPt(25)).toBe(18)
    expect(clampFontPt(19)).toBe(18)
    expect(clampFontPt(18)).toBe(18)
    expect(clampFontPt(16)).toBe(16)
    expect(clampFontPt(12)).toBe(12)
    expect(clampFontPt(11)).toBe(12)
    expect(clampFontPt(0)).toBe(12)
    expect(clampFontPt(-5)).toBe(12)
    expect(clampFontPt(Number.NaN)).toBe(16)
    expect(clampFontPt(Number.POSITIVE_INFINITY)).toBe(16)
    // 存储里可能是字符串（旧版本 / 手改），非数字一律回落默认而不是变成 NaNpt
    expect(clampFontPt('20')).toBe(16)
    expect(clampFontPt(undefined)).toBe(16)
  })
})

describe('载入存量值：越界的存量字号在新版本里被夹到新区间', () => {
  it.each([
    ['30', 18],
    ['25', 18],
    ['19', 18],
    ['18', 18],
    ['16', 16],
    ['12', 12],
    ['11', 12],
  ])('存储里是 %s 时载入为 %i', (stored, expected) => {
    seed(stored)
    expect(loadFontPt()).toBe(expected)
  })

  it('没有存量值 / 存量值损坏时回落默认', () => {
    seed(null)
    expect(loadFontPt()).toBe(16)
    seed('不是数字')
    expect(loadFontPt()).toBe(16)
  })

  // 措辞要点：写入侧夹紧**不等于**「存储里不存在越界值」—— 载入侧只在内存里夹，
  // 旧值会一直躺在 localStorage 里，直到使用者动一次滑杆才被覆盖（见 C-21）。
  it('写入侧同样夹紧：`saveFontPt` 不会把越界值写进存储', () => {
    seed(null)
    saveFontPt(30)
    expect(localStorage.getItem(FONT_PT_KEY)).toBe('18')
    saveFontPt(9)
    expect(localStorage.getItem(FONT_PT_KEY)).toBe('12')
  })
})

describe('字号控件', () => {
  it('区间与步长取自同一份真值（不能再拖到 18 以上）', () => {
    render(<FontSizeControl pt={16} onChange={() => {}} />)
    const slider = screen.getByRole('slider', { name: '字号：当前 16pt' })
    expect(slider).toHaveAttribute('min', String(FONT_PT_MIN))
    expect(slider).toHaveAttribute('max', String(FONT_PT_MAX))
    expect(slider).toHaveAttribute('step', '1')
  })

  it('可访问名带上当前值（读屏要知道自己在哪一档）', () => {
    render(<FontSizeControl pt={18} onChange={() => {}} />)
    expect(screen.getByRole('slider', { name: '字号：当前 18pt' })).toBeInTheDocument()
  })

  it('拖动即回调新值', () => {
    const onChange = vi.fn()
    render(<FontSizeControl pt={16} onChange={onChange} />)
    fireEvent.change(screen.getByRole('slider', { name: /字号/ }), { target: { value: '18' } })
    expect(onChange).toHaveBeenCalledWith(18)
  })
})

describe('App：存量越界字号在载入时就落到新区间', () => {
  it('存的 30pt 渲染成 18pt，控件与根字号一致（不会「字比最大档还大、滑杆却拖不动」）', () => {
    seed('30')
    render(<App />)

    expect(document.documentElement.style.fontSize).toBe('18pt')
    const slider = screen.getByRole('slider', { name: /字号/ })
    expect(slider).toHaveValue('18')
    expect(slider).toHaveAttribute('max', '18')
  })

  it('区间内的存量值原样生效（夹紧不得顺手改掉合法值）', () => {
    seed('14')
    render(<App />)

    expect(document.documentElement.style.fontSize).toBe('14pt')
    expect(screen.getByRole('slider', { name: /字号/ })).toHaveValue('14')
  })
})
