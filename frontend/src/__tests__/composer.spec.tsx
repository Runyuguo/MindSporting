import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Composer } from '../components/Composer'

/**
 * `Composer` 是**受控**组件（草稿由 `ChatPanel` 持有，空态示例问题要能写进来）。
 * 测试同样要给它一份状态，否则 `value` 永远不变，测到的是"输入框不动"。
 */
function Harness({
  onSubmit,
  onAbort,
  busy = false,
  initial = '',
}: {
  onSubmit: (t: string) => void
  onAbort: () => void
  busy?: boolean
  initial?: string
}) {
  const [value, setValue] = useState(initial)
  return (
    <Composer value={value} onChange={setValue} onSubmit={onSubmit} onAbort={onAbort} busy={busy} />
  )
}

describe('Composer', () => {
  it('submits on Enter and clears the field', () => {
    const onSubmit = vi.fn()
    render(<Harness onSubmit={onSubmit} onAbort={() => {}} />)
    const box = screen.getByRole('textbox')
    fireEvent.change(box, { target: { value: '线粒体自噬' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith('线粒体自噬')
    // 提交后必须清空：否则同一句话会被连着发两次
    expect((box as HTMLTextAreaElement).value).toBe('')
  })

  it('inserts a newline on Shift+Enter without submitting', () => {
    const onSubmit = vi.fn()
    render(<Harness onSubmit={onSubmit} onAbort={() => {}} />)
    const box = screen.getByRole('textbox')
    fireEvent.change(box, { target: { value: 'a' } })
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('refuses to submit blank input', () => {
    const onSubmit = vi.fn()
    render(<Harness onSubmit={onSubmit} onAbort={() => {}} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('swaps the send button for an abort button while busy', () => {
    const onAbort = vi.fn()
    render(<Harness onSubmit={() => {}} onAbort={onAbort} busy />)
    fireEvent.click(screen.getByRole('button', { name: '中断' }))
    expect(onAbort).toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '发送' })).toBeNull()
  })

  it('does not submit on Enter that confirms an IME composition candidate', () => {
    const onSubmit = vi.fn()
    render(<Harness onSubmit={onSubmit} onAbort={() => {}} />)
    const box = screen.getByRole('textbox')
    fireEvent.change(box, { target: { value: '线粒体自噬' } })
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  // 空态示例问题要"点一下就填进输入框"，故受控值必须能由外部写进来。
  it('displays an externally supplied value (示例问题填入)', () => {
    render(<Harness onSubmit={() => {}} onAbort={() => {}} initial="虚拟细胞与 AI 建模" />)
    expect(screen.getByRole('textbox')).toHaveValue('虚拟细胞与 AI 建模')
  })
})
