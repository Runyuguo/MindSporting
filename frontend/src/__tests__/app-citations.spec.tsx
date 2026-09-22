import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import type { Hit } from '../lib/events'

/**
 * T56：整机走通「答案里的 [编号] → 对应那张证据卡」。
 *
 * 这里必须走**真实数据路径**（SSE 的 evidence 事件 → useChat 的按轮留存 →
 * ChatPanel 按消息所属轮次取命中 → AnswerMarkdown 渲染 → 点击 → useChat 的选中态 →
 * 依据栏），而不是把两个组件各测一遍再假定它们接得上：编号与卡片对不对得上，
 * 恰恰取决于「这条答案属于哪一轮」与「依据栏正在显示哪一轮」这两件事在整机里怎么互动。
 *
 * `useDoc` 换成间谍（同 app-doc-lifecycle.spec.tsx）：本文件只关心**选中的是哪一篇**，
 * 正文取数本身由 doc.spec.ts / useDoc.spec.ts 覆盖。
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

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}

/** 生成参数能力答复（T49 `/capabilities`）：宽屏功能栏挂载时 App 会取一次。 */
const CAPABILITIES = jsonResponse({ lib: 'ai4s', params: { divergence: true, length: true } })

/** 按序返回用例的响应；挂载期的 `/capabilities` 不占用例的响应序号。 */
function queueFetch(queue: Response[]) {
  let next = 0
  return vi.fn((url: string) =>
    String(url).startsWith('/capabilities')
      ? Promise.resolve(CAPABILITIES)
      : Promise.resolve(queue[next++]),
  )
}

/** 宽屏视口：依据栏/文献卡栏都挂在 `min-width: 1280px` 上。 */
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

function hit(rowid: number, title: string): Hit {
  return {
    rowid,
    source: 'vault:note',
    ref: `01-Literature/${rowid}.md`,
    title,
    category: '',
    extra: '',
    snippet: '…',
    score: 0.8,
  }
}

const evidenceFrame = (...hits: Hit[]) =>
  `event: evidence\ndata: ${JSON.stringify({ lib: 'ai4s', query: 'q', hits })}\n\n`
const answerFrame = (delta: string) =>
  `event: answer\ndata: ${JSON.stringify({ delta })}\n\n`
const DONE = 'event: done\ndata: {}\n\n'

/** 提交一问（不等待：等什么由各用例自己说清）。 */
function ask(text: string) {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: text } })
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
}

/** 卡片按钮的名字含标题；引用标记的名字是「查看第 n 条依据」，两者不会互相匹配。 */
const card = (title: string | RegExp) => screen.getByRole('button', { name: title })

describe('App —— 答案引用标记 → 证据卡（T56）', () => {
  beforeEach(() => {
    localStorage.clear()
    docCtl.open.mockClear()
    docCtl.close.mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.documentElement.removeAttribute('style')
  })

  it('点 [2] 选中该轮第 2 条卡片（编号即位置），并打开它的原文', async () => {
    stubWideViewport()
    vi.stubGlobal(
      'fetch',
      queueFetch([
        sseResponse(
          evidenceFrame(hit(11, '第一条依据'), hit(22, '第二条依据')),
          answerFrame('结论如下[2]。'),
          DONE,
        ),
      ]),
    )

    render(<App />)
    ask('自噬')
    await screen.findByRole('button', { name: /第二条依据/ })

    // 卡片自己带的编号与答案里的编号是**同一套**：第 2 条卡片就写着 [2]
    const second = card(/第二条依据/)
    expect(within(second).getByText('[2]')).toBeInTheDocument()
    expect(second).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(screen.getAllByTestId('citation-link')[0])

    await waitFor(() =>
      expect(docCtl.open).toHaveBeenCalledWith('ai4s', '01-Literature/22.md'),
    )
    expect(card(/第二条依据/)).toHaveAttribute('aria-pressed', 'true')
    expect(card(/第一条依据/)).toHaveAttribute('aria-pressed', 'false')
  })

  // 「与点卡片同一语义」：卡片再点一次是取消选中并关文献卡，引用标记必须一致，
  // 否则同一个选中态会有两套手感。
  it('同一条引用标记再点一次 = 取消选中并关闭文献卡', async () => {
    stubWideViewport()
    vi.stubGlobal(
      'fetch',
      queueFetch([
        sseResponse(
          evidenceFrame(hit(11, '第一条依据')),
          answerFrame('结论[1]。'),
          DONE,
        ),
      ]),
    )

    render(<App />)
    ask('自噬')
    await screen.findByRole('button', { name: /第一条依据/ })

    fireEvent.click(screen.getAllByTestId('citation-link')[0])
    await waitFor(() => expect(docCtl.open).toHaveBeenCalledTimes(1))
    expect(card(/第一条依据/)).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getAllByTestId('citation-link')[0])
    await waitFor(() => expect(card(/第一条依据/)).toHaveAttribute('aria-pressed', 'false'))
    expect(docCtl.close).toHaveBeenCalledTimes(1)
  })

  // 越界编号（模型确实可能发出）：不可点、不误选、不开文献。
  it('越界编号不渲染成控件：不误选任何卡片、不打开任何文献', async () => {
    stubWideViewport()
    vi.stubGlobal(
      'fetch',
      queueFetch([
        sseResponse(
          evidenceFrame(hit(11, '第一条依据'), hit(22, '第二条依据')),
          answerFrame('结论[9]。'),
          DONE,
        ),
      ]),
    )

    render(<App />)
    ask('自噬')
    await screen.findByRole('button', { name: /第二条依据/ })

    expect(screen.queryAllByTestId('citation-link')).toHaveLength(0)
    // 编号本身照常显示（不得为了「不可点」把它从正文里抹掉）
    expect(document.body.textContent).toContain('[9]')
    expect(card(/第一条依据/)).toHaveAttribute('aria-pressed', 'false')
    expect(card(/第二条依据/)).toHaveAttribute('aria-pressed', 'false')
    expect(docCtl.open).not.toHaveBeenCalled()
  })

  /**
   * 承重用例：**引用指向的轮次可能不在显示集合里**。
   *
   * 依据栏默认只显示最新一轮（Ruling 66 的跟随），于是上一轮答案里的 [1] 指向的卡片
   * **根本不在屏上** —— 此时若只做「选中」，用户点下去什么也看不到（而且 onSelectHit
   * 的会员守卫会把它当越界挡掉）。正确行为：把依据栏切到那一轮，再选中那一条。
   */
  it('引用指向的轮次不在显示集合里时：先切到该轮再选中（否则屏上没有那张卡）', async () => {
    stubWideViewport()
    vi.stubGlobal(
      'fetch',
      queueFetch([
        sseResponse(
          evidenceFrame(hit(11, '第一条依据'), hit(22, '第二条依据')),
          answerFrame('第一轮结论[1]。'),
          DONE,
        ),
        sseResponse(
          evidenceFrame(hit(33, '第三条依据')),
          answerFrame('第二轮结论[1]。'),
          DONE,
        ),
      ]),
    )

    render(<App />)
    ask('第一问')
    await screen.findByRole('button', { name: /第一条依据/ })
    ask('第二问')
    await screen.findByRole('button', { name: /第三条依据/ })

    // 前置条件：依据栏现在只显示第二轮 —— 第一轮的卡片确实不在屏上
    expect(screen.queryByRole('button', { name: /第一条依据/ })).toBeNull()

    // 点**第一轮**答案里的 [1]（文档序在前）
    fireEvent.click(screen.getAllByTestId('citation-link')[0])

    await waitFor(() =>
      expect(docCtl.open).toHaveBeenCalledWith('ai4s', '01-Literature/11.md'),
    )
    expect(await screen.findByRole('button', { name: /第一条依据/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    // 切换对使用者是可见的（提问气泡上的筛选标记），不是暗改
    expect(screen.getByText(/第 1 轮 · 已筛选依据/)).toBeInTheDocument()
  })
})
