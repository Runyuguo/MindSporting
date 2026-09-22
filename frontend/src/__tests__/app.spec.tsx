import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import type { Hit } from '../lib/events'
import {
  DEFAULT_LAYOUT, MAX_WIDTH, MIN_WIDTH, SEPARATOR_COUNT, SEPARATOR_WIDTH, STEP,
} from '../lib/layout'

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

/** 手动可控的 SSE 流：用于构造「请求仍在飞」的中间态（sseResponse 会立即关闭）。 */
function controlledStream() {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c
    },
  })
  return {
    stream,
    push: (frame: string) => ctrl.enqueue(enc.encode(frame)),
    close: () => ctrl.close(),
  }
}

/** 视口桩：四栏与内联证据都挂在这一个断点上，故宽/窄必须显式钉住。 */
function stubViewport(wide: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: wide && q.includes('min-width: 1280px'),
    media: q,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }))
}

/** 宽屏视口：四栏挂载、内联证据被抑制。 */
function stubWideViewport() {
  stubViewport(true)
}

/**
 * 窄屏视口：只有对话栏 + 内联证据（spec §6：更窄的宽度不在承诺范围）。
 * 必须**显式**桩成窄屏 —— 否则本文件里前一条用例留下的宽屏 `matchMedia` 桩会让
 * 「窄屏」用例其实跑在宽屏下（`restoreAllMocks` 不撤销 `stubGlobal`）。
 */
function stubNarrowViewport() {
  stubViewport(false)
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}

/** 生成参数能力答复（T49 `/capabilities`）：宽屏功能栏挂载时 App 会取一次。 */
const CAPABILITIES = jsonResponse({
  lib: 'ai4s',
  params: { divergence: true, length: true },
})

/**
 * 宽屏 App 的渲染：**必须**把挂载期那次 `/capabilities` 请求冲干净。
 *
 * T49 之前宽屏渲染没有任何挂载期请求，故这里的用例都是同步的；现在 App 挂载时会取一次
 * 生成参数能力（滑杆的「已生效 / 未生效」标注由它驱动）。迟到的 setState 若落在
 * `act` 之外，React 会打出「not wrapped in act(...)」警告 —— 冲一下即可，
 * 断言与行为都不变。用例若自己 stubGlobal('fetch', ...)，请用 `queueFetch` / `routedFetch`。
 */
async function renderWideApp() {
  const utils = render(<App />)
  await act(async () => {})
  return utils
}

/**
 * 把「按序返回的响应」与挂载期的 `/capabilities` 请求分开：
 * 能力请求不占用例的响应序号（否则它会吃掉第一问的桩，用例会以一个**错位的**答复变红）。
 */
function queueFetch(queue: Response[]) {
  let next = 0
  return vi.fn((url: string) =>
    String(url).startsWith('/capabilities')
      ? Promise.resolve(CAPABILITIES)
      : Promise.resolve(queue[next++]),
  )
}

const REM = 16

/**
 * 栏宽的**生效值**（px）：只认 state 驱动的行内 `style.width`。
 *
 * 003 起栏宽可拖、可折叠，宽度真值在 `useLayout`（`lib/layout.ts`）。此前这里解析类名里的
 * `w-[…rem]`，而类名宽只是 flex base size 的一个声明：它既不反映夹紧/折叠，也会在实现
 * 退回固定宽度时**照样变绿**（上一版 I3「修复」正是这样骗过复审的）。故一律读生效值，
 * 并且在它不是行内 px 值时报错——静默返回 0 会让「宽度没接上 state」变成一条假绿。
 */
function effectiveWidthPx(el: HTMLElement): number {
  const raw = el.style.width
  if (!raw.endsWith('px')) {
    throw new Error(`${el.dataset.testid} 的宽度不是 state 驱动的行内 px 值：'${raw}'`)
  }
  return Number(raw.slice(0, -2))
}

/**
 * jsdom 的两个 Pointer Events 缺口，只补到「拖动能跑」为止（两者都是环境缺口，
 * 不是产品行为——真实浏览器原生具备）：
 *
 * 1. `window.PointerEvent` 不存在 ⇒ `fireEvent.pointerDown/Move` 退化为 `Event`，
 *    `clientX` 被**静默丢掉**：拖动位移成了 NaN，看起来像「拖不动」，实际是环境没给坐标；
 * 2. 指针捕获的三个方法不存在，而分隔线靠捕获保证拖动中途指针移出元素也不断线。
 *
 * 拖动逻辑本身（步长、双击、键盘）由 `columnDivider.spec.tsx` 覆盖；本文件只在
 * **接线**层面用它（拖动 → state → 生效宽）。
 */
function stubPointerEvents() {
  const w = window as unknown as Record<string, unknown>
  if (typeof w.PointerEvent === 'undefined') {
    class PointerEventPolyfill extends MouseEvent {
      pointerId: number
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init)
        this.pointerId = init.pointerId ?? 0
      }
    }
    vi.stubGlobal('PointerEvent', PointerEventPolyfill)
  }
  const proto = Element.prototype as unknown as Record<string, unknown>
  proto.setPointerCapture = () => {}
  proto.hasPointerCapture = () => false
  proto.releasePointerCapture = () => {}
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

/** 题目的元数据字段（source/ref 语义随来源不同，见 index 的 ref 约定）。 */
const meta = (rowid: number, source: string, ref: string) => ({
  rowid,
  source,
  ref,
  title: `条目 ${rowid}`,
  category: '',
  extra: '',
  snippet: '…',
  score: 0.8,
})

/** `/doc` 的正常响应：面板进入 `doc-ready` 后即以此为判据。 */
function docOkBody(ref: string) {
  return {
    lib: 'ai4s',
    ref,
    title: '线粒体自噬',
    content: '# 原文正文\n\n正文段落',
    mtime: 1,
  }
}

/**
 * `fetch` 桩：`/capabilities` 固定答复（宽屏挂载期的能力请求，T49），
 * `/doc` 走给定响应，其余（`/ask/stream`）逐次给出 SSE 帧序列。
 * 每个响应都是**新的**流——同一个 `ReadableStream` 不可被两个请求复用。
 */
function routedFetch(rounds: string[][], docResponse: () => Promise<Response> | Response) {
  let call = 0
  return vi.fn((url: string) => {
    if (String(url).startsWith('/capabilities')) return Promise.resolve(CAPABILITIES)
    if (String(url).startsWith('/doc')) return Promise.resolve(docResponse())
    const frames = rounds[call++] ?? rounds.at(-1) ?? []
    return Promise.resolve(sseResponse(...frames))
  })
}

/** 读当前库已留存的那条对话（C1 的「首屏」断言就从存储里看）。 */
function storedConversations(lib = 'ai4s') {
  const raw = localStorage.getItem(`ragqa:conv:${lib}`)
  return raw === null ? [] : (JSON.parse(raw) as { id: string; title: string; messages: { role: string; content: string }[] }[])
}

describe('App', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
  })

  // 泄漏防护：`restoreAllMocks` 不撤销 `stubGlobal`，本仓库又未开 unstubGlobals。
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the product name', () => {
    render(<App />)
    expect(screen.getByText('思维游乐场')).toBeInTheDocument()
  })

  it('offers both libraries and defaults to AI4S', () => {
    render(<App />)
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('ai4s')
    expect(screen.getByRole('option', { name: /Mitochondria/ })).toBeInTheDocument()
  })

  it('completes a full round: evidence then answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse(
          'event: evidence\ndata: {"lib":"ai4s","query":"q","hits":[{"rowid":1,"source":"vault:note","ref":"a.md","title":"线粒体自噬","category":"","extra":"","snippet":"…","score":0.8}]}\n\n',
          'event: answer\ndata: {"delta":"结论"}\n\n',
          'event: done\ndata: {}\n\n',
        ),
      ),
    )
    render(<App />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '线粒体自噬' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })

    await waitFor(() => expect(screen.getByText('依据来源')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('结论')).toBeInTheDocument())
  })

  it('toggles the theme and persists it', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /主题/ }))
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  // T31：主题按钮显示**当前**态（深色 ⇒「暗」），切换后随之变成「明」。
  it('theme button shows the current theme as 暗 / 明', () => {
    render(<App />)
    const button = () => screen.getByRole('button', { name: /主题/ })

    expect(button().textContent).toBe('暗')
    fireEvent.click(button())
    expect(button().textContent).toBe('明')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  it('shows the 未找到依据 empty state when a round returns no hits', async () => {
    // spec「依据问题召回证据 · 无相关内容（边界）」要求界面呈现该空态。
    // EvidenceList 在 hits 为空且未传 emptyLabel 时返回 null——必须显式传。
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      sseResponse(
        'event: evidence\ndata: {"lib":"ai4s","query":"q","hits":[]}\n\n',
        'event: answer\ndata: {"delta":"无依据"}\n\n',
        'event: done\ndata: {}\n\n',
      ),
    ))
    render(<App />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '不存在的话题' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    await waitFor(() => expect(screen.getByText('未找到依据')).toBeInTheDocument())
  })

  it('occupies the full viewport (spec「桌面全屏布局」)', () => {
    const { container } = render(<App />)
    const shell = container.firstElementChild as HTMLElement
    // 外壳必须是全视口高度、不套居中窄容器
    expect(shell.className).toContain('h-dvh')
    expect(shell.className).toContain('w-full')
    expect(shell.className).not.toMatch(/max-w-(xl|2xl|3xl|4xl|5xl|6xl|7xl)/)
  })

  it('renders a dedicated evidence panel only on wide viewports', async () => {
    stubWideViewport()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      sseResponse(
        'event: evidence\ndata: {"lib":"ai4s","query":"q","hits":[{"rowid":1,"source":"vault:note","ref":"a.md","title":"线粒体自噬","category":"","extra":"","snippet":"…","score":0.8}]}\n\n',
        'event: done\ndata: {}\n\n',
      ),
    ))
    const { container } = render(<App />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '自噬' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })

    await waitFor(() =>
      expect(container.querySelector('[data-testid="evidence-panel"]')).not.toBeNull(),
    )
  })

  it('shows the 未找到依据 empty state on wide viewports too', async () => {
    // 宽屏走 EvidencePanel（内联证据被 showInlineEvidence={!wide} 抑制）。
    // 侧栏若在零命中时返回 null，则本任务交付的桌面布局上永远看不到这个空态，
    // 而窄屏能看到——同一功能在两种视口下行为不一致。
    stubWideViewport()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      sseResponse(
        'event: evidence\ndata: {"lib":"ai4s","query":"q","hits":[]}\n\n',
        'event: done\ndata: {}\n\n',
      ),
    ))
    const { container } = render(<App />)
    // 还没问过任何一轮时不得出现空态：useChat 在「尚未提问」与「零命中」下 evidence 都是 []，
    // 无条件传 emptyLabel 会让首次进入宽屏页面就谎报「未找到依据」。
    expect(screen.queryByText('未找到依据')).toBeNull()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '不存在的话题' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })

    await waitFor(() => expect(screen.getByText('未找到依据')).toBeInTheDocument())
    expect(container.querySelector('[data-testid="evidence-panel"]')).not.toBeNull()
  })

  it('keeps the wide-viewport sidebar mounted with a neutral placeholder before any round', async () => {
    // 宽屏 + 恢复的会话里只有消息、没有逐轮依据（会话已留存，依据尚未记录）。
    // 侧栏必须常驻——既不能把两栏塌成一栏（刷新即布局跳变），也不能谎报「未找到依据」。
    // T29 起种子走会话键（`ragqa:<lib>` 扁平键是退役存储，只在迁移里出现）。
    const now = Date.now()
    localStorage.setItem(
      'ragqa:conv:ai4s',
      JSON.stringify([
        {
          id: 'c1',
          title: '上一轮的旧问题',
          createdAt: now,
          updatedAt: now,
          messages: [
            { role: 'user', content: '上一轮的旧问题' },
            { role: 'assistant', content: '上一轮的旧答案' },
          ],
          evidenceByRound: {},
        },
      ]),
    )
    localStorage.setItem('ragqa:current:ai4s', 'c1')
    stubWideViewport()
    const { container } = await renderWideApp()

    expect(screen.getByText('上一轮的旧答案')).toBeInTheDocument()
    expect(container.querySelector('[data-testid="evidence-panel"]')).not.toBeNull()
    expect(screen.getByText('提问后这里会显示依据来源')).toBeInTheDocument()
    expect(screen.queryByText('未找到依据')).toBeNull()
  })

  // T25：检索期间依据栏**不**出现空窗，也不得把「还在查」谎报成「查了但没有」。
  it('does not claim 未找到依据 while the first round is still retrieving', async () => {
    stubWideViewport()
    const { stream, push, close } = controlledStream()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, body: stream } as unknown as Response),
    )

    render(<App />)
    expect(screen.getByText('提问后这里会显示依据来源')).toBeInTheDocument()
    expect(screen.queryByText('未找到依据')).toBeNull()

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '不存在的话题' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })

    // 该轮尚未返回任何 evidence：明确标示检索中，而不是宣称「未找到依据」
    await waitFor(() => expect(screen.getByText('正在检索依据…')).toBeInTheDocument())
    expect(screen.queryByText('未找到依据')).toBeNull()

    await act(async () => {
      push(evidenceFrame()) // 这一轮零命中
      push('event: done\ndata: {}\n\n')
      close()
    })
    await waitFor(() => expect(screen.getByText('未找到依据')).toBeInTheDocument())
    expect(screen.queryByText('正在检索依据…')).toBeNull()
  })

  // T25：点选某一轮提问 → 只显示该轮留存命中（并可看出已筛选）；再次点选 → 恢复全部。
  it('filters the evidence panel by round and restores the accumulated view', async () => {
    stubWideViewport()
    vi.stubGlobal(
      'fetch',
      queueFetch([
        sseResponse(evidenceFrame(hit(1, '第一条依据')), 'event: done\ndata: {}\n\n'),
        sseResponse(evidenceFrame(hit(2, '第二条依据')), 'event: done\ndata: {}\n\n'),
      ]),
    )

    await renderWideApp()
    const ask = (text: string) => {
      fireEvent.change(screen.getByRole('textbox'), { target: { value: text } })
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    }

    ask('第一问')
    await waitFor(() => expect(screen.getByText('第一条依据')).toBeInTheDocument())
    ask('第二问')
    await waitFor(() => expect(screen.getByText('第二条依据')).toBeInTheDocument())
    // 新命中到达后显示切到新一轮：上一轮的命中不再显示（但已留存，可点回）
    expect(screen.queryByText('第一条依据')).toBeNull()

    const roundOne = screen.getByRole('button', { name: /第\s*1\s*轮/ })
    // 轮次键 = 该提问是第几条 user 消息（0 起），与 useChat 的归档规则同一套
    expect(roundOne).toHaveAttribute('data-round', '0')
    fireEvent.click(roundOne)
    await waitFor(() => expect(screen.getByText('第一条依据')).toBeInTheDocument())
    expect(screen.queryByText('第二条依据')).toBeNull()
    expect(screen.getByText(/已筛选依据/)).toBeInTheDocument()
    expect(roundOne).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(roundOne)
    await waitFor(() => expect(screen.getByText('第二条依据')).toBeInTheDocument())
    expect(screen.getByText('第一条依据')).toBeInTheDocument()
  })

  // 复审 ①：spec scenario 1 的完整要求是「上一轮依据仍在 **并明确标示正在检索新一轮**」。
  // 有旧命中时侧栏走卡片分支，若标记只挂在空态分支上，核心情形反而看不到「正在检索」。
  it('flags the new round as retrieving while the previous hits stay visible', async () => {
    stubWideViewport()
    const { stream, push, close } = controlledStream()
    vi.stubGlobal(
      'fetch',
      queueFetch([
        sseResponse(evidenceFrame(hit(1, '第一条依据')), 'event: done\ndata: {}\n\n'),
        { ok: true, status: 200, body: stream } as unknown as Response,
      ]),
    )

    await renderWideApp()
    const ask = (text: string) => {
      fireEvent.change(screen.getByRole('textbox'), { target: { value: text } })
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    }

    ask('第一问')
    await waitFor(() => expect(screen.getByText('第一条依据')).toBeInTheDocument())
    expect(screen.queryByText('正在检索新一轮…')).toBeNull()

    ask('第二问')
    await waitFor(() => expect(screen.getByText('正在检索新一轮…')).toBeInTheDocument())
    // 标记要能读屏获知，且与上一轮命中**同时**在场
    expect(screen.getByText('正在检索新一轮…')).toHaveAttribute('role', 'status')
    expect(screen.getByText('第一条依据')).toBeInTheDocument()

    await act(async () => {
      push('event: done\ndata: {}\n\n')
      close()
    })
    await waitFor(() => expect(screen.queryByText('正在检索新一轮…')).toBeNull())
    // 本轮没有 evidence 事件：上一轮命中依然在（检索期间从未出现空窗）
    expect(screen.getByText('第一条依据')).toBeInTheDocument()
  })

  // 复审 ①：窄屏走内联证据，标记同样不能只在空态里出现。
  it('flags the retrieving round in the inline evidence list on narrow viewports', async () => {
    stubNarrowViewport()
    const { stream, push, close } = controlledStream()
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          sseResponse(evidenceFrame(hit(1, '第一条依据')), 'event: done\ndata: {}\n\n'),
        )
        .mockResolvedValueOnce({ ok: true, status: 200, body: stream } as unknown as Response),
    )

    const { container } = render(<App />)
    // 真的跑在窄屏路径上：没有依据侧栏（否则本用例此前一直是继承宽屏桩在跑）
    expect(container.querySelector('[data-testid="evidence-panel"]')).toBeNull()
    const ask = (text: string) => {
      fireEvent.change(screen.getByRole('textbox'), { target: { value: text } })
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    }

    ask('第一问')
    await waitFor(() => expect(screen.getByText('第一条依据')).toBeInTheDocument())

    ask('第二问')
    await waitFor(() => expect(screen.getByText('正在检索新一轮…')).toBeInTheDocument())
    expect(screen.getByText('第一条依据')).toBeInTheDocument()

    await act(async () => {
      push('event: done\ndata: {}\n\n')
      close()
    })
    await waitFor(() => expect(screen.queryByText('正在检索新一轮…')).toBeNull())
  })

  // 复审 Minor ②：上一显示轮**零命中**时，标记与空态结论必须**并存**。只看「未找到依据」
  // 会读成「新问题已经查过了、没找到」，而其实新一轮还在查。
  it('shows the retrieving marker alongside 未找到依据 while the next round is retrieving', async () => {
    stubWideViewport()
    const { stream, push, close } = controlledStream()
    vi.stubGlobal(
      'fetch',
      queueFetch([
        sseResponse(evidenceFrame(), 'event: done\ndata: {}\n\n'),
        { ok: true, status: 200, body: stream } as unknown as Response,
      ]),
    )

    await renderWideApp()
    // 未提问过：仍是中性占位，不得被这轮改动带出「未找到依据」
    expect(screen.getByText('提问后这里会显示依据来源')).toBeInTheDocument()

    const ask = (text: string) => {
      fireEvent.change(screen.getByRole('textbox'), { target: { value: text } })
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    }

    ask('第一问')
    await waitFor(() => expect(screen.getByText('未找到依据')).toBeInTheDocument())
    expect(screen.queryByText('正在检索新一轮…')).toBeNull()

    ask('第二问')
    await waitFor(() => expect(screen.getByText('正在检索新一轮…')).toBeInTheDocument())
    // 并存：标记载荷「正在检索」，空态载荷上一轮「没找到」的结论
    expect(screen.getByText('未找到依据')).toBeInTheDocument()
    expect(screen.queryByText('提问后这里会显示依据来源')).toBeNull()

    await act(async () => {
      push(evidenceFrame(hit(1, '第一条依据')))
      push('event: done\ndata: {}\n\n')
      close()
    })
    await waitFor(() => expect(screen.getByText('第一条依据')).toBeInTheDocument())
    expect(screen.queryByText('正在检索新一轮…')).toBeNull()
  })

  // 复审 Minor ②：窄屏内联路径同理（标记与内联的「未找到依据」并存）。
  it('shows the retrieving marker alongside the inline 未找到依据 on narrow viewports', async () => {
    stubNarrowViewport()
    const { stream, push, close } = controlledStream()
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(sseResponse(evidenceFrame(), 'event: done\ndata: {}\n\n'))
        .mockResolvedValueOnce({ ok: true, status: 200, body: stream } as unknown as Response),
    )

    const { container } = render(<App />)
    expect(container.querySelector('[data-testid="evidence-panel"]')).toBeNull()
    const ask = (text: string) => {
      fireEvent.change(screen.getByRole('textbox'), { target: { value: text } })
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    }

    ask('第一问')
    await waitFor(() => expect(screen.getByText('未找到依据')).toBeInTheDocument())

    ask('第二问')
    await waitFor(() => expect(screen.getByText('正在检索新一轮…')).toBeInTheDocument())
    expect(screen.getByText('未找到依据')).toBeInTheDocument()

    await act(async () => {
      push('event: done\ndata: {}\n\n')
      close()
    })
    await waitFor(() => expect(screen.queryByText('正在检索新一轮…')).toBeNull())
  })

  // ---- T29: 四栏工作台装配 --------------------------------------------------
  // 四栏的 DOM 顺序（plan §12.4）：功能栏 · 对话栏 · 依据栏 · 文献卡栏。
  const COLUMN_ORDER = ['function-rail', 'chat-column', 'evidence-panel', 'doc-panel']

  it('assembles the four columns in DOM order on wide viewports', async () => {
    stubWideViewport()
    const { container } = await renderWideApp()

    for (const id of COLUMN_ORDER) {
      expect(container.querySelector(`[data-testid="${id}"]`)).not.toBeNull()
    }
    // DOM 顺序（不是「都在场」）：少一栏、顺序错了都算红
    const present = Array.from(container.querySelectorAll('[data-testid]'))
      .map((el) => el.getAttribute('data-testid'))
      .filter((id): id is string => id !== null && COLUMN_ORDER.includes(id))
    expect(present).toEqual(COLUMN_ORDER)

    // 宽度按 state 的默认布局（plan §12.4 的基准步进）：功能栏 18rem、依据栏 18rem、
    // 文献卡栏 20rem。断言**生效宽**（行内 style）而不是类名：类名宽在 003 里已不是宽度
    // 的真值（拖动/夹紧/折叠都只改 state）。
    const rail = container.querySelector('[data-testid="function-rail"]') as HTMLElement
    const evidence = container.querySelector('[data-testid="evidence-panel"]') as HTMLElement
    const docPanel = container.querySelector('[data-testid="doc-panel"]') as HTMLElement
    expect(rail.className).toContain('shrink-0')
    expect(effectiveWidthPx(rail)).toBe(DEFAULT_LAYOUT.rail.width)
    expect(effectiveWidthPx(evidence)).toBe(DEFAULT_LAYOUT.evidence.width)
    expect(effectiveWidthPx(docPanel)).toBe(DEFAULT_LAYOUT.doc.width)
    // 旧机制必须退场：留着 `w-[…]` 类名宽就是与 state 打架的第二套宽度声明
    for (const el of [rail, evidence, docPanel]) {
      expect(el.className, `${el.dataset.testid} 不该再声明类名宽`).not.toMatch(/(^|\s)(2xl:)?w-\[/)
    }
  })

  it('does not mount the columns below the breakpoint (spec §6：窄屏不在承诺范围)', () => {
    stubNarrowViewport()
    const { container } = render(<App />)

    // 窄屏只有对话栏 + 内联证据；不专门做窄屏降级布局，但也不能崩
    expect(container.querySelector('[data-testid="chat-column"]')).not.toBeNull()
    for (const id of ['function-rail', 'evidence-panel', 'doc-panel']) {
      expect(container.querySelector(`[data-testid="${id}"]`)).toBeNull()
    }
  })

  it('opens the selected evidence in the doc panel and closes it when deselected', async () => {
    stubWideViewport()
    const docBody = {
      lib: 'ai4s',
      ref: '01-Literature/1.md',
      title: '线粒体自噬',
      content: '# 原文正文\n\n正文段落',
      mtime: 1,
    }
    const fetchMock = vi.fn((url: string) => {
      if (String(url).startsWith('/doc')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => docBody,
        } as unknown as Response)
      }
      return Promise.resolve(
        sseResponse(
          evidenceFrame(hit(1, '第一条依据')),
          'event: answer\ndata: {"delta":"结论"}\n\n',
          'event: done\ndata: {}\n\n',
        ),
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)
    // 未选中篇目：文献卡栏常驻并显示中性提示（不是空白）
    expect(screen.getByTestId('doc-idle')).toBeInTheDocument()

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '自噬' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    await waitFor(() => expect(screen.getByText('第一条依据')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /第一条依据/ }))
    await waitFor(() => expect(screen.getByTestId('doc-ready')).toBeInTheDocument())
    expect(screen.getByText('正文段落')).toBeInTheDocument()

    // 取文请求带着当前库与命中条目的 ref
    const docCall = fetchMock.mock.calls.find((c) => String(c[0]).startsWith('/doc'))
    expect(String(docCall?.[0])).toContain('lib=ai4s')
    expect(String(docCall?.[0])).toContain(encodeURIComponent('01-Literature/1.md'))

    // 再次点选同一条 = 取消选中 → 关闭文献卡
    fireEvent.click(screen.getByRole('button', { name: /第一条依据/ }))
    await waitFor(() => expect(screen.getByTestId('doc-idle')).toBeInTheDocument())
  })

  // C1（整支复审 Critical·数据丢失）：提交即留存。此前只在流结束时落盘，切走对话
  // 会中止在飞请求而 `finally` 正确地拒绝写入 ⇒ **用户自己刚问的问题一个字都没留下**，
  // 且不显示任何错误（静默失败），直接违反 SC-14。
  it('提交后切走对话：问题仍在原对话里留存且有痕迹（C1）', async () => {
    stubWideViewport()
    const { stream } = controlledStream()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, body: stream } as unknown as Response),
    )

    await renderWideApp()
    const existingId = storedConversations()[0].id

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '首屏必须留住的问题' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })

    // 首帧还没回来就切走（新建对话）：在飞请求被中止
    fireEvent.click(screen.getByTestId('new-conversation'))

    const old = storedConversations().find((c) => c.id === existingId)
    expect(old).toBeDefined()
    expect(old?.messages.map((m) => m.content)).toContain('首屏必须留住的问题')
    // 标题随首条 user 消息生成：不能停留在「新对话」（那等于没有痕迹）
    expect(old?.title).toBe('首屏必须留住的问题')
    // 尾部不留空助手占位（否则重载会多出一个空白气泡）
    expect(old?.messages.at(-1)?.role).not.toBe('assistant')
  })

  // I1（整支复审 Important）：✕ 只关面板不清选中态 ⇒ 卡片仍带选中样式、
  // 且再点它是「取消选中」而不是重新打开（要三次点击才回得来）。
  it('关闭文献卡同时清掉选中态，再点同一张卡可重新打开（I1）', async () => {
    stubWideViewport()
    vi.stubGlobal(
      'fetch',
      routedFetch([[evidenceFrame(hit(1, '第一条依据')), 'event: done\ndata: {}\n\n']], () =>
        Promise.resolve({ ok: true, status: 200, json: async () => docOkBody('01-Literature/1.md') } as unknown as Response),
      ),
    )

    render(<App />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '自噬' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    await waitFor(() => expect(screen.getByText('第一条依据')).toBeInTheDocument())

    const card = () => screen.getByRole('button', { name: /第一条依据/ })
    fireEvent.click(card())
    await waitFor(() => expect(screen.getByTestId('doc-ready')).toBeInTheDocument())
    expect(card()).toHaveAttribute('aria-pressed', 'true')

    // 关掉面板：选中态必须一并清掉，否则卡片继续「看起来还开着」
    fireEvent.click(screen.getByRole('button', { name: '关闭文献卡' }))
    await waitFor(() => expect(screen.getByTestId('doc-idle')).toBeInTheDocument())
    expect(card()).toHaveAttribute('aria-pressed', 'false')

    // 再点同一条 = 重新打开（而不是取消选中）
    fireEvent.click(card())
    await waitFor(() => expect(screen.getByTestId('doc-ready')).toBeInTheDocument())
    expect(card()).toHaveAttribute('aria-pressed', 'true')
  })

  // I2（整支复审 Important）：`metadata` / `pdf` / `weekly` 的 `ref` 不是 vault 相对
  // `.md` 路径（分别是 PMID / txt 文件名），点它们只会得到 400「该路径不在本库范围内」
  // —— 事实错误且把责任推给了使用者。非 vault 来源没有可读原文，必须如实说明。
  it('非 vault 来源的卡片不冒称可读原文，也不打开文献卡（I2）', async () => {
    stubWideViewport()
    const docSpy = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: async () => docOkBody('12345678') } as unknown as Response),
    )
    vi.stubGlobal(
      'fetch',
      routedFetch(
        [
          [
            `event: evidence\ndata: ${JSON.stringify({
              lib: 'ai4s',
              query: 'q',
              hits: [meta(1, 'metadata', '12345678'), hit(2, '第二条依据')],
            })}\n\n`,
            'event: done\ndata: {}\n\n',
          ],
        ],
        docSpy,
      ),
    )

    render(<App />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '自噬' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    await waitFor(() => expect(screen.getByText('条目 1')).toBeInTheDocument())

    // 非 vault 来源：没有可点的入口（点它本就会得到 400「不在本库范围内」——那是错的）
    expect(screen.queryByRole('button', { name: /条目 1/ })).toBeNull()
    // 但必须如实说明，而不是留一张沉默的卡
    expect(screen.getByText(/没有可读原文/)).toBeInTheDocument()
    expect(docSpy).not.toHaveBeenCalled()

    // vault 来源仍然可点、仍能打开原文（不能顺手把整个入口关掉）
    fireEvent.click(screen.getByRole('button', { name: /第二条依据/ }))
    await waitFor(() => expect(screen.getByTestId('doc-ready')).toBeInTheDocument())
  })

  // I3（整支复审 Important，003 起重写）：上一版修复给右两栏加了 `min-w-[18rem]` /
  // `min-w-[20rem]`，但两栏同时带 `shrink-0` —— 此时 used flex size 就是 flex **base**
  // size（`w-[22rem]` / `w-[28rem]`），`min-width` 永远绑不住。于是 1280px 下对话栏
  // 仍是 1280 − 288 − 352 − 448 = **192px**，承诺在自己的边界上不成立。
  //
  // 003 把宽度交给 state（`useLayout`）：下限由 `clampWidth` 在**状态层**保证 —— 低于
  // 可读下限即折叠为关闭态，不存在「被压成细缝」的中间态。故本用例断言两件事：
  // ① 三栏的**生效宽**就是各自下限，1280px 的算术仍给对话栏 ≥20rem；
  // ② DOM 上没有第二套宽度声明（类名宽 / 绑不住的 `min-w-[…]`）与 state 打架。
  it('1280px 承诺边界上对话栏仍有可读宽度（生效宽由 state 驱动，下限真的绑得住）（I3）', async () => {
    stubWideViewport()
    const { container } = await renderWideApp()

    const widthOf = (id: string) =>
      effectiveWidthPx(container.querySelector(`[data-testid="${id}"]`) as HTMLElement)

    // 承诺边界（plan §12.4）：三栏各占自己的可读下限，三条分隔线各占 4px，剩下的才是对话栏。
    // 1280 − (288+288+320) − 3×4 = 372px ≥ 20rem ⇒ spec §4「各栏内容可读」成立。
    // 注：早期版本漏算了 12px 的分隔线占位、断成 384px（复审 Minor #1），这里按真实占用改。
    const computed =
      1280 - widthOf('function-rail') - widthOf('evidence-panel') - widthOf('doc-panel')
      - SEPARATOR_WIDTH * SEPARATOR_COUNT
    expect(computed, `1280px 下对话栏仅 ${computed}px`).toBe(1280 - 288 - 288 - 320 - 12)
    expect(computed).toBeGreaterThanOrEqual(20 * REM)

    // 每栏生效宽 ≥ 自己的可读下限。003 的下限不是 `min-width`，而是夹紧后的宽度本身；
    // 三者都必须为真，否则「有下限」只是文字承诺。
    expect(widthOf('function-rail')).toBeGreaterThanOrEqual(MIN_WIDTH.rail)
    expect(widthOf('evidence-panel')).toBeGreaterThanOrEqual(MIN_WIDTH.evidence)
    expect(widthOf('doc-panel')).toBeGreaterThanOrEqual(MIN_WIDTH.doc)

    // 固定宽的三栏：行内宽即 used width
    // （对话栏与文献卡栏自 2026-09-19 起换了角色，见下一条用例的说明）
    for (const id of ['function-rail', 'evidence-panel']) {
      const el = container.querySelector(`[data-testid="${id}"]`) as HTMLElement
      // 不收缩：行内宽即 used width（允许收缩就会把下限吃掉）
      expect(el.className).toContain('shrink-0')
      // 不依赖绑不住的下限（上一版 I3 的失效点）
      const floors = el.className.split(/\s+/).filter((c) => c.startsWith('min-w-['))
      expect(floors, `${id} 不该依赖绑不住的下限`).toEqual([])
      // 也没有与 state 打架的类名宽
      expect(el.className, `${id} 不该再声明类名宽`).not.toMatch(/(^|\s)(2xl:)?w-\[/)
    }
  })

  // 2026-09-19（使用者实测「分隔线拖不过中线」）：**对话栏与文献卡栏的角色对调了**。
  // 原先对话栏是 `flex-1`（宽度 = 容器剩余全部空间），与 `layout.chat.width` 无关 ⇒
  // "把空间让给对话栏"在界面上完全看不出来，拖动到某一侧就像撞墙。
  // 现在：对话栏按 state 宽度实际渲染（`shrink-0` + 行内 width + 行内 minWidth 兜底），
  // 由**文献卡栏**吸收剩余空间。本条钉住这三件事各自落在 DOM 上。
  it('对话栏宽度由 state 驱动（可被拖动改变），剩余空间由文献卡栏吸收', async () => {
    stubWideViewport()
    const { container } = await renderWideApp()

    const chatEl = container.querySelector('[data-testid="chat-column"]') as HTMLElement
    // ① 对话栏不再是 `flex-1`：否则 state 里的宽度对渲染无效，拖动看不出来
    expect(chatEl.className).not.toContain('flex-1')
    expect(chatEl.className).toContain('shrink-0')
    // ② 宽度真的由 state 驱动，且下限以**行内** minWidth 声明（不是绑不住的 min-w-[…]）
    expect(chatEl.style.width).toMatch(/^\d+px$/)
    expect(chatEl.style.minWidth).toBe(`${MIN_WIDTH.chat}px`)

    const docEl = container.querySelector('[data-testid="doc-panel"]') as HTMLElement
    // ③ 吸收剩余空间的角色在文献卡栏；`min-w-0` 让它不至于把别的栏挤出去
    expect(docEl.className).toContain('flex-1')
    expect(docEl.className).toContain('min-w-0')
  })

  // 复审 Important #1（T51）：另三栏 `shrink-0`，对话栏是唯一可被压缩的一栏（`flex-1`）——
  // 三栏之和一旦过大，对话栏就一路被压到 0px（内容仍挂载、仍可 Tab 聚焦）。
  // 本条钉住两半（**注意 jsdom 没有布局引擎**：这里能证明的是「声明在 DOM 上」与
  // 「单栏有上限」，真正的「绑得住」由浏览器布局保证，不是这里断言的）：
  // ① 下限以**行内 min-width** 落在 DOM 上（对 `flex-1` 有效；`min-w-[…]` 类名在 `shrink-0`
  //    之下才绑不住，那条禁令见上面的 I3 用例）；
  // ② 向外拖动时单栏**有上限**（`MAX_WIDTH`），不会让某栏涨到几千像素反过来挤对话栏。
  it('对话栏的下限声明在 DOM 上，且单栏向外拖动有上限（下限声明 + 上限）', async () => {
    stubWideViewport()
    stubPointerEvents() // jsdom 无指针捕获方法；不补会在 pointerDown 处抛未处理错误
    const { container, getByTestId } = await renderWideApp()

    // ① 下限进了 DOM
    const chatEl = container.querySelector('[data-testid="chat-column"]') as HTMLElement
    expect(chatEl.style.minWidth).toBe(`${MIN_WIDTH.chat}px`)

    // ② 分隔线**右移**（指针向右）= 让位给左边的 rail：rail 只能长到上限为止，不会涨到几千像素
    const sep = getByTestId('divider-rail-chat')
    fireEvent.pointerDown(sep, { pointerId: 1, clientX: -3500 })
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 500 })
    fireEvent.pointerUp(sep, { pointerId: 1, clientX: 500 })

    const rail = container.querySelector('[data-testid="function-rail"]') as HTMLElement | null
    expect(rail, 'rail 不该因为拖动而消失').not.toBeNull()
    expect(effectiveWidthPx(rail!)).toBe(MAX_WIDTH)   // 长到上限即停，不再无限增长
  })

  // ---- 003 · T51：栏宽（分隔线 + state 驱动） ---------------------------------
  // 分隔线本身（步长/双击/键盘）由 columnDivider.spec.tsx 覆盖；这里钉的是**接线**：
  // 拖动/按键真的改了栏的生效宽，双击真的回到默认，写失败真的被如实告知。

  it('拖动分隔线即时改变栏宽，双击回到默认宽度（spec「相邻栏合计不变」/「双击回到默认」）', async () => {
    stubWideViewport()
    stubPointerEvents()
    const { container } = await renderWideApp()
    const rail = () => container.querySelector('[data-testid="function-rail"]') as HTMLElement
    expect(effectiveWidthPx(rail())).toBe(DEFAULT_LAYOUT.rail.width)

    // 分隔线**跟着指针走**（SC-18「拖动后栏宽与指针意图一致」）：
    // 向右拖 = 让给左栏 ⇒ 功能栏变宽；向左拖 = 让给对话栏 ⇒ 功能栏变窄。
    const divider = screen.getByTestId('divider-rail-chat')
    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 468 })
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 500 })
    fireEvent.pointerUp(divider, { pointerId: 1, clientX: 500 })
    // 步长按 4px 阶梯取整（32 = 8×4），且**即时**反映到生效宽上
    expect(effectiveWidthPx(rail())).toBe(DEFAULT_LAYOUT.rail.width + 32)

    fireEvent.doubleClick(divider)
    expect(effectiveWidthPx(rail())).toBe(DEFAULT_LAYOUT.rail.width)
  })

  it('分隔线可用键盘调宽，Shift 为加速档（spec「分隔线可用键盘操作」）', async () => {
    stubWideViewport()
    const { container } = await renderWideApp()
    const rail = () => container.querySelector('[data-testid="function-rail"]') as HTMLElement
    const divider = screen.getByTestId('divider-rail-chat')

    // ArrowRight = 分隔线右移 = 功能栏变宽（与指针拖动同一方向语义）
    fireEvent.keyDown(divider, { key: 'ArrowRight' })
    expect(effectiveWidthPx(rail())).toBe(DEFAULT_LAYOUT.rail.width + 16)

    fireEvent.keyDown(divider, { key: 'ArrowRight', shiftKey: true })
    expect(effectiveWidthPx(rail())).toBe(DEFAULT_LAYOUT.rail.width + 16 + 64)
  })

  it('把栏拖过可读下限即折叠、且不再占位；拖不回来（恢复只经开关按钮，C-3）', async () => {
    stubWideViewport()
    stubPointerEvents()
    const { container } = await renderWideApp()
    const divider = screen.getByTestId('divider-rail-chat')

    // 向右拖 = 向左栏（功能栏）让位；要让功能栏**变窄**须把分隔线向**左**拖
    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 500 })
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: -4000 })
    fireEvent.pointerUp(divider, { pointerId: 1, clientX: -4000 })

    // 关闭态不占空间：那一栏与它的分隔线都不再渲染（width:0 的 aside 仍会被
    // border/padding 撑出一条空白占位）
    expect(container.querySelector('[data-testid="function-rail"]')).toBeNull()
    expect(screen.queryByTestId('divider-rail-chat')).toBeNull()
  })

  it('布局写入失败时如实告知「本次调整不会被记住」，可关闭（spec 边界 / 宪法 §4.3）', async () => {
    stubWideViewport()
    const store = localStorage
    const original = Storage.prototype.setItem
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(
      function (this: Storage, key: string, value: string) {
        // 只让布局键失败：主题键也走 setItem，若一并抛错会打断 App 自己的 effect
        if (key === 'ragqa:layout') throw new DOMException('QuotaExceededError')
        original.call(this ?? store, key, value)
      },
    )

    await renderWideApp()
    // 还没调整过：不得预警
    expect(screen.queryByText(/不会被记住/)).toBeNull()

    // ArrowRight = 分隔线右移 = 功能栏变宽（按错方向会把它折叠掉，见下一条用例）
    fireEvent.keyDown(screen.getByTestId('divider-rail-chat'), { key: 'ArrowRight' })
    // 写入失败 ⇒ 必须可见（使用者以为被记住的调整其实没被记住）
    expect(screen.getByText(/不会被记住/)).toBeInTheDocument()
    // 调整本身仍在当次会话内生效
    expect(
      effectiveWidthPx(screen.getByTestId('function-rail')),
    ).toBe(DEFAULT_LAYOUT.rail.width + 16)

    fireEvent.click(screen.getByRole('button', { name: '知道了' }))
    expect(screen.queryByText(/不会被记住/)).toBeNull()
    setItem.mockRestore()
  })

  // 回归钉（使用者 2026-09-19）：顺序恒为「提问 → 思考 → 回答」，且**每一轮**都如此。
  // 旧实现把思考面板挂在对话栏顶部（"绝对最新"），第二轮起它会跑到旧问答之上 ⇒ 顺序错。
  // 回归钉（SC-18「拖动后栏宽与指针意图一致」）：**向右**按键必须让左栏变宽。
  // ⚠️ 这条用例的存在本身有来历：早先 `applyPairResize` 的 delta 符号是反的
  // （把"指针右移"当成"把空间让给右栏"），于是向右拖反而把左栏收窄、`ArrowRight`
  // 一路把功能栏收成折叠；而当时的断言全都按反向写，整批把缺陷钉成了正确值。
  //
  // 这里只断言**宽度**（`ArrowRight` ⇒ 左栏 +STEP，`ArrowLeft` 回原位）。
  // 断言"分隔线自身的像素位置跟着右移"要读 `getBoundingClientRect()`，
  // 而 **jsdom 不做布局、所有矩形恒为 0**，在单测里写那条断言只会有两种结局：
  // 恒真（空转）或恒假（误报）。几何部分因此留给**浏览器活体验证**（真实指针拖动），
  // 不在这里伪造。
  it('键盘方向正确：ArrowRight 让左栏变宽，ArrowLeft 回原位（SC-18 方向）', async () => {
    stubWideViewport()
    const { container } = await renderWideApp()
    const rail = () => container.querySelector('[data-testid="function-rail"]') as HTMLElement
    const divider = screen.getByTestId('divider-rail-chat')
    const w0 = effectiveWidthPx(rail())

    fireEvent.keyDown(divider, { key: 'ArrowRight' })
    const w1 = effectiveWidthPx(rail())
    // 关键断言：向右 = 变**宽**（反的实现会把它收到折叠，这里会直接抛错）
    expect(w1).toBe(w0 + STEP)

    fireEvent.keyDown(divider, { key: 'ArrowLeft' })
    expect(effectiveWidthPx(rail())).toBe(w0)
  })

  // ---- 003 · T52：栏开关（标题后四个，恒在） -----------------------------------
  // 开关自身的渲染由 columnToggles.spec.tsx 覆盖；这里钉的是**接线**：点击真的开关了栏，
  // 恢复用的是默认宽度，且窄视口下开关仍在（spec C-2：窄视口唯一仍须成立的结构要求）。

  it('栏开关可关可开：关闭态不占位，再点以默认宽度恢复（spec「关闭与打开」/「由按钮恢复」）', async () => {
    stubWideViewport()
    const { container } = await renderWideApp()
    const toggle = screen.getByLabelText('文献卡栏')
    expect(toggle).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(toggle)
    expect(container.querySelector('[data-testid="doc-panel"]')).toBeNull()
    expect(toggle).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(toggle)
    const panel = container.querySelector('[data-testid="doc-panel"]') as HTMLElement
    expect(panel).not.toBeNull()
    // 以**默认宽度**回来（不是 0、也不是关闭前的残值）
    expect(effectiveWidthPx(panel)).toBe(DEFAULT_LAYOUT.doc.width)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
  })

  it('全部关闭（除对话栏）：对话栏仍可用，四个开关仍在（spec 边界 / C-2）', async () => {
    stubWideViewport()
    const { container } = await renderWideApp()
    for (const label of ['功能栏', '依据栏', '文献卡栏']) {
      fireEvent.click(screen.getByLabelText(label))
    }

    for (const id of ['function-rail', 'evidence-panel', 'doc-panel']) {
      expect(container.querySelector(`[data-testid="${id}"]`), `${id} 应已关闭`).toBeNull()
    }
    // 对话栏是唯一必需栏：仍在场且可用
    expect(container.querySelector('[data-testid="chat-column"]')).not.toBeNull()
    expect(screen.getByRole('textbox')).toBeInTheDocument()
    // 四个开关仍然可用 —— 否则被关掉的栏再也回不来
    for (const label of ['功能栏', '依据栏', '文献卡栏']) {
      expect(screen.getByLabelText(label)).toBeEnabled()
    }
    // 对话栏的开关禁用，但状态仍如实呈现「开着」
    expect(screen.getByLabelText('对话栏')).toBeDisabled()
    expect(screen.getByLabelText('对话栏')).toHaveAttribute('aria-pressed', 'true')
  })

  it('窄视口下四个栏开关仍在且可用（spec C-2）', () => {
    stubNarrowViewport()
    render(<App />)
    for (const label of ['功能栏', '依据栏', '文献卡栏']) {
      expect(screen.getByLabelText(label)).toBeEnabled()
    }
    expect(screen.getByLabelText('对话栏')).toBeDisabled()
  })
})

// ---- T47: 思考面板装配到对话栏 ------------------------------------------------
// 组件单测（thinkingPanel.spec.tsx）证明它**渲染得对**，但不能证明它**真的被挂上了**。
// 缺了这一条，`App.tsx` 里那次装配被删掉也不会有任何测试变红 —— 功能整体失效且不报错。
describe('思考面板装配（T47）', () => {
  const DONE = 'event: done\ndata: {}\n\n'

  beforeEach(() => localStorage.clear())
  afterEach(() => vi.unstubAllGlobals())

  /** 与文件中既有的 `ask` 同形：填输入框 + 回车提交。 */
  const ask = (text: string) => {
    fireEvent.change(screen.getByRole('textbox'), { target: { value: text } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
  }

  it('思考与阶段到达后面板出现在对话栏内，且阶段耗时来自服务端事件', async () => {
    stubWideViewport()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse(
          'event: reasoning\ndata: {"delta":"先核对证据是否足够。"}\n\n',
          'event: stage\ndata: {"name":"evidence","elapsed_ms":400}\n\n',
          DONE,
        ),
      ),
    )
    render(<App />)
    ask('线粒体自噬')

    await waitFor(() => expect(screen.getByLabelText('思考')).toBeInTheDocument())
    // 面板必须挂在**对话栏**里（spec：等待期的进展在对话栏呈现）
    const column = screen.getByTestId('chat-column')
    const panel = screen.getByLabelText('思考')
    expect(column.contains(panel)).toBe(true)
    // 阶段名与耗时都来自服务端 stage 事件，前端不自己掐表。
    // 查询**限定在面板内**：四栏工作台里「检索证据」这类措辞并不唯一。
    const inPanel = within(panel)
    await waitFor(() => expect(inPanel.getByText(/检索证据/)).toBeInTheDocument())
    expect(inPanel.getByText(/0\.4s|400ms/)).toBeInTheDocument()
  })

  it('思考不可用时的 notice 也走同一条装配路径显示出来', async () => {
    stubWideViewport()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse(
          'event: notice\ndata: {"message":"本轮未能获取模型思考内容（上游未提供）"}\n\n',
          DONE,
        ),
      ),
    )
    render(<App />)
    ask('线粒体自噬')

    await waitFor(() =>
      expect(within(screen.getByLabelText('思考')).getByText(/未能获取模型思考内容/)).toBeInTheDocument(),
    )
  })

  it('没有任何思考数据时不渲染空面板（绝不拿留白冒充进展）', async () => {
    stubWideViewport()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(DONE)))
    render(<App />)
    ask('线粒体自噬')
    // 该文案同时出现在输入框与消息气泡里，故用 findAllByText 收口「本轮已渲染」，
    // 再去断言面板**不在场**。
    await waitFor(async () => expect(await screen.findAllByText('线粒体自噬')).not.toHaveLength(0))
    expect(screen.queryByLabelText('思考')).toBeNull()
  })

  // ---- 复审 Important 1：截断标记的**接线**（组件单测证明不了 App 有没有传对） ----
  it('思考未以句末标点收尾时，面板不得谎报截断', async () => {
    stubWideViewport()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse('event: reasoning\ndata: {"delta":"先核对证据。第二句还在写"}\n\n', DONE),
      ),
    )
    render(<App />)
    ask('线粒体自噬')

    const panel = await screen.findByLabelText('思考')
    await waitFor(() => expect(within(panel).getByText(/先核对证据/)).toBeInTheDocument())
    expect(within(panel).queryByText(/已截断/)).toBeNull()
    expect(within(panel).queryByText(/思考内容过长/)).toBeNull()
  })

  // 思考**不设转发上限**（使用者 2026-09-19）⇒ 面板里不再有"截断"这一类任何呈现。
  // 老用例曾断言「服务端告知截断时面板显示截断说明」；上限取消后后端不再发那条告知、
  // 面板也不再有那段文案，故改为钉**相反**的性质：即便收到一条含「截断」的告知，
  // 面板也只把它当普通告知显示，绝不附加"思考被截断"的结论。
  it('含「截断」字样的告知只作为普通 notice 呈现，不产生截断结论', async () => {
    stubWideViewport()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse(
          'event: reasoning\ndata: {"delta":"先核对证据。"}\n\n',
          'event: notice\ndata: {"message":"补救生成失败：连接被截断（remote closed）"}\n\n',
          DONE,
        ),
      ),
    )
    render(<App />)
    ask('线粒体自噬')

    const panel = await screen.findByLabelText('思考')
    // 告知本身必须留存（零静默失败）
    await waitFor(() =>
      expect(within(panel).getByText(/补救生成失败：连接被截断/)).toBeInTheDocument(),
    )
    // 但不得出现"思考已截断 / 内容过长"这类结论
    expect(within(panel).queryByText(/思考已截断/)).toBeNull()
    expect(within(panel).queryByText(/思考内容过长/)).toBeNull()
  })

  // ---- 复审 Important 2(a)：刷新后的读取路径 --------------------------------------
  // plan §4.4：摘要与耗时随会话持久化（刷新后仍可见）；全文只当次可见。
  // 只有把**带留存字段的会话**喂进 App，才能证明那两个字段真的被读了 ——
  // 否则它们只是写进 localStorage 的死状态。
  it('刷新后（会话带着留存摘要）面板仍显示摘要与耗时，展开时说明全文仅当次可见', async () => {
    const now = Date.now()
    localStorage.setItem(
      'ragqa:conv:ai4s',
      JSON.stringify([
        {
          id: 'c1',
          title: '上一轮的问题',
          createdAt: now,
          updatedAt: now,
          messages: [
            { role: 'user', content: '上一轮的问题' },
            { role: 'assistant', content: '上一轮的答案' },
          ],
          evidenceByRound: {},
          reasoningSummary: '先核对证据是否足够。',
          reasoningMs: 1200,
        },
      ]),
    )
    localStorage.setItem('ragqa:current:ai4s', 'c1')
    stubWideViewport()
    await renderWideApp()

    const panel = screen.getByLabelText('思考')
    expect(within(panel).getByText(/先核对证据是否足够/)).toBeInTheDocument()
    expect(within(panel).getByText(/1\.2s/)).toBeInTheDocument()
    // 收起态不解释「全文在哪」；展开后才说（plan §4.4 的原话）
    expect(within(panel).queryByText(/仅当次可见/)).toBeNull()
    fireEvent.click(within(panel).getByRole('button'))
    expect(within(panel).getByText(/仅当次可见/)).toBeInTheDocument()
  })

  it('刷新后提交新一轮时清掉留存摘要（不得用上一轮的进展冒充本轮）', async () => {
    const now = Date.now()
    localStorage.setItem(
      'ragqa:conv:ai4s',
      JSON.stringify([
        {
          id: 'c1',
          title: '上一轮的问题',
          createdAt: now,
          updatedAt: now,
          messages: [
            { role: 'user', content: '上一轮的问题' },
            { role: 'assistant', content: '上一轮的答案' },
          ],
          evidenceByRound: {},
          reasoningSummary: '先核对证据是否足够。',
          reasoningMs: 1200,
        },
      ]),
    )
    localStorage.setItem('ragqa:current:ai4s', 'c1')
    stubWideViewport()
    const { stream } = controlledStream()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, body: stream } as unknown as Response),
    )
    render(<App />)
    expect(within(screen.getByLabelText('思考')).getByText(/先核对证据是否足够/)).toBeInTheDocument()

    ask('新一轮提问')
    // 新一轮的思考尚未到达：此刻面板必须**整个**消失，而不是挂着上一轮的留存摘要。
    // 这条同时钉住提交载荷里的显式清除（缺键会被 `{ ...会话, ...载荷 }` 当成「不改」）。
    await waitFor(() => expect(screen.queryByLabelText('思考')).toBeNull())
  })
})
