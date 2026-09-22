import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ColumnDivider from '../components/ColumnDivider'

describe('ColumnDivider', () => {
  it('是无障碍分隔线且可聚焦', () => {
    render(<ColumnDivider left="chat" right="evidence" onResize={() => {}} onReset={() => {}} />)
    const sep = screen.getByRole('separator')
    expect(sep.getAttribute('aria-orientation')).toBe('vertical')
    expect(sep.getAttribute('tabindex')).toBe('0')
  })

  it('方向键按步长调整（左增右减）', () => {
    const onResize = vi.fn()
    render(<ColumnDivider left="chat" right="evidence" onResize={onResize} onReset={() => {}} />)
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowLeft' })
    expect(onResize).toHaveBeenCalledWith(-16)
  })

  it('Shift + 方向键使用加速步长', () => {
    const onResize = vi.fn()
    render(<ColumnDivider left="chat" right="evidence" onResize={onResize} onReset={() => {}} />)
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowRight', shiftKey: true })
    expect(onResize).toHaveBeenCalledWith(64)
  })

  it('两档步长均存在且加速档更大（spec 对「加速键」的定义）', () => {
    const plain = vi.fn()
    const fast = vi.fn()
    const { unmount } = render(
      <ColumnDivider left="chat" right="evidence" onResize={plain} onReset={() => {}} />)
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowRight' })
    unmount()
    render(<ColumnDivider left="chat" right="evidence" onResize={fast} onReset={() => {}} />)
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowRight', shiftKey: true })
    expect(fast.mock.calls[0][0]).toBeGreaterThan(plain.mock.calls[0][0])
  })

  it('双击回到默认宽度', () => {
    const onReset = vi.fn()
    render(<ColumnDivider left="chat" right="evidence" onResize={() => {}} onReset={onReset} />)
    fireEvent.doubleClick(screen.getByRole('separator'))
    expect(onReset).toHaveBeenCalled()
  })
})
