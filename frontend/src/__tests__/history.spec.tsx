import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { HistoryList } from '../components/HistoryList'
import { saveConversations, saveCurrentId, type Conversation } from '../lib/conversations'
import type { Hit } from '../lib/events'

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

const answer = (text: string) =>
  `event: answer\ndata: ${JSON.stringify({ delta: text })}\n\nevent: done\ndata: {}\n\n`

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

/** 功能栏住在四栏工作台里，而四栏由 `≥1280px` 驱动（plan §12.4）。 */
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

/**
 * 宽屏 App 的渲染：功能栏挂载 ⇒ App 会取一次生成参数能力（T49 `/capabilities`）。
 * 若用例自己 stubGlobal('fetch', ...)，请用 `queueFetch` 让能力请求不占响应序号。
 */
async function renderWideApp() {
  const utils = render(<App />)
  await act(async () => {})
  return utils
}

/** 能力端点固定答复；其余请求按序取 `queue` 里的响应。 */
function queueFetch(queue: Response[]) {
  let next = 0
  const capabilities = {
    ok: true,
    status: 200,
    json: async () => ({ lib: 'ai4s', params: { divergence: true, length: true } }),
  } as unknown as Response
  return vi.fn((url: string) =>
    String(url).startsWith('/capabilities')
      ? Promise.resolve(capabilities)
      : Promise.resolve(queue[next++]),
  )
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function conv(over: Partial<Conversation> & { id: string }): Conversation {
  const now = Date.now()
  return {
    title: `对话 ${over.id}`,
    createdAt: now,
    updatedAt: now,
    messages: [],
    evidenceByRound: {},
    ...over,
  }
}

describe('HistoryList', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.unstubAllGlobals())

  it('按 updatedAt 倒序渲染标题与相对时间', () => {
    const now = Date.now()
    const list = [
      conv({ id: 'old', title: '最早的对话', updatedAt: now - 3 * DAY }),
      conv({ id: 'new', title: '最新的对话', updatedAt: now - 30_000 }),
      conv({ id: 'mid', title: '中间的对话', updatedAt: now - 5 * HOUR }),
    ]
    render(
      <HistoryList list={list} currentId="mid" onSelect={() => {}} onCreate={() => {}} onRemove={() => {}} />,
    )

    // 展示层排序：`update` 故意不重排列表（见 useConversations.update），排序是这里的事
    const rows = screen.getAllByTestId('history-row')
    expect(rows.map((r) => r.textContent)).toEqual([
      '最新的对话刚刚',
      '中间的对话5 小时前',
      '最早的对话3 天前',
    ])
  })

  it('点击某一行以该行 id 回调', () => {
    const onSelect = vi.fn()
    const now = Date.now()
    render(
      <HistoryList
        list={[conv({ id: 'a1', title: '甲对话', updatedAt: now })]}
        currentId="a1"
        onSelect={onSelect}
        onCreate={() => {}} onRemove={() => {}}
      />,
    )

    fireEvent.click(screen.getByTestId('history-row'))
    expect(onSelect).toHaveBeenCalledWith('a1')
  })

  it('当前对话有可辨认的选中态，其它行没有', () => {
    const now = Date.now()
    render(
      <HistoryList
        list={[
          conv({ id: 'a1', title: '甲对话', updatedAt: now }),
          conv({ id: 'a2', title: '乙对话', updatedAt: now - HOUR }),
        ]}
        currentId="a2"
        onSelect={() => {}}
        onCreate={() => {}} onRemove={() => {}}
      />,
    )

    // 两行的选中态必须**分别**成立：只看一行的话，"全都带 aria-current"也会绿
    const rows = screen.getAllByTestId('history-row')
    const current = rows.find((r) => r.textContent?.includes('乙对话'))
    const other = rows.find((r) => r.textContent?.includes('甲对话'))
    expect(current).toHaveAttribute('aria-current', 'true')
    expect(other).not.toHaveAttribute('aria-current')
  })

  it('空列表给中性提示，且「＋ 新对话」仍在', () => {
    render(<HistoryList list={[]} currentId={null} onSelect={() => {}} onCreate={() => {}} onRemove={() => {}} />)

    expect(screen.getByText(/还没有对话/)).toBeInTheDocument()
    expect(screen.queryAllByTestId('history-row')).toEqual([])
    expect(screen.getByTestId('new-conversation')).toHaveTextContent('新对话')
  })

  it('「＋ 新对话」触发 onCreate', () => {
    const onCreate = vi.fn()
    render(
      <HistoryList
        list={[conv({ id: 'a1' })]}
        currentId="a1"
        onSelect={() => {}}
        onCreate={onCreate} onRemove={() => {}}
      />,
    )

    fireEvent.click(screen.getByTestId('new-conversation'))
    expect(onCreate).toHaveBeenCalledTimes(1)
  })

  // ---- 每条历史可删（使用者 2026-09-19 要求） ------------------------------------

  it('每条历史都有一个删除按钮，点击回调带上该条的 id', () => {
    const onRemove = vi.fn()
    render(
      <HistoryList
        list={[conv({ id: 'a1', title: '甲对话' }), conv({ id: 'b2', title: '乙对话' })]}
        currentId="a1"
        onSelect={() => {}}
        onCreate={() => {}}
        onRemove={onRemove}
      />,
    )

    const del = screen.getAllByTestId('history-delete')
    expect(del).toHaveLength(2)
    fireEvent.click(del[0])
    // 传的是**这一行**的 id，不是「当前选中」那条 —— 否则会删错对话
    expect(onRemove).toHaveBeenCalledWith('a1')
  })

  it('删除按钮不在选中按钮**内部**（button 嵌套 button 是无效 HTML，且键盘不可达）', () => {
    render(
      <HistoryList
        list={[conv({ id: 'a1', title: '甲对话' })]}
        currentId="a1"
        onSelect={() => {}}
        onCreate={() => {}}
        onRemove={() => {}}
      />,
    )

    const row = screen.getByTestId('history-row')
    const del = screen.getByTestId('history-delete')
    expect(row.contains(del)).toBe(false)
    expect(del.tagName).toBe('BUTTON')
    // 删除是可聚焦的独立控件（键盘使用者必须删得掉）
    expect(del).not.toBeDisabled()
  })

  it('删除按钮的可访问名带上对话标题（读屏列出一串「删除」时能分清删哪条）', () => {
    render(
      <HistoryList
        list={[conv({ id: 'a1', title: '关键问题：切走后我还在吗' })]}
        currentId="a1"
        onSelect={() => {}}
        onCreate={() => {}}
        onRemove={() => {}}
      />,
    )

    expect(
      screen.getByRole('button', { name: '删除对话「关键问题：切走后我还在吗」' }),
    ).toBeInTheDocument()
  })
})

describe('HistoryList 与对话区联动（集成）', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.unstubAllGlobals())

  const ask = (text: string) => {
    fireEvent.change(screen.getByRole('textbox'), { target: { value: text } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
  }

  /**
   * 按标题取历史行。不能用 `getByRole('button', {name})`：对话栏里的提问气泡也是
   * 一个 `role="button"`（点它筛该轮依据），同名会撞。
   */
  const historyRow = (title: string) => {
    const row = screen
      .getAllByTestId('history-row')
      .find((el) => el.textContent?.startsWith(title))
    if (!row) throw new Error(`找不到历史行：${title}`)
    return row
  }

  it('切换对话会换掉对话区内容，且不把上一条对话的内容混进来', async () => {
    stubWideViewport()
    vi.stubGlobal(
      'fetch',
      queueFetch([
        sseResponse(answer('甲答'), `event: evidence\ndata: ${JSON.stringify({ lib: 'ai4s', query: 'q', hits: [hit(1, '甲依据')] })}\n\n`),
        sseResponse(answer('乙答')),
      ]),
    )

    await renderWideApp()
    // 对话区单独取景：历史列表里本来就列着各条对话的标题，全局 queryByText 会把
    // 「标题还在列表里」误判成「内容混进了对话区」。
    const chatArea = () => within(screen.getByTestId('chat-column'))

    // 第一条对话：提问后以问题为标题出现在历史列表里
    ask('甲问')
    await waitFor(() => expect(chatArea().getByText('甲答')).toBeInTheDocument())
    await waitFor(() => expect(historyRow('甲问')).toBeInTheDocument())
    expect(screen.getByText('甲依据')).toBeInTheDocument()

    // 新建对话：对话区真的空掉，旧对话仍在列表里
    fireEvent.click(screen.getByTestId('new-conversation'))
    await waitFor(() => expect(chatArea().queryByText('甲答')).toBeNull())
    expect(chatArea().queryByText('甲问')).toBeNull()
    expect(screen.queryByText('甲依据')).toBeNull()
    expect(historyRow('甲问')).toBeInTheDocument()

    // 第二条对话
    ask('乙问')
    await waitFor(() => expect(chatArea().getByText('乙答')).toBeInTheDocument())
    expect(chatArea().queryByText('甲答')).toBeNull()

    // 回到第一条：只有它自己的消息与依据
    fireEvent.click(historyRow('甲问'))
    await waitFor(() => expect(chatArea().getByText('甲答')).toBeInTheDocument())
    expect(chatArea().getByText('甲问')).toBeInTheDocument()
    expect(screen.getByText('甲依据')).toBeInTheDocument()
    expect(chatArea().queryByText('乙答')).toBeNull()
    expect(chatArea().queryByText('乙问')).toBeNull()

    // 再回第二条：同样只有它自己的
    fireEvent.click(historyRow('乙问'))
    await waitFor(() => expect(chatArea().getByText('乙答')).toBeInTheDocument())
    expect(chatArea().queryByText('甲答')).toBeNull()
    expect(screen.queryByText('甲依据')).toBeNull()
  })

  it('列表只显示当前库的对话，切库即换列表', async () => {
    stubWideViewport()
    const now = Date.now()
    saveConversations('ai4s', [conv({ id: 'a1', title: 'AI4S 的对话', updatedAt: now })])
    saveCurrentId('ai4s', 'a1')
    saveConversations('mito', [conv({ id: 'm1', title: 'MITO 的对话', updatedAt: now })])
    saveCurrentId('mito', 'm1')

    await renderWideApp()
    // 按 `history-row` 定位，而不是按可访问名：删除按钮的可访问名里**也**含标题
    // （那是刻意的，见 HistoryList），按名字查会同时命中两个按钮。
    const rowTitles = () =>
      screen.queryAllByTestId('history-row').map((r) => r.textContent ?? '')
    expect(rowTitles().some((t) => t.includes('AI4S 的对话'))).toBe(true)
    expect(rowTitles().some((t) => t.includes('MITO 的对话'))).toBe(false)

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'mito' } })

    await waitFor(() =>
      expect(rowTitles().some((t) => t.includes('MITO 的对话'))).toBe(true),
    )
    expect(rowTitles().some((t) => t.includes('AI4S 的对话'))).toBe(false)
  })
})
