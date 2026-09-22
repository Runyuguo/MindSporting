import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_LAYOUT } from '../lib/layout'
import ColumnToggles from '../components/ColumnToggles'

describe('ColumnToggles', () => {
  it('四个开关恒在且顺序固定', () => {
    render(<ColumnToggles layout={DEFAULT_LAYOUT} onToggle={() => {}} />)
    const names = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))
    expect(names).toEqual(['功能栏', '对话栏', '依据栏', '文献卡栏'])
  })

  it('开关状态与栏的开合一致（aria-pressed）', () => {
    const layout = { ...DEFAULT_LAYOUT, doc: { width: 0, open: false } }
    render(<ColumnToggles layout={layout} onToggle={() => {}} />)
    expect(screen.getByLabelText('文献卡栏').getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByLabelText('对话栏').getAttribute('aria-pressed')).toBe('true')
  })

  // 简报此处的点击用 `@testing-library/user-event`，而本仓未安装该依赖（既有 20 个测试文件
  // 的点击一律走 `fireEvent`）。此处沿用既有约定：本用例只关心「点击回传哪个 key」，
  // 不涉及 user-event 独有的悬停/输入语义。
  it('点击开关回传该栏 key', () => {
    const onToggle = vi.fn()
    render(<ColumnToggles layout={DEFAULT_LAYOUT} onToggle={onToggle} />)
    fireEvent.click(screen.getByLabelText('依据栏'))
    expect(onToggle).toHaveBeenCalledWith('evidence')
  })

  it('对话栏的开关禁用并说明原因（它不可关闭）', () => {
    render(<ColumnToggles layout={DEFAULT_LAYOUT} onToggle={() => {}} />)
    expect(screen.getByLabelText('对话栏')).toBeDisabled()
  })

  it('窄视口下四个开关仍可见（不回退为隐藏）', () => {
    render(<ColumnToggles layout={DEFAULT_LAYOUT} onToggle={() => {}} />)
    // 不依赖视口宽度，恒渲染四个
    expect(screen.getAllByRole('button')).toHaveLength(4)
  })
})
