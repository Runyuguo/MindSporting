import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import type { Hit } from '../lib/events'

/**
 * 复审 ④：文献卡的开关**时机**（App.tsx 里那个 `selectedRowid` effect）。
 *
 * 本文件只关心「何时 open / 何时 close」，故把 `useDoc` 换成间谍：正文取数、四态
 * 与迟到响应的写权守卫仍由 `doc.spec.ts` / `app.spec.tsx` 里的**真实** useDoc 覆盖。
 * 不这样做就观察不到「挂载时多调了一次 close()」—— 那是一处状态上不可见的空写
 * （request 本来就是 null），只有记录调用次数才钉得住。
 */
const docCtl = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn() }))

vi.mock('../hooks/useDoc', () => ({
  useDoc: () => ({
    state: 'idle',
    doc: null,
    error: null,
    open: docCtl.open,
    close: docCtl.close,
  }),
}))

const enc = new TextEncoder()

function sseResponse(...frames: string[]) {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f))
      c.close()
    },
  })
  return { ok: true, status: 200, body } as unknown as Response
}

/** 宽屏视口：文献卡栏挂在 `min-width: 1280px` 上。 */
function stubWideViewport() {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('min-width: 1280px'),
    media: q,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }))
}

const hit = (rowid: number, title: string): Hit => ({
  rowid,
  source: 'vault:note',
  ref: `01-Literature/${rowid}.md`,
  title,
  category: '',
  extra: '',
  snippet: '…',
  score: 0.8,
})

const evidenceFrame = (...hits: Hit[]) =>
  `event: evidence\ndata: ${JSON.stringify({ lib: 'ai4s', query: 'q', hits })}\n\n`

/** 提交一问并等依据上屏（返回后依据卡即可点选）。 */
async function askOneRound() {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '自噬' } })
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
  await waitFor(() => expect(screen.getByText('第一条依据')).toBeInTheDocument())
}

describe('App 文献卡开关时机（复审 ④）', () => {
  beforeEach(() => {
    localStorage.clear()
    docCtl.open.mockClear()
    docCtl.close.mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.documentElement.removeAttribute('data-theme')
  })

  it('首屏挂载不关闭文献卡（那里本就没有打开的卡片）', async () => {
    stubWideViewport()
    render(<App />)
    // 宽屏功能栏挂载 ⇒ App 会取一次生成参数能力（T49）；冲干净，免得迟到的
    // setState 落在 act 之外并打出警告（断言不变）。
    await act(async () => {})
    expect(docCtl.close).not.toHaveBeenCalled()
  })

  it('选中依据时不关闭；取消选中才关闭文献卡', async () => {
    stubWideViewport()
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          sseResponse(evidenceFrame(hit(1, '第一条依据')), 'event: done\ndata: {}\n\n'),
        ),
      ),
    )

    render(<App />)
    await askOneRound()

    fireEvent.click(screen.getByRole('button', { name: /第一条依据/ }))
    await waitFor(() => expect(docCtl.open).toHaveBeenCalledTimes(1))
    // 选中态从「无」到「有」不构成关闭
    expect(docCtl.close).not.toHaveBeenCalled()

    // 再次点选同一条 = 取消选中 → 关闭
    fireEvent.click(screen.getByRole('button', { name: /第一条依据/ }))
    await waitFor(() => expect(docCtl.close).toHaveBeenCalledTimes(1))
  })

  it('换对话（新建）时关掉面板：选中态被清空，屏上已没有入口', async () => {
    stubWideViewport()
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          sseResponse(evidenceFrame(hit(1, '第一条依据')), 'event: done\ndata: {}\n\n'),
        ),
      ),
    )

    render(<App />)
    await askOneRound()
    fireEvent.click(screen.getByRole('button', { name: /第一条依据/ }))
    await waitFor(() => expect(docCtl.open).toHaveBeenCalledTimes(1))
    expect(docCtl.close).not.toHaveBeenCalled()

    // 换会话 ⇒ useChat 在渲染期把选中态清空 ⇒ 面板必须跟着关
    fireEvent.click(screen.getByTestId('new-conversation'))
    await waitFor(() => expect(docCtl.close).toHaveBeenCalledTimes(1))
  })
})
