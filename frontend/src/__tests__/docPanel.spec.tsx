import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocPanel } from '../components/DocPanel'
import { useDoc } from '../hooks/useDoc'
import type { DocController } from '../hooks/useDoc'
import type { Doc } from '../lib/doc'

/** 受控的假控制器：组件测试只关心「给定状态渲染什么」，不重复 hook 的取数逻辑。 */
function fakeController(over: Partial<DocController> = {}): DocController {
  return {
    state: 'idle',
    doc: null,
    error: null,
    open: vi.fn(),
    close: vi.fn(),
    ...over,
  }
}

const doc: Doc = {
  lib: 'ai4s',
  ref: '01-Literature/自噬.md',
  title: '线粒体自噬',
  // 两个段落：粗体一段用于断言 `<strong>`，正文一段用于断言纯文本被渲染。
  content: '**粗体**段落\n\n正文段落',
  mtime: 1,
}

/**
 * 渲染同一面板的某个失败态并取回它的可见文案，随即卸载。
 * 用途：拿到**另一态真实渲染出的文案**当对照物——在同一次渲染里 query 另一态只会得到
 * `undefined`，拿它做 `not.toBe` 的右值等于没断言（任何字符串都能满足）。
 */
function failureText(state: 'missing' | 'denied', error: string): string {
  const view = render(
    <DocPanel doc={fakeController({ state, error })} onClose={vi.fn()} />,
  )
  const text = screen.getByTestId(`doc-${state}`).textContent ?? ''
  view.unmount()
  return text
}

describe('DocPanel', () => {
  it('shows a neutral hint when nothing is selected', () => {
    render(<DocPanel doc={fakeController()} onClose={vi.fn()} />)

    expect(screen.getByTestId('doc-panel')).toBeInTheDocument()
    expect(screen.getByTestId('doc-idle')).toBeInTheDocument()
    expect(screen.getByText('点击左侧证据查看文献卡')).toBeInTheDocument()
    // 中性提示不得谎称「找不到」或「被拒绝」。
    expect(screen.queryByTestId('doc-missing')).toBeNull()
    expect(screen.queryByTestId('doc-denied')).toBeNull()
    expect(screen.queryByTestId('doc-error')).toBeNull()
  })

  it('shows visible progress while loading instead of a blank panel', () => {
    render(<DocPanel doc={fakeController({ state: 'loading' })} onClose={vi.fn()} />)

    expect(screen.getByTestId('doc-loading')).toBeInTheDocument()
    expect(screen.getByText('正在载入原文…')).toBeInTheDocument()
  })

  it('renders the content through the Markdown pipeline in ready state', () => {
    render(
      <DocPanel doc={fakeController({ state: 'ready', doc })} onClose={vi.fn()} />,
    )

    expect(screen.getByTestId('doc-ready')).toBeInTheDocument()
    // 标题与来源路径都在头部；正文经 AnswerMarkdown（**粗体** → <strong>）。
    expect(screen.getByText('线粒体自噬')).toBeInTheDocument()
    expect(screen.getByText('01-Literature/自噬.md')).toBeInTheDocument()
    // `**粗体**段落` → `<strong>粗体</strong>段落`：`<strong>` 的文本是 `粗体`。
    expect(screen.getByText('粗体').tagName).toBe('STRONG')
    expect(screen.getByText('正文段落')).toBeInTheDocument()
  })

  it('says the note is gone on missing', () => {
    render(
      <DocPanel
        doc={fakeController({ state: 'missing', error: 'note not found in library vault' })}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByTestId('doc-missing')).toBeInTheDocument()
    expect(screen.getByText('这篇原文已不在知识库中')).toBeInTheDocument()
    expect(screen.queryByTestId('doc-denied')).toBeNull()
  })

  it('says the path was rejected on denied, with wording unlike missing', () => {
    render(
      <DocPanel
        doc={fakeController({
          state: 'denied',
          error: 'ref points outside the library vault',
        })}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByTestId('doc-denied')).toBeInTheDocument()
    expect(screen.getByText('请求被拒绝：该路径不在本库范围内')).toBeInTheDocument()
    // 两者必须可区分，否则使用者分不清「文件没了」与「路径不合法」。
    expect(screen.queryByText('这篇原文已不在知识库中')).toBeNull()
    expect(screen.queryByTestId('doc-missing')).toBeNull()
    // 服务端给出的原因必须可见（零静默失败）。
    expect(screen.getByText(/outside the library vault/)).toBeInTheDocument()
  })

  it('renders missing and denied with mutually exclusive wording', () => {
    // 两次**真实渲染**各自取文案，再做双向比对：只有这样才能证明两态可区分。
    const missingText = failureText('missing', 'note not found in library vault')
    const deniedText = failureText('denied', 'ref points outside the library vault')

    expect(missingText).toContain('这篇原文已不在知识库中')
    expect(deniedText).toContain('请求被拒绝：该路径不在本库范围内')
    // 对方的文案一律不得出现（反向也测）。
    expect(deniedText).not.toContain('这篇原文已不在知识库中')
    expect(missingText).not.toContain('请求被拒绝：该路径不在本库范围内')
    expect(deniedText).not.toBe(missingText)
  })

  it('names the problem on error', () => {
    render(
      <DocPanel
        doc={fakeController({
          state: 'error',
          error: 'note exists but the server could not read it',
        })}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByTestId('doc-error')).toBeInTheDocument()
    expect(screen.getByText('载入原文失败')).toBeInTheDocument()
    expect(screen.getByText(/could not read it/)).toBeInTheDocument()
  })

  it('still shows a message when the error state carries no reason', () => {
    render(
      <DocPanel doc={fakeController({ state: 'error' })} onClose={vi.fn()} />,
    )

    // 零静默失败：没有 error 文案也不能留空面板。
    expect(screen.getByTestId('doc-error')).toBeInTheDocument()
    expect(screen.getByTestId('doc-error').textContent?.trim().length).toBeGreaterThan(0)
  })

  it('never renders a blank body in ready state without a note', () => {
    const { container } = render(
      <DocPanel doc={fakeController({ state: 'ready', doc: null })} onClose={vi.fn()} />,
    )

    // 零静默失败：任何状态组合下正文区都必须有可见文字。
    expect(container.querySelector('[data-testid="doc-ready"]')).toBeNull()
    expect(screen.getByText('原文内容不可用')).toBeInTheDocument()
  })

  // Minor 复审：篇目在、请求成功、但正文为空 —— **空文档**，不是「载入原文失败」。
  it('presents an empty note as an empty document, not as a load failure', () => {
    render(
      <DocPanel
        doc={fakeController({ state: 'empty', doc: { ...doc, content: '   \n\t' } })}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByTestId('doc-empty')).toBeInTheDocument()
    expect(screen.getByText(/空文档/)).toBeInTheDocument()
    // 不得冒称失败，也不得渲染空正文当成功
    expect(screen.queryByTestId('doc-error')).toBeNull()
    expect(screen.queryByTestId('doc-ready')).toBeNull()
    expect(screen.queryByText('载入原文失败')).toBeNull()
  })

  it('reports a close request', () => {
    const onClose = vi.fn()
    render(<DocPanel doc={fakeController({ state: 'ready', doc })} onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: '关闭文献卡' }))

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('DocPanel wired to useDoc', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function Host() {
    const controller = useDoc()
    return (
      <>
        <button
          type="button"
          onClick={() => controller.open('ai4s', '01-Literature/自噬.md')}
        >
          打开甲
        </button>
        <DocPanel doc={controller} onClose={controller.close} />
      </>
    )
  }

  it('fetches on open, and a re-render of the same note does not fetch again', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ...doc }),
    } as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)

    const { rerender } = render(<Host />)
    expect(fetchMock).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '打开甲' }))

    await waitFor(() => expect(screen.getByTestId('doc-ready')).toBeInTheDocument())
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // 重渲染不等于重新取数：同一 (lib, ref) 不得再打一次 /doc。
    rerender(<Host />)
    rerender(<Host />)

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns to the neutral hint after close', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ...doc }),
    } as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)

    render(<Host />)
    fireEvent.click(screen.getByRole('button', { name: '打开甲' }))
    await waitFor(() => expect(screen.getByTestId('doc-ready')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: '关闭文献卡' }))

    expect(screen.getByText('点击左侧证据查看文献卡')).toBeInTheDocument()
    expect(screen.queryByTestId('doc-ready')).toBeNull()
  })
})
