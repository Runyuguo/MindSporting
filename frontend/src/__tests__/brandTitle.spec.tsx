import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import BrandTitle from '../components/BrandTitle'

describe('BrandTitle', () => {
  it('文本可被读屏获取且等于「思维游乐场」', () => {
    render(<BrandTitle />)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('思维游乐场')
  })

  it('文字是真实文本节点（不是图片或伪元素）', () => {
    render(<BrandTitle />)
    const h = screen.getByRole('heading', { level: 1 })
    expect(h.textContent).toBe('思维游乐场')
    expect(h.querySelector('img')).toBeNull()
  })

  it('带装饰但不牺牲可读性（有底色对比声明）', () => {
    render(<BrandTitle />)
    const h = screen.getByRole('heading', { level: 1 })
    // 装饰限定在可选类上；文本颜色仍由令牌给出（渐变只在支持的浏览器里替换它）
    expect(h.className).toMatch(/text-\[var\(--color-fg/)
  })

  // ---- 整支审查 I5：spec 要求「文字呈现颜色渐变与背板纹理，而非单色平涂」 ----

  it('文字带颜色渐变，且**渐变失效时回退为令牌单色**（不是透明字）', () => {
    render(<BrandTitle />)
    const h = screen.getByRole('heading', { level: 1 })
    const span = h.querySelector('span:not([aria-hidden])')
    expect(span, '渐变要挂在承载文字的 span 上').not.toBeNull()
    const cls = span!.className
    // 渐变必须存在，且必须**裁剪到文字**（否则只是给文字加了个背景块）
    expect(cls).toMatch(/\[background-image:linear-gradient\(/)
    expect(cls).toMatch(/bg-clip-text/)
    // 回退链：先给令牌单色，再在 @supports 里才换成透明+渐变填充。
    // 若把 text-transparent 无条件写上去，不支持 bg-clip-text 的浏览器里
    // 文字会变成**完全看不见**——这正是本组件头注释要防的事。
    expect(cls).not.toMatch(/(^|\s)text-transparent(\s|$)/)
    expect(cls).toMatch(/supports-\[\(-webkit-background-clip:text\)\]:text-transparent/)
  })

  it('背板有纹理层（细网格），且装饰不进入可访问性树', () => {
    render(<BrandTitle />)
    const h = screen.getByRole('heading', { level: 1 })
    const texture = h.querySelector('[data-testid="brand-texture"]')
    expect(texture, 'spec 要求背板纹理，缺失即不达标').not.toBeNull()
    // 纹理是纯装饰：不得被读屏读出来
    expect(texture!.getAttribute('aria-hidden')).toBe('true')
    // 细网格 = 横竖两组 1px 线性渐变
    expect(texture!.className).toMatch(/\[background-image:linear-gradient\(to_right/)
    expect(texture!.className).toMatch(/\[background-size:6px_6px\]/)
  })

  it('纹理与渐变都不改变文本本身（读屏拿到的仍是四个字）', () => {
    render(<BrandTitle />)
    const h = screen.getByRole('heading', { level: 1 })
    // 装饰层是空元素：文本节点只有「思维游乐场」一处
    expect(h.textContent).toBe('思维游乐场')
    expect(h.querySelectorAll('img')).toHaveLength(0)
  })
})
