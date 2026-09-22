import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MessageBubble } from '../components/MessageBubble'

describe('MessageBubble', () => {
  it('renders a user message verbatim', () => {
    render(<MessageBubble message={{ role: 'user', content: '线粒体自噬' }} />)
    expect(screen.getByText('线粒体自噬')).toBeInTheDocument()
  })

  it('renders assistant markdown including strong text', () => {
    render(
      <MessageBubble
        message={{ role: 'assistant', content: '**重点**结论' }}
      />,
    )
    expect(screen.getByText('重点').tagName).toBe('STRONG')
  })

  it('renders inline math through KaTeX', () => {
    const { container } = render(
      <MessageBubble message={{ role: 'assistant', content: '能量 $\\Delta G$ 下降' }} />,
    )
    expect(container.querySelector('.katex')).not.toBeNull()
  })

  it('exposes a busy state while streaming', () => {
    render(
      <MessageBubble
        message={{ role: 'assistant', content: '生成中' }}
        streaming
      />,
    )
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  // T31：文字底板加在**块级**容器上（整条消息一块底），不是逐词高亮。
  it.each([
    ['user', '线粒体自噬的调控机制涉及多个因子'],
    ['assistant', '线粒体自噬的调控机制涉及多个因子'],
  ] as const)('给 %s 消息的**整块**加文字底板', (role, content) => {
    render(<MessageBubble message={{ role, content }} />)
    const text = screen.getByText(content)

    let panel: HTMLElement | null = text
    while (panel !== null && !panel.className.includes('bg-[var(--color-panel)]')) {
      panel = panel.parentElement
    }
    expect(panel).not.toBeNull()
    expect(panel?.className).toContain('border-[var(--color-panel-border)]')
    // 整条消息同处一块底板下 —— 而不是每个词各包一层
    expect(panel?.textContent).toBe(content)
  })
})
