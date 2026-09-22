import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { useChat, type ChatPersist, type UseChatOptions } from '../hooks/useChat'
import type { Hit } from '../lib/events'
import type { Message } from '../lib/storage'

/**
 * 复审 ③：`params()` 今天自己吞异常，但那是实现细节；这里造出「将来它抛出」的情形，
 * 钉住它仍在 submit 的守卫区内被接住。默认透传真实实现，其余用例不受影响。
 */
const convStub = vi.hoisted(() => ({ throwOnParams: false }))

vi.mock('../lib/conversations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/conversations')>()
  return {
    ...actual,
    params: () => {
      if (convStub.throwOnParams) throw new Error('读取参数失败')
      return actual.params()
    },
  }
})

const enc = new TextEncoder()

/**
 * 一次变更的**落盘载荷**。C1 修复后 `submit` 起即落盘，尾部空的助手占位
 * **不写进存储**（否则刷新会留下一个空白气泡）——故断言时先把它抹掉。
 * 只抹「尾部空助手」这一件流式临时物；抹完仍有差异，断言照样会红。
 *
 * 用展开保留其余字段（003 起有 `reasoningSummary` / `reasoningMs`）：
 * 本辅助只负责剥占位，不负责裁剪载荷形状 —— 裁掉字段会让「摘要有没有落盘」
 * 这类断言测不到真东西。
 */
function persistPayload(u: ChatPersist): ChatPersist {
  const messages = [...u.messages]
  while (messages.at(-1)?.role === 'assistant' && messages.at(-1)?.content === '') {
    messages.pop()
  }
  return { ...u, messages }
}

/**
 * T29 起 `useChat` 接收**注入的会话真值**（plan §12.1），不再是 `useChat(lib)`。
 * 参数对象在用例内保持同一引用；「调用方每帧都传新对象」这一真实场景由
 * `会话真值外部注入` 描述块末条用例单独钉住。
 */
function chatProps(over: Partial<UseChatOptions> = {}): UseChatOptions {
  return {
    lib: 'ai4s',
    conversationId: 'c1',
    initialMessages: [],
    initialEvidenceByRound: {},
    onPersist: () => {},
    ...over,
  }
}

function sseStream(...frames: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f))
      c.close()
    },
  })
}

function okResponse(...frames: string[]) {
  return { ok: true, status: 200, body: sseStream(...frames) } as unknown as Response
}

/** 手动可控的 SSE 流：用于构造「请求仍在飞」的中间态（sseStream 会立即关闭）。 */
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

describe('useChat', () => {
  beforeEach(() => {
    localStorage.clear()
    convStub.throwOnParams = false
    vi.restoreAllMocks()
  })

  // 泄漏防护：`restoreAllMocks` 不撤销 `stubGlobal`，本仓库又未开 unstubGlobals，
  // 于是 fetch/matchMedia 的桩会渗进后续用例（T25 已因此踩过：一个「窄屏」用例
  // 实际继承了前一条的宽屏 matchMedia 桩）。每个用例结束后统一撤销。
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('walks idle → … → idle and accumulates the answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse(
          'event: evidence\ndata: {"lib":"ai4s","query":"q","hits":[]}\n\n',
          'event: answer\ndata: {"delta":"答"}\n\n',
          'event: answer\ndata: {"delta":"案"}\n\n',
          'event: done\ndata: {}\n\n',
        ),
      ),
    )
    const { result } = renderHook(() => useChat(chatProps()))
    act(() => result.current.submit('线粒体'))

    await waitFor(() => expect(result.current.status).toBe('idle'))
    expect(result.current.messages.map((m) => m.content)).toEqual(['线粒体', '答案'])
  })

  it('records the resolved query and degraded flag', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse(
          'event: rewrite\ndata: {"query":"线粒体自噬 调控因子","degraded":true}\n\n',
          'event: evidence\ndata: {"lib":"ai4s","query":"r","hits":[]}\n\n',
          'event: done\ndata: {}\n\n',
        ),
      ),
    )
    const { result } = renderHook(() => useChat(chatProps()))
    act(() => result.current.submit('那它呢'))
    await waitFor(() => expect(result.current.status).toBe('idle'))
    expect(result.current.resolvedQuery?.query).toBe('线粒体自噬 调控因子')
    expect(result.current.resolvedQuery?.degraded).toBe(true)
  })

  it('enters error state on an error event but keeps partial text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse(
          'event: answer\ndata: {"delta":"部分"}\n\n',
          'event: error\ndata: {"message":"生成失败"}\n\n',
          'event: done\ndata: {}\n\n',
        ),
      ),
    )
    const { result } = renderHook(() => useChat(chatProps()))
    act(() => result.current.submit('x'))
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.error).toBe('生成失败')
    expect(result.current.messages.at(-1)?.content).toBe('部分')
  })

  it('flags a stream that ends without done rather than staying busy', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse('event: answer\ndata: {"delta":"截断"}\n\n'),
      ),
    )
    const { result } = renderHook(() => useChat(chatProps()))
    act(() => result.current.submit('x'))
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.error).toMatch(/中断/)
  })

  // T29：会话的落盘已改由外部持有（`onPersist`）。本用例钉住「交出去的内容
  // 足以把一条会话原样恢复」——重挂载时把这些内容当作注入初值，历史与逐轮依据都还在。
  it('把会话内容交给 onPersist，重新注入即可恢复消息与逐轮依据', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse(
          'event: evidence\ndata: {"lib":"ai4s","query":"q","hits":[{"rowid":1,"source":"vault:note","ref":"a.md","title":"线粒体自噬","category":"","extra":"","snippet":"…","score":0.8}]}\n\n',
          'event: done\ndata: {}\n\n',
        ),
      ),
    )
    const persisted: ChatPersist[] = []
    const { result, unmount } = renderHook(() =>
      useChat(chatProps({ onPersist: (u) => persisted.push(u) })),
    )
    act(() => result.current.submit('线粒体'))
    await waitFor(() => expect(result.current.status).toBe('idle'))
    unmount()

    const saved = persisted.at(-1)
    // 助手占位不落盘（提交时是空的、流结束前都是临时物），故存储里只有用户提问
    expect(saved?.messages.map((m) => m.content)).toEqual(['线粒体'])
    expect(saved?.evidenceByRound[0]?.map((h) => h.rowid)).toEqual([1])

    // 「重开」= 用上次交出的内容重新注入（App 正是从 Conversation 里取这些字段）
    const second = renderHook(() =>
      useChat(
        chatProps({
          initialMessages: saved?.messages ?? [],
          initialEvidenceByRound: saved?.evidenceByRound ?? {},
        }),
      ),
    )
    expect(second.result.current.messages[0].content).toBe('线粒体')
    expect(second.result.current.evidenceByRound[0]?.map((h) => h.rowid)).toEqual([1])
  })

  // T29：双库隔离的落点从「两个存储键」移到「注入的会话内容」。本用例钉住
  // 「切库后拿到的必然是**该库自己的**会话内容，一帧都不串」。
  it('keeps history across lib switches without mixing them', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse('event: done\ndata: {}\n\n'),
      ),
    )
    const a = renderHook(() => useChat(chatProps()))
    act(() => a.result.current.submit('AI4S 的问题'))
    await waitFor(() => expect(a.result.current.status).toBe('idle'))

    const m = renderHook(() =>
      useChat(chatProps({ lib: 'mito', conversationId: 'm1' })),
    )
    expect(m.result.current.messages).toEqual([])
  })

  // 修订 1：T09 的解析器只做 `as SseEvent` 断言、不做形状校验，
  // 畸形但可解析的 data 会以 message=undefined 抵达。此时必须给出可见错误，
  // 否则 UI 静默不显示任何错误 —— 正是本模块存在的意义所在。
  it('surfaces a visible error when the error payload has no usable message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse(
          'event: error\ndata: {"foo":1}\n\n',
          'event: done\ndata: {}\n\n',
        ),
      ),
    )
    const { result } = renderHook(() => useChat(chatProps()))
    act(() => result.current.submit('x'))
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(typeof result.current.error).toBe('string')
    expect(result.current.error).toBeTruthy()
    expect(result.current.error).toMatch(/\S/)
    // 复审 ③：钉死「不得把 undefined 本身当成可见文案」（String(undefined) === 'undefined'）
    expect(result.current.error).not.toBe('undefined')
  })

  // 复审 ③：请求体里的 `params()` 求值必须**留在守卫区内** —— 它今天自己吞异常，
  // 但那是实现细节；将来一旦抛出，也不能逃出 submit 变成静默失败（宪法 §4.3）。
  it('params() 抛出时变成可见错误，而不是逃出 submit', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    convStub.throwOnParams = true

    const { result } = renderHook(() => useChat(chatProps()))
    act(() => result.current.submit('x'))

    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.error).toBe('读取参数失败')
    // 失败发生在构造请求体时：请求压根不该发出去
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // 修订 1（同类）：缺失/非字符串 delta 不得被拼成字面量 "undefined" 污染正文。
  it('ignores a non-string answer delta instead of appending "undefined"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse(
          'event: answer\ndata: {"delta":"答"}\n\n',
          'event: answer\ndata: {"foo":1}\n\n',
          'event: done\ndata: {}\n\n',
        ),
      ),
    )
    const { result } = renderHook(() => useChat(chatProps()))
    act(() => result.current.submit('x'))
    await waitFor(() => expect(result.current.status).toBe('idle'))
    expect(result.current.messages.at(-1)?.content).toBe('答')
  })

  // `abort` 是契约的一部分，但 brief 未覆盖；这里钉住「用户主动中断」与
  // 「网络/流失败」在状态机里必须可区分（aborted ≠ error，且不得冒出假错误）。
  it('distinguishes an aborted stream from a failed stream', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            )
          }),
      ),
    )
    const { result } = renderHook(() => useChat(chatProps()))
    act(() => result.current.submit('x'))
    act(() => result.current.abort())
    await waitFor(() => expect(result.current.status).toBe('aborted'))
    expect(result.current.error).toBeNull()
  })

  // 修订 1（同类）：缺失 hits 不得把 undefined 塞进 `Hit[]`，否则 T15 渲染即崩。
  it('falls back to an empty evidence list when hits is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse(
          'event: evidence\ndata: {"lib":"ai4s","query":"q"}\n\n',
          'event: done\ndata: {}\n\n',
        ),
      ),
    )
    const { result } = renderHook(() => useChat(chatProps()))
    act(() => result.current.submit('x'))
    await waitFor(() => expect(result.current.status).toBe('idle'))
    expect(result.current.evidence).toEqual([])
  })

  // 复审 ①：submit 的重入守卫原先读渲染闭包里的 status，同一批次内两次 submit
  // 都看到 idle ⇒ 第二个覆盖 abortRef，两个流同时往同一条 assistant 消息里追加，
  // 且第一个流再也无法中断。守卫必须看「是否有请求在飞」（ref）。
  it('ignores a second submit while a request is already in flight', async () => {
    const { stream, push, close } = controlledStream()
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, body: stream } as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useChat(chatProps()))
    act(() => {
      result.current.submit('第一个问题')
      result.current.submit('第二个问题')
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.current.messages.map((m) => m.content)).toEqual(['第一个问题', ''])

    await act(async () => {
      push('event: done\ndata: {}\n\n')
      close()
    })
    await waitFor(() => expect(result.current.status).toBe('idle'))
  })

  // 复审 ②：reset 不中断在飞请求 ⇒ 已被拆掉的流仍会写状态，把 reset 后的 idle
  // 翻回 streaming/error，并把刚清空的会话内容又交回去。
  it('reset during a stream tears it down without later writes or status flips', async () => {
    const { stream, push, close } = controlledStream()
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ ok: true, status: 200, body: stream } as unknown as Response),
    )

    const persisted: ChatPersist[] = []
    const { result } = renderHook(() =>
      useChat(chatProps({ onPersist: (u) => persisted.push(u) })),
    )
    act(() => result.current.submit('x'))
    await act(async () => {
      push('event: answer\ndata: {"delta":"部分"}\n\n')
    })
    await waitFor(() => expect(result.current.messages.at(-1)?.content).toBe('部分'))

    act(() => result.current.reset())
    expect(result.current.messages).toEqual([])
    expect(result.current.status).toBe('idle')
    // reset 本身就是一次内容变更：交给外部的必须是「空」
    expect(persisted.at(-1)).toEqual({ messages: [], evidenceByRound: {} })

    await act(async () => {
      push('event: answer\ndata: {"delta":"迟到"}\n\n')
      close()
    })

    expect(result.current.messages).toEqual([])
    expect(result.current.status).toBe('idle')
    expect(result.current.error).toBeNull()
    // 被拆掉的流结束时不落盘：迟到的答案一个字都不得写回会话。
    // C1 修复后提交那一刻也落一次盘（提交即留存），故总条数为 2：
    // 第 1 次 = submit 的用户提问（随后被 reset 清掉，第 2 次即空），第 2 次 = reset。
    // 交出去的**全部内容**恰好只剩用户自己的提问：流里的「部分 / 迟到」一字不留。
    expect(persisted).toHaveLength(2)
    // 复审 ②：T29 迁移时丢掉的「存储确实被清干净」——旧断言是
    // `localStorage.getItem('ragqa:ai4s') === null`。观察对象换成 persisted（生产写路径
    // 已不经 storage.ts）：不只看**条数**，还看**终态内容**为空、且被拆掉的流一个字
    // 都没写回去（reset 前的「部分」与迟到帧的「迟到」都必须绝迹）。
    expect(persisted.at(-1)).toEqual({ messages: [], evidenceByRound: {} })
    expect(persisted.flatMap((u) => u.messages.map((m) => m.content))).toEqual(['x'])
  })

  // 复审 ②：submit 若从闭包读 messages，同一批次里的 reset→submit 会把重置前的历史发出去。
  it('sends no pre-reset history when reset and submit share a tick', async () => {
    // 每次调用都返回**新的**响应与流：同一个 ReadableStream 不可被两个请求复用。
    const fetchMock = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(okResponse('event: done\ndata: {}\n\n')),
    )
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useChat(chatProps()))
    act(() => result.current.submit('旧问题'))
    await waitFor(() => expect(result.current.status).toBe('idle'))

    act(() => {
      result.current.reset()
      result.current.submit('新问题')
    })
    await waitFor(() => expect(result.current.status).toBe('idle'))

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const requestBody = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body))
    expect(requestBody.messages).toEqual([{ role: 'user', content: '新问题' }])
  })

  // 复审 ③：无在飞请求时 abort() 不应把 idle 无故翻成 aborted。
  it('treats abort with nothing in flight as a no-op', () => {
    const { result } = renderHook(() => useChat(chatProps()))
    act(() => result.current.abort())
    expect(result.current.status).toBe('idle')
  })

  // 复审 ③（range 外既有缺陷，宪法 §2.2 双库完全隔离）：切库若只把 messagesRef
  // 指向新库、**不失效在飞请求**，旧流走到 finally 时 isCurrent() 仍为真，
  // 它会拿**新库的 messages** 去落盘 ⇒ 两库会话互相污染。
  // T29 起落盘的出口是 onPersist（外部持有），故本用例断言「切库后旧流不再交出任何内容」。
  it('does not let an in-flight request pollute either lib on a lib switch', async () => {
    // 两库各自的留存内容：等价于 App 里 useConversations 持有的那份真值。
    // 旧版直接读 localStorage 的 `ragqa:ai4s` / `ragqa:mito` 两个键；现在这两个数组
    // （连同按 App 同形写回的 `sessions`）就是「各库的存储」。
    const ai4sHistory: Message[] = [{ role: 'user', content: 'AI4S 已有历史' }]
    const mitoHistory: Message[] = [{ role: 'user', content: 'MITO 已有历史' }]
    const sessions: Record<string, ChatPersist> = {
      a1: { messages: ai4sHistory, evidenceByRound: {} },
      m1: { messages: mitoHistory, evidenceByRound: {} },
    }
    let currentId: string | null = 'a1'
    const persisted: ChatPersist[] = []
    // 与 App 的 persist 同形：写进**当前**会话
    const persist = (u: ChatPersist) => {
      persisted.push(u)
      if (currentId !== null) sessions[currentId] = u
    }

    const { stream, push, close } = controlledStream()
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ ok: true, status: 200, body: stream } as unknown as Response),
    )

    let props = chatProps({
      lib: 'ai4s',
      conversationId: 'a1',
      initialMessages: ai4sHistory,
      initialEvidenceByRound: sessions.a1.evidenceByRound,
      onPersist: persist,
    })
    const { result, rerender } = renderHook(() => useChat(props))
    act(() => result.current.submit('AI4S 的问题'))
    expect(result.current.status).toBe('rewriting')

    currentId = 'm1'
    props = chatProps({
      lib: 'mito',
      conversationId: 'm1',
      initialMessages: mitoHistory,
      initialEvidenceByRound: sessions.m1.evidenceByRound,
      onPersist: persist,
    })
    rerender()
    expect(result.current.messages.map((m) => m.content)).toEqual(['MITO 已有历史'])

    // 旧流此刻仍在飞：让它继续吐帧并结束
    await act(async () => {
      push('event: answer\ndata: {"delta":"迟到的答案"}\n\n')
      close()
    })

    // 泄漏防护规则不变：旧流的迟到「AI4S 的问题」一字都不许被交出。
    // C1 修复后提交即留存，故唯一一次落盘是提交瞬间的那份内容 —— 它是 ai4s 自己的
    // 历史 + 自己的提问，**不含**任何流式答案（「迟到的答案」）。
    expect(persisted).toHaveLength(1)
    expect(persistPayload(persisted[0])).toEqual({
      messages: [
        { role: 'user', content: 'AI4S 已有历史' },
        { role: 'user', content: 'AI4S 的问题' },
      ],
      evidenceByRound: {},
    })
    expect(persisted.flatMap((u) => u.messages.map((m) => m.content))).not.toContain(
      '迟到的答案',
    )
    // 切库即失效：旧流不得再翻转新库的状态
    expect(result.current.status).toBe('idle')
    expect(result.current.error).toBeNull()
    expect(result.current.messages.map((m) => m.content)).toEqual(['MITO 已有历史'])

    // 复审 ②：T29 迁移时丢掉的「另一条库的内容原样幸存」——旧断言是
    // `JSON.parse(localStorage.getItem('ragqa:ai4s'))` 与 `…'ragqa:mito'` 各自等于
    // 自己的历史。新观察对象是注入的会话内容与按 App 同形写回的 sessions：
    // 只断言「迟到的答案不在其中」是一个方向更强，但证明不了两边的内容都还在。
    // C1 修复后 a1 多一条**用户自己**的提问（提交即留存）——那是 ai4s 的会话内容，
    // 不是跨库泄漏；mito 那条一个字都没被碰。
    expect(sessions.a1).toEqual({
      messages: [
        { role: 'user', content: 'AI4S 已有历史' },
        { role: 'user', content: 'AI4S 的问题' },
      ],
      evidenceByRound: {},
    })
    expect(sessions.m1).toEqual({
      messages: [{ role: 'user', content: 'MITO 已有历史' }],
      evidenceByRound: {},
    })
    // 注入的内容对象本身也不得被就地改写（旧版两个独立键天然给出的保证）
    expect(ai4sHistory).toEqual([{ role: 'user', content: 'AI4S 已有历史' }])
    expect(mitoHistory).toEqual([{ role: 'user', content: 'MITO 已有历史' }])

    // 切回 AI4S：拿回的仍是 AI4S 自己的留存内容（含用户自己刚问的那条）
    currentId = 'a1'
    props = chatProps({
      lib: 'ai4s',
      conversationId: 'a1',
      initialMessages: sessions.a1.messages,
      onPersist: persist,
    })
    rerender()
    expect(result.current.messages.map((m) => m.content)).toEqual([
      'AI4S 已有历史',
      'AI4S 的问题',
    ])
  })

  // ---- T25: 依据留存与按轮筛选 --------------------------------------------
  // 缺陷本体：`submit()` 里的 `setEvidence([])` 会把上一轮的命中清空，于是检索期间
  // （可能数十秒）依据栏看着是空的，且历史轮次的命中再也回不去。下面的用例把
  // 「检索期间不出现空窗」与「按轮留存、可回溯」钉死。
  describe('依据留存与按轮筛选', () => {
    const hit = (rowid: number, title = `依据 ${rowid}`): Hit => ({
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

    const DONE = 'event: done\ndata: {}\n\n'

    /** 依次为每一轮返回该轮命中；每次调用都产出**新的**流（同一个流不可复用）。 */
    const roundsFetch = (...rounds: Hit[][]) => {
      const mock = vi.fn()
      for (const hits of rounds) {
        mock.mockResolvedValueOnce(okResponse(evidenceFrame(...hits), DONE))
      }
      return mock
    }

    // 1. 缺陷本体：提交第二问时，第一轮的命中必须仍在。
    //    修复前这里被 `setEvidence([])` 清成 [] ⇒ 本条必红。
    it('开新一轮时上一轮的命中仍在（检索期间不留空窗）', async () => {
      const round0 = [hit(1), hit(2)]
      const { stream, push, close } = controlledStream()
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce(okResponse(evidenceFrame(...round0), DONE))
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            body: stream,
          } as unknown as Response),
      )

      const { result } = renderHook(() => useChat(chatProps()))
      act(() => result.current.submit('第一问'))
      await waitFor(() => expect(result.current.status).toBe('idle'))
      expect(result.current.evidence).toEqual(round0)

      act(() => result.current.submit('第二问'))
      // 新一轮的 evidence 尚未到达（受控流一帧未吐）：依据栏必须还是上一轮
      expect(result.current.status).toBe('rewriting')
      expect(result.current.evidence).toEqual(round0)

      // 第二轮甚至没有 evidence 事件：结束后也不得凭空丢掉上一轮
      await act(async () => {
        push(DONE)
        close()
      })
      await waitFor(() => expect(result.current.status).toBe('idle'))
      expect(result.current.evidence).toEqual(round0)
      expect(result.current.evidenceByRound[0]).toEqual(round0)
    })

    // 2. 新命中写入**发起该请求的那一轮**（而非事件到达时的位置启发式）
    it('新命中记为所属轮次并把显示切到该轮', async () => {
      const round0 = [hit(1)]
      const round1 = [hit(2)]
      vi.stubGlobal('fetch', roundsFetch(round0, round1))

      const { result } = renderHook(() => useChat(chatProps()))
      act(() => result.current.submit('第一问'))
      await waitFor(() => expect(result.current.status).toBe('idle'))
      act(() => result.current.submit('第二问'))
      await waitFor(() => expect(result.current.status).toBe('idle'))

      // 用 `messages.length - 2` 这类位置启发式会把第二轮记成键 2
      expect(Object.keys(result.current.evidenceByRound).map(Number).sort()).toEqual([0, 1])
      expect(result.current.evidenceByRound[0]).toEqual(round0)
      expect(result.current.evidenceByRound[1]).toEqual(round1)
      // 未筛选时是**跟随**最新一轮（Ruling 66）：跟随 ≠ 用户筛选，故 selectedRound 仍为 null
      expect(result.current.selectedRound).toBeNull()
      expect(result.current.followLatest).toBe(true)
      expect(result.current.shownRounds).toEqual([1])
      expect(result.current.evidence).toEqual(round1)
    })

    // 3. 点选某一轮 → 只看该轮；显式取消筛选 → 回到累积视图
    it('按轮筛选只看该轮命中，取消筛选回到累积视图', async () => {
      const round0 = [hit(1)]
      const round1 = [hit(2)]
      vi.stubGlobal('fetch', roundsFetch(round0, round1))

      const { result } = renderHook(() => useChat(chatProps()))
      act(() => result.current.submit('第一问'))
      await waitFor(() => expect(result.current.status).toBe('idle'))
      act(() => result.current.submit('第二问'))
      await waitFor(() => expect(result.current.status).toBe('idle'))

      act(() => result.current.selectRound(0))
      expect(result.current.selectedRound).toBe(0)
      expect(result.current.followLatest).toBe(false)
      expect(result.current.evidence).toEqual(round0)

      act(() => result.current.selectRound(null))
      expect(result.current.selectedRound).toBeNull()
      expect(result.current.followLatest).toBe(false)
      expect(result.current.evidence).toEqual([...round1, ...round0])
    })

    // 4. 累积视图 = 各轮并集，最近一轮置顶；同一条只留最近一次
    //    （否则同一 rowid 会在列表里出现两次，React key 也会撞）
    it('累积视图是各轮命中的并集且最近一轮置顶', async () => {
      const shared = hit(2, '两轮都召回的同一条')
      vi.stubGlobal('fetch', roundsFetch([hit(1), shared], [shared, hit(3)]))

      const { result } = renderHook(() => useChat(chatProps()))
      act(() => result.current.submit('第一问'))
      await waitFor(() => expect(result.current.status).toBe('idle'))
      act(() => result.current.submit('第二问'))
      await waitFor(() => expect(result.current.status).toBe('idle'))

      act(() => result.current.selectRound(null))
      expect(result.current.evidence.map((h) => h.rowid)).toEqual([2, 3, 1])
      // 同一条被两轮召回也只出现一次（否则列表里会堆两份、React key 也会撞）
      expect(result.current.evidence).toHaveLength(3)
      expect(result.current.evidence[0].title).toBe('两轮都召回的同一条')
    })

    // 5. 零命中轮次：该轮宣告为空，相邻轮次的命中既没被清掉也没被混淆
    it('零命中轮次只宣告该轮为空，其它轮次仍可回溯', async () => {
      const round0 = [hit(1)]
      vi.stubGlobal('fetch', roundsFetch(round0, []))

      const { result } = renderHook(() => useChat(chatProps()))
      act(() => result.current.submit('第一问'))
      await waitFor(() => expect(result.current.status).toBe('idle'))
      act(() => result.current.submit('第二问'))
      await waitFor(() => expect(result.current.status).toBe('idle'))

      // 键存在但为空 = 「该轮问过且零命中」：消费方据此显示「未找到依据」
      expect(Object.prototype.hasOwnProperty.call(result.current.evidenceByRound, 1)).toBe(true)
      expect(result.current.evidenceByRound[1]).toEqual([])
      expect(result.current.selectedRound).toBeNull()
      expect(result.current.followLatest).toBe(true)
      expect(result.current.shownRounds).toEqual([1])
      expect(result.current.evidence).toEqual([])
      expect(result.current.evidenceByRound[0]).toEqual(round0)

      act(() => result.current.selectRound(null))
      expect(result.current.evidence).toEqual(round0)
    })

    // 6. 中止只停本轮，部分答案保留 —— 依据同样保留
    it('中止不清空已显示的上一轮依据', async () => {
      const round0 = [hit(1)]
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce(okResponse(evidenceFrame(...round0), DONE))
          .mockImplementationOnce(
            (_url: string, init: RequestInit) =>
              new Promise<Response>((_resolve, reject) => {
                init.signal?.addEventListener('abort', () =>
                  reject(new DOMException('aborted', 'AbortError')),
                )
              }),
          ),
      )

      const { result } = renderHook(() => useChat(chatProps()))
      act(() => result.current.submit('第一问'))
      await waitFor(() => expect(result.current.status).toBe('idle'))

      act(() => result.current.submit('第二问'))
      act(() => result.current.abort())
      await waitFor(() => expect(result.current.status).toBe('aborted'))
      expect(result.current.error).toBeNull()
      expect(result.current.evidence).toEqual(round0)
      expect(result.current.evidenceByRound[0]).toEqual(round0)
    })

    // 7. 「还没问」与「问了但零命中」必须可区分（spec「历史恢复后不谎报空态」）
    it('尚未提问与零命中轮次可区分', async () => {
      vi.stubGlobal('fetch', roundsFetch([]))

      const { result } = renderHook(() => useChat(chatProps()))
      // 尚未提问：没有任何轮次被记录 ⇒ 消费方给中性占位，而不是「未找到依据」
      expect(result.current.evidence).toEqual([])
      expect(result.current.selectedRound).toBeNull()
      expect(result.current.followLatest).toBe(false)
      expect(result.current.shownRounds).toEqual([])
      expect(Object.keys(result.current.evidenceByRound)).toEqual([])

      act(() => result.current.submit('不存在的话题'))
      await waitFor(() => expect(result.current.status).toBe('idle'))
      // 显示同样为空，但该轮已被记录 ⇒ 可以坦率地说「未找到依据」
      expect(result.current.evidence).toEqual([])
      expect(result.current.followLatest).toBe(true)
      expect(result.current.shownRounds).toEqual([0])
      expect(Object.prototype.hasOwnProperty.call(result.current.evidenceByRound, 0)).toBe(true)
    })

    // 8. 保留的清理点之一：切库（依据属于提问的那个库，双库完全隔离）
    it('切库清空依据与轮次记录', async () => {
      vi.stubGlobal('fetch', roundsFetch([hit(1)]))
      let props = chatProps()
      const { result, rerender } = renderHook(() => useChat(props))
      act(() => result.current.submit('AI4S 的问题'))
      await waitFor(() => expect(result.current.status).toBe('idle'))
      expect(result.current.evidence).toHaveLength(1)

      // mito 那条会话自己没有任何留存依据 ⇒ 换过去必须干净
      props = chatProps({ lib: 'mito', conversationId: 'm1' })
      rerender()
      expect(result.current.evidence).toEqual([])
      expect(result.current.evidenceByRound).toEqual({})
      expect(result.current.selectedRound).toBeNull()
      expect(result.current.followLatest).toBe(false)
      expect(result.current.shownRounds).toEqual([])
    })

    // 9. 保留的清理点之二：reset（真正的重新开始）
    it('reset 清空依据与轮次记录', async () => {
      vi.stubGlobal('fetch', roundsFetch([hit(1)]))
      const { result } = renderHook(() => useChat(chatProps()))
      act(() => result.current.submit('第一问'))
      await waitFor(() => expect(result.current.status).toBe('idle'))
      expect(result.current.evidence).toHaveLength(1)

      act(() => result.current.reset())
      expect(result.current.evidence).toEqual([])
      expect(result.current.evidenceByRound).toEqual({})
      expect(result.current.selectedRound).toBeNull()
      expect(result.current.followLatest).toBe(false)
      expect(result.current.shownRounds).toEqual([])
      expect(result.current.selectedRowid).toBeNull()
    })

    // 10. 再次点选同一轮 = 取消筛选（spec「取消筛选」）
    it('再次选中同一轮即取消筛选', async () => {
      const round0 = [hit(1)]
      const round1 = [hit(2)]
      vi.stubGlobal('fetch', roundsFetch(round0, round1))

      const { result } = renderHook(() => useChat(chatProps()))
      act(() => result.current.submit('第一问'))
      await waitFor(() => expect(result.current.status).toBe('idle'))
      act(() => result.current.submit('第二问'))
      await waitFor(() => expect(result.current.status).toBe('idle'))

      act(() => result.current.selectRound(0))
      expect(result.current.evidence).toEqual(round0)
      act(() => result.current.selectRound(0))
      expect(result.current.selectedRound).toBeNull()
      expect(result.current.followLatest).toBe(false)
      expect(result.current.evidence).toEqual([...round1, ...round0])
    })

    // 11. 单条依据的选中态（文献卡侧栏的入口，由 T26/T27 消费）
    it('选中一条依据，再次点选同一条即取消选中', async () => {
      const round0 = [hit(1), hit(2)]
      vi.stubGlobal('fetch', roundsFetch(round0))
      const { result } = renderHook(() => useChat(chatProps()))
      act(() => result.current.submit('第一问'))
      await waitFor(() => expect(result.current.status).toBe('idle'))

      expect(result.current.selectedRowid).toBeNull()
      act(() => result.current.onSelectHit(round0[0]))
      expect(result.current.selectedRowid).toBe(1)
      act(() => result.current.onSelectHit(round0[1]))
      expect(result.current.selectedRowid).toBe(2)
      act(() => result.current.onSelectHit(round0[1]))
      expect(result.current.selectedRowid).toBeNull()
    })

    // 12. Ruling 66：用户点选早前轮次后，**新到达的命中不得把他拽走** ——
    //     「在长时间检索中回顾早前轮次」正是本任务存在的理由。
    it('用户点选早前轮次后，新命中到达不会把他拽走', async () => {
      const round0 = [hit(1)]
      const round2 = [hit(3)]
      const { stream, push, close } = controlledStream()
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce(okResponse(evidenceFrame(...round0), DONE))
          .mockResolvedValueOnce(okResponse(evidenceFrame(...[hit(2)]), DONE))
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            body: stream,
          } as unknown as Response),
      )

      const { result } = renderHook(() => useChat(chatProps()))
      act(() => result.current.submit('第一问'))
      await waitFor(() => expect(result.current.status).toBe('idle'))
      act(() => result.current.submit('第二问'))
      await waitFor(() => expect(result.current.status).toBe('idle'))

      // 第三轮在飞，用户回头查看第一轮
      act(() => result.current.submit('第三问'))
      expect(result.current.status).toBe('rewriting')
      act(() => result.current.selectRound(0))
      expect(result.current.evidence).toEqual(round0)

      // 第三轮命中到达：只归档，**不得**改变用户正在看的轮次
      await act(async () => {
        push(evidenceFrame(...round2))
      })
      await waitFor(() => expect(result.current.evidenceByRound[2]).toEqual(round2))
      expect(result.current.selectedRound).toBe(0)
      expect(result.current.followLatest).toBe(false)
      expect(result.current.evidence).toEqual(round0)

      // 本轮结束也不把他拽走（用户的观看选择不会被流结束改写）
      await act(async () => {
        push(DONE)
        close()
      })
      await waitFor(() => expect(result.current.status).toBe('idle'))
      expect(result.current.evidence).toEqual(round0)
    })

    // 13. 顺带项：切换显示轮次时清掉单条选中态，避免留下「选中的 rowid 不在
    //     当前显示集合里」的陈旧状态（对 T27 的文献卡是隐患）。
    it('切换显示轮次时清掉单条选中态', async () => {
      const round0 = [hit(1), hit(2)]
      vi.stubGlobal('fetch', roundsFetch(round0))
      const { result } = renderHook(() => useChat(chatProps()))
      act(() => result.current.submit('第一问'))
      await waitFor(() => expect(result.current.status).toBe('idle'))

      act(() => result.current.onSelectHit(round0[0]))
      expect(result.current.selectedRowid).toBe(1)

      act(() => result.current.selectRound(0))
      expect(result.current.selectedRowid).toBeNull()
    })

    // 13b. 同一件事的另一半：未筛选时新命中到达会切走显示集合，选中态同样失效。
    it('跟随最新一轮时，新命中到达切走显示并清掉单条选中态', async () => {
      const round0 = [hit(1)]
      const round1 = [hit(2)]
      const { stream, push, close } = controlledStream()
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce(okResponse(evidenceFrame(...round0), DONE))
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            body: stream,
          } as unknown as Response),
      )

      const { result } = renderHook(() => useChat(chatProps()))
      act(() => result.current.submit('第一问'))
      await waitFor(() => expect(result.current.status).toBe('idle'))
      act(() => result.current.onSelectHit(round0[0]))
      expect(result.current.selectedRowid).toBe(1)

      act(() => result.current.submit('第二问'))
      await act(async () => {
        push(evidenceFrame(...round1))
      })
      await waitFor(() => expect(result.current.evidenceByRound[1]).toEqual(round1))
      expect(result.current.shownRounds).toEqual([1])
      expect(result.current.selectedRowid).toBeNull()

      await act(async () => {
        push(DONE)
        close()
      })
      await waitFor(() => expect(result.current.status).toBe('idle'))
    })

    // 13c. 同一件事的第三半：提交新一轮会清掉筛选并切回最新一轮 ⇒ 选中态同样失效。
    it('提交新一轮并切走筛选时清掉单条选中态', async () => {
      const round0 = [hit(1), hit(2)]
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce(okResponse(evidenceFrame(...round0), DONE))
          .mockResolvedValueOnce(okResponse(evidenceFrame(hit(3)), DONE))
          .mockResolvedValueOnce(okResponse(DONE)),
      )

      const { result } = renderHook(() => useChat(chatProps()))
      act(() => result.current.submit('第一问'))
      await waitFor(() => expect(result.current.status).toBe('idle'))
      act(() => result.current.submit('第二问'))
      await waitFor(() => expect(result.current.status).toBe('idle'))

      act(() => result.current.selectRound(0))
      act(() => result.current.onSelectHit(round0[0]))
      expect(result.current.selectedRowid).toBe(1)

      act(() => result.current.submit('第三问'))
      await waitFor(() => expect(result.current.status).toBe('idle'))
      expect(result.current.shownRounds).toEqual([1])
      expect(result.current.selectedRowid).toBeNull()
    })

    // 14. 复审 Minor ①：守卫判据必须是「此前**在跟随态**」而不是「selectedRound 为 null」——
    //     取消筛选后 selectedRound 也是 null，但那时显示的是**累积并集**，提问会把显示切回
    //     最新一轮，被选中的旧轮命中同样会掉出显示集合。
    it('取消筛选（累积视图）后选中旧轮命中，再提问时清掉选中态', async () => {
      const round0 = [hit(1), hit(2)]
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce(okResponse(evidenceFrame(...round0), DONE))
          .mockResolvedValueOnce(okResponse(evidenceFrame(hit(3)), DONE))
          .mockResolvedValueOnce(okResponse(DONE)),
      )

      const { result } = renderHook(() => useChat(chatProps()))
      act(() => result.current.submit('第一问'))
      await waitFor(() => expect(result.current.status).toBe('idle'))
      act(() => result.current.submit('第二问'))
      await waitFor(() => expect(result.current.status).toBe('idle'))

      // 双击同一轮 = 取消筛选 ⇒ 累积视图（selectedRound 为 null，但**不在**跟随态）
      act(() => result.current.selectRound(1))
      act(() => result.current.selectRound(1))
      expect(result.current.selectedRound).toBeNull()
      expect(result.current.followLatest).toBe(false)
      expect(result.current.shownRounds).toEqual([0, 1])

      act(() => result.current.onSelectHit(round0[0]))
      expect(result.current.selectedRowid).toBe(1)

      act(() => result.current.submit('第三问'))
      await waitFor(() => expect(result.current.status).toBe('idle'))
      // 显示集合切回最新已记录轮（第 1 轮）：第 0 轮那条已不在显示里，选中态必须清掉
      expect(result.current.shownRounds).toEqual([1])
      expect(result.current.selectedRowid).toBeNull()
    })
  })
})

// ---- T29: 会话真值改由外部注入 --------------------------------------------
// plan §12.1 的「会话真值改由外部注入」：useChat 不再自己读写 localStorage，
// 而是「接收当前会话 → 变更时回调 onPersist」。理由不止于解耦：会话模型
// （Conversation）里每条对话各有自己的 evidenceByRound，若 useChat 仍自己
// 落盘 messages，刷新后逐轮依据就丢了 —— spec 的「会话留存与切换」要求两者都留。
describe('useChat 会话真值外部注入（T29）', () => {
  const hitAt = (rowid: number): Hit => ({
    rowid,
    source: 'vault:note',
    ref: `01-Literature/${rowid}.md`,
    title: `依据 ${rowid}`,
    category: '',
    extra: '',
    snippet: '…',
    score: 0.8,
  })

  const evidenceFrame = (...hits: Hit[]) =>
    `event: evidence\ndata: ${JSON.stringify({ lib: 'ai4s', query: 'q', hits })}\n\n`
  const DONE = 'event: done\ndata: {}\n\n'
  const ANSWER = 'event: answer\ndata: {"delta":"答"}\n\n'

  /** 新的调用形状；未指定的字段走中性默认值。 */
  function chatProps(
    over: Partial<Parameters<typeof useChat>[0]> = {},
  ): Parameters<typeof useChat>[0] {
    return {
      lib: 'ai4s',
      conversationId: 'c1',
      initialMessages: [],
      initialEvidenceByRound: {},
      onPersist: () => {},
      ...over,
    }
  }

  beforeEach(() => localStorage.clear())
  afterEach(() => vi.unstubAllGlobals())

  it('初始内容取自注入的会话，而不是 localStorage', () => {
    localStorage.setItem(
      'ragqa:ai4s',
      JSON.stringify([{ role: 'user', content: '存储里的旧消息' }]),
    )
    // 参数对象在渲染之间保持同一引用：本文件用可变 props + rerender 驱动会话切换。
    // 「调用方每次都传新对象」这一真实场景由本 describe 末条用例单独钉住。
    const props = chatProps({
      initialMessages: [{ role: 'user', content: '注入的历史' }],
      initialEvidenceByRound: { 0: [hitAt(1)] },
    })
    const { result } = renderHook(() => useChat(props))

    expect(result.current.messages.map((m) => m.content)).toEqual(['注入的历史'])
    // 依据同样来自注入：刷新后逐轮依据必须还在
    expect(result.current.evidenceByRound).toEqual({ 0: [hitAt(1)] })
    expect(result.current.shownRounds).toEqual([0])
    expect(result.current.evidence).toEqual([hitAt(1)])
  })

  it('完成一轮后把 messages 与 evidenceByRound 一并交给 onPersist', async () => {
    const persisted: ChatPersist[] = []
    const props = chatProps({ onPersist: (u) => persisted.push(u) })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okResponse(evidenceFrame(hitAt(1)), ANSWER, DONE)),
    )
    const { result } = renderHook(() => useChat(props))

    act(() => result.current.submit('第一问'))
    await waitFor(() => expect(result.current.status).toBe('idle'))

    // C1 修复后一轮有两次内容变更（提交即留存 + 流结束），故看**终态**而非条数
    const last = persisted.at(-1)
    expect(last?.messages.map((m) => m.content)).toEqual(['第一问', '答'])
    expect(last?.evidenceByRound).toEqual({ 0: [hitAt(1)] })
    // 提交那一刻的第一次落盘同样带着该轮的 messages 与 evidenceByRound
    expect(persistPayload(persisted[0])).toEqual({
      messages: [{ role: 'user', content: '第一问' }],
      evidenceByRound: {},
    })
  })

  it('切换对话即换掉消息与依据，上一条对话的内容一条也不带过去', () => {
    let props = chatProps({
      conversationId: 'c1',
      initialMessages: [{ role: 'user', content: 'c1 的问题' }],
      initialEvidenceByRound: { 0: [hitAt(1)] },
    })
    const { result, rerender } = renderHook(() => useChat(props))
    expect(result.current.messages.map((m) => m.content)).toEqual(['c1 的问题'])
    expect(result.current.evidence).toEqual([hitAt(1)])

    props = chatProps({
      conversationId: 'c2',
      initialMessages: [{ role: 'user', content: 'c2 的问题' }],
      initialEvidenceByRound: { 0: [hitAt(9)] },
    })
    rerender()

    expect(result.current.messages.map((m) => m.content)).toEqual(['c2 的问题'])
    expect(result.current.evidenceByRound).toEqual({ 0: [hitAt(9)] })
    expect(result.current.evidence).toEqual([hitAt(9)])
    expect(result.current.status).toBe('idle')
    expect(result.current.error).toBeNull()
    expect(result.current.selectedRowid).toBeNull()
  })

  it('切走对话后，仍在飞的旧流既不写状态也不落盘', async () => {
    const persisted: ChatPersist[] = []
    const { stream, push, close } = controlledStream()
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ ok: true, status: 200, body: stream } as unknown as Response),
    )

    let props = chatProps({
      conversationId: 'c1',
      onPersist: (u) => persisted.push(u),
    })
    const { result, rerender } = renderHook(() => useChat(props))
    act(() => result.current.submit('c1 的问题'))
    expect(result.current.status).toBe('rewriting')

    props = chatProps({ conversationId: 'c2', onPersist: (u) => persisted.push(u) })
    rerender()
    expect(result.current.status).toBe('idle')
    expect(result.current.messages).toEqual([])

    // 旧流此刻仍在飞：让它继续吐帧并结束 —— 一个字都不许写进 c2
    await act(async () => {
      push(evidenceFrame(hitAt(1)))
      push(ANSWER)
      push(DONE)
      close()
    })

    expect(result.current.messages).toEqual([])
    expect(result.current.evidenceByRound).toEqual({})
    expect(result.current.status).toBe('idle')
    // 泄漏防护规则不变：被切走的那条流**一个字也不许**再交出去。
    // 唯一一次落盘是提交瞬间的用户提问（C1 修复：提交即留存），它发生在**切换之前**，
    // 内容是 c1 自己的问题 —— 不是泄漏。条数一旦大于 1，就是旧流又写了。
    expect(persisted).toHaveLength(1)
    expect(persistPayload(persisted[0])).toEqual({
      messages: [{ role: 'user', content: 'c1 的问题' }],
      evidenceByRound: {},
    })
  })

  it('onSelectHit 拒绝显示集合之外的 rowid（会员守卫）', async () => {
    const round0 = [hitAt(1), hitAt(2)]
    const round1 = [hitAt(3)]
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(okResponse(evidenceFrame(...round0), DONE))
        .mockResolvedValueOnce(okResponse(evidenceFrame(...round1), DONE)),
    )
    const props = chatProps()
    const { result } = renderHook(() => useChat(props))

    act(() => result.current.submit('第一问'))
    await waitFor(() => expect(result.current.status).toBe('idle'))
    act(() => result.current.submit('第二问'))
    await waitFor(() => expect(result.current.status).toBe('idle'))

    // 只看第 1 轮：显示集合是 [3]，第 0 轮那两条不在其中
    act(() => result.current.selectRound(1))
    expect(result.current.evidence).toEqual(round1)

    act(() => result.current.onSelectHit(round1[0]))
    expect(result.current.selectedRowid).toBe(3)

    // 显示集合外的 rowid 一律不选：否则文献卡会去取一篇用户看不见的笔记
    act(() => result.current.onSelectHit(round0[0]))
    expect(result.current.selectedRowid).toBe(3)

    // 未选中时同样拒收
    act(() => result.current.onSelectHit(round1[0]))
    expect(result.current.selectedRowid).toBeNull()
    act(() => result.current.onSelectHit(round0[1]))
    expect(result.current.selectedRowid).toBeNull()
  })

  it('调用方每次渲染都传新对象时不会自激（App 正是这样传的）', () => {
    // App 里 onPersist/sessionKey 之类的依赖都是就地算出来的；若 useChat 用对象引用
    // 判断「会话是否变了」，每次渲染都会重置一次状态，乃至陷入 setState 自激。
    const { result, rerender } = renderHook(
      (p: { label: string }) =>
        useChat({
          lib: 'ai4s',
          conversationId: 'c1',
          initialMessages: [{ role: 'user', content: p.label }],
          initialEvidenceByRound: {},
          onPersist: () => {},
        }),
      { initialProps: { label: '第一次' } },
    )
    expect(result.current.messages.map((m) => m.content)).toEqual(['第一次'])

    // 会话没变，只是父组件重渲染：已注入的初值不得再覆盖运行中的会话
    rerender({ label: '第二次' })
    expect(result.current.messages.map((m) => m.content)).toEqual(['第一次'])
  })
})

// ---- C1: 提交即留存（整支复审 Critical —— 数据丢失） -------------------------
// 缺陷本体：`useChat` 只在流的 `finally`（与 `reset`）落盘，而 `submit()` 只改
// refs/state。切会话 / 刷新会中止在飞请求，`finally` 便正确地拒绝写入（已非当前会话）
// —— 于是**用户自己刚发出的问题反而一个字都没留下**，且不报任何错。这与本阶段头号
// 需求「会话留存与切换」/ SC-14 直接冲突，属宪法禁止的静默失败。
//
// 修复判据（两条）：
//   ① 提交那一刻即落盘：无论流后来被中止、还是页面刷新，问题都已在存储里；
//   ② 尾部空的助手占位**不写进存储**：中断后重载不得留下一个空白气泡。
describe('useChat 提交即留存（C1）', () => {
  const DONE = 'event: done\ndata: {}\n\n'

  function chatProps(
    over: Partial<Parameters<typeof useChat>[0]> = {},
  ): Parameters<typeof useChat>[0] {
    return {
      lib: 'ai4s',
      conversationId: 'c1',
      initialMessages: [],
      initialEvidenceByRound: {},
      onPersist: () => {},
      ...over,
    }
  }

  beforeEach(() => localStorage.clear())
  afterEach(() => vi.unstubAllGlobals())

  /**
   * 落盘载荷去掉**尾部**的空助手占位（含多条连续空串）。
   * 这不是「弱化断言」：空助手气泡是流式中的临时物，提交即留存的正确内容就是
   * 用户提问本身；把它抹掉后若**还有**别的差异，断言照样会红。
   */
  const withoutTrailingPlaceholder = (messages: Message[]): Message[] => {
    const out = [...messages]
    while (out.at(-1)?.role === 'assistant' && out.at(-1)?.content === '') out.pop()
    return out
  }

  it('提交后切走对话（流被中止），问题仍留存在那条对话里', async () => {
    const { stream, push, close } = controlledStream()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, body: stream } as unknown as Response),
    )

    const persisted: ChatPersist[] = []
    let props = chatProps({ conversationId: 'c1', onPersist: (u) => persisted.push(u) })
    const { result, rerender } = renderHook(() => useChat(props))

    act(() => result.current.submit('一个绝不能丢的问题'))
    expect(result.current.status).toBe('rewriting')

    // 切走对话：会话键一变即在渲染期夺走旧流的写权，effect 随后 abort 它
    props = chatProps({ conversationId: 'c2', onPersist: (u) => persisted.push(u) })
    rerender()
    expect(result.current.messages).toEqual([])

    // 旧流此刻仍在飞。让它吐一帧再结束 —— 一个字都不许再交出去（泄漏防护不变）
    await act(async () => {
      push(DONE)
      close()
    })

    expect(persisted).toHaveLength(1)
    expect(withoutTrailingPlaceholder(persisted[0].messages)).toEqual([
      { role: 'user', content: '一个绝不能丢的问题' },
    ])
    expect(persisted[0].evidenceByRound).toEqual({})
    // 新对话没被污染
    expect(result.current.messages).toEqual([])
  })

  it('流中断后重新载入：问题还在，且不留空的助手气泡', async () => {
    const { stream } = controlledStream()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, body: stream } as unknown as Response),
    )

    const persisted: ChatPersist[] = []
    const { result, unmount } = renderHook(() =>
      useChat(chatProps({ onPersist: (u) => persisted.push(u) })),
    )
    act(() => result.current.submit('刷新前的问题'))
    // 流**从未**结束（既无 done 也无 error），页面直接被刷走
    unmount()

    const saved = persisted.at(-1)
    expect(saved).toBeDefined()
    const messages = saved?.messages ?? []
    expect(messages.map((m) => m.content)).toContain('刷新前的问题')
    // 尾部不得留下空助手气泡（存储里不留，渲染层也就不可能凭空多出一个空白气泡）
    expect(messages.at(-1)?.role).not.toBe('assistant')
    expect(
      messages.filter((m) => m.role === 'assistant' && m.content.trim() === ''),
    ).toEqual([])

    // 「重新载入」= 用交出的内容重新注入（App 正是从 Conversation 里取这两个字段）
    const reloaded = renderHook(() =>
      useChat(
        chatProps({
          initialMessages: saved?.messages ?? [],
          initialEvidenceByRound: saved?.evidenceByRound ?? {},
        }),
      ),
    )
    expect(reloaded.result.current.messages.map((m) => m.content)).toEqual(['刷新前的问题'])
  })
})

// ---- T46: 003 思考与阶段 ------------------------------------------------------
// 后端 T40/42/43 已 emit `reasoning` / `stage` / `notice`，T44 把事件类型打通后
// 事件才可能抵达这里。本块钉住状态机侧的四件事：累计思考、首字自动收起、
// 阶段耗时只来自服务端、以及「提交新一轮必须先清掉上一轮的思考」。
// `chatProps` / `okResponse` / `controlledStream` / `sseStream` / `persistPayload`
// 全部沿用本文件既有的辅助（brief 里的 `renderController` / `emit` 在本仓库并不存在）。
describe('003 思考与阶段', () => {
  const DONE = 'event: done\ndata: {}\n\n'
  const REASONING = (delta: string) =>
    `event: reasoning\ndata: ${JSON.stringify({ delta })}\n\n`

  beforeEach(() => localStorage.clear())
  afterEach(() => vi.unstubAllGlobals())

  it('累计 reasoning 增量', async () => {
    // `sseStream` 会立即关闭，且两条 delta 在同一批里 flush；
    // 用 `waitFor` 收口「状态已落定」，比断言某一帧的中间态更稳。
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(REASONING('先想'), REASONING('再想'), DONE)))
    const { result } = renderHook(() => useChat(chatProps()))
    act(() => result.current.submit('问'))
    await waitFor(() => expect(result.current.status).toBe('idle'))
    expect(result.current.reasoningText).toBe('先想再想')
  })

  it('首个 answer 后自动收起思考', async () => {
    // 必须用受控流：只有留在「思考已到、正文未到」的中间态上，才能先观测到 true，
    // 再观测到首字到达后翻成 false。一次性流会把两个状态挤在同一帧里。
    const { stream, push, close } = controlledStream()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, body: stream } as unknown as Response),
    )
    const { result } = renderHook(() => useChat(chatProps()))
    act(() => result.current.submit('问'))

    await act(async () => {
      push(REASONING('想法。'))
    })
    await waitFor(() => expect(result.current.thinkingOpen).toBe(true))

    await act(async () => {
      push('event: answer\ndata: {"delta":"答"}\n\n')
    })
    await waitFor(() => expect(result.current.thinkingOpen).toBe(false))

    await act(async () => {
      push(DONE)
      close()
    })
    await waitFor(() => expect(result.current.status).toBe('idle'))
    // 正文已经到了，思考不该在展开态把正文挤下去
    expect(result.current.thinkingOpen).toBe(false)
  })

  it('阶段耗时只来自服务端事件', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse('event: stage\ndata: {"name":"evidence","elapsed_ms":400}\n\n', DONE),
      ),
    )
    const { result } = renderHook(() => useChat(chatProps()))
    act(() => result.current.submit('问'))
    await waitFor(() => expect(result.current.status).toBe('idle'))
    expect(result.current.stages).toEqual([{ name: 'evidence', elapsed_ms: 400 }])
  })

  it('未收到 rewrite 阶段时不显示它', async () => {
    // 单轮请求后端不跑改写，因而**不会**发 rewrite 阶段。前端不得凭空补一个
    // 「理解问题 · 0ms」——那是一个与真实进展无关的数字。
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse('event: stage\ndata: {"name":"evidence","elapsed_ms":10}\n\n', DONE),
      ),
    )
    const { result } = renderHook(() => useChat(chatProps()))
    act(() => result.current.submit('问'))
    await waitFor(() => expect(result.current.status).toBe('idle'))
    expect(result.current.stages.map((s) => s.name)).not.toContain('rewrite')
    expect(result.current.stages).toHaveLength(1)
  })

  it('notice 如实收下来（零静默失败：不可用/截断必须能被渲染）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse(
          'event: notice\ndata: {"message":"本轮未能获取模型思考内容（上游未提供）"}\n\n',
          DONE,
        ),
      ),
    )
    const { result } = renderHook(() => useChat(chatProps()))
    act(() => result.current.submit('问'))
    await waitFor(() => expect(result.current.status).toBe('idle'))
    expect(result.current.notices).toEqual(['本轮未能获取模型思考内容（上游未提供）'])
  })

  it('toggleThinking 可开合', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(REASONING('想法。'), DONE)))
    const { result } = renderHook(() => useChat(chatProps()))
    act(() => result.current.submit('问'))
    await waitFor(() => expect(result.current.thinkingOpen).toBe(true))

    act(() => result.current.toggleThinking())
    expect(result.current.thinkingOpen).toBe(false)
    act(() => result.current.toggleThinking())
    expect(result.current.thinkingOpen).toBe(true)
  })

  // 复审 Minor：篇幅告知带服务端实测的「实际交付字数 / 目标字数」，此前收到即被丢掉
  // ——使用者只被告知「未达标」，看不到差多少。这两个数字是这条告知里唯一的一手事实。
  it('notice 里的服务端字数（chars/target）必须显示，不能收到即丢', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse(
          'event: notice\ndata: {"message":"本轮篇幅未达标","chars":980,"target":1500}\n\n',
          DONE,
        ),
      ),
    )
    const { result } = renderHook(() => useChat(chatProps()))
    act(() => result.current.submit('问'))
    await waitFor(() => expect(result.current.status).toBe('idle'))
    expect(result.current.notices).toEqual(['本轮篇幅未达标（980/1500 字）'])
  })

  // ---- 思考**不设转发上限**（使用者 2026-09-19 明确要求） ------------------------
  //
  // 历史：曾有一整套「思考被上限截断」的机制（后端超限发 notice + 前端置位标记）。
  // 上限取消后，该状态在整条链路上都不存在，故 `ChatController` 也**不再暴露**
  // `reasoningTruncated` —— 留着它会让后人以为还有这个状态。这三条用例钉的就是
  // 「不设上限」这一事实：完整转发、且任何文案都不再被解读成截断。
  it('思考文本原样留存，不因长度被丢弃（无上限）', async () => {
    // 13000 字已**远超**原先的 12000 上限，足以钉住「不再截断」；不取更大值是为了
    // 让单条 SSE 帧保持轻量（超大帧下 jsdom 的流式读取会慢到让本用例超时）。
    const long = '先核对证据。' + '乙'.repeat(13000)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(REASONING(long), DONE)))
    const { result } = renderHook(() => useChat(chatProps()))
    act(() => result.current.submit('问'))
    await waitFor(() => expect(result.current.status).toBe('idle'), { timeout: 8000 })
    expect(result.current.reasoningText).toBe(long)
  })

  it('文案里出现「截断」的 notice 原样留存，且不被解读成思考状态', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse(
          REASONING('先核对证据。'),
          // 恰好含「截断」二字，但这是**正文**补救失败的告知，与思考无关。
          // 上限取消后前端不再对该文案做任何解读，故它只应作为一条告知出现。
          'event: notice\ndata: {"message":"补救生成失败：连接被截断（remote closed）"}\n\n',
          DONE,
        ),
      ),
    )
    const { result } = renderHook(() => useChat(chatProps()))
    act(() => result.current.submit('问'))
    await waitFor(() => expect(result.current.status).toBe('idle'))
    expect(result.current.notices.join('')).toContain('补救生成失败')
  })

  it('普通 notice 照常逐条留存（零静默失败不因取消上限而放松）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse(
          'event: notice\ndata: {"message":"本轮未能获取模型思考内容（上游未提供）"}\n\n',
          DONE,
        ),
      ),
    )
    const { result } = renderHook(() => useChat(chatProps()))
    act(() => result.current.submit('问'))
    await waitFor(() => expect(result.current.status).toBe('idle'))
    expect(result.current.notices).toHaveLength(1)
  })
  // 上一轮的思考若留到新一轮，等待期显示的就是**过期的进展**——比什么都不显示更具误导性
  // （宪法 §4.3 零静默失败的另一面：不许用陈旧数据冒充当前状态）。
  it('提交新一轮时清掉上一轮的思考摘要与阶段', async () => {
    const { stream, push, close } = controlledStream()
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          okResponse(REASONING('上一轮的思考。'), 'event: stage\ndata: {"name":"reasoning","elapsed_ms":900}\n\n', DONE),
        )
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          body: stream,
        } as unknown as Response),
    )
    const { result } = renderHook(() => useChat(chatProps()))
    act(() => result.current.submit('第一问'))
    await waitFor(() => expect(result.current.status).toBe('idle'))
    expect(result.current.reasoningText).toBe('上一轮的思考。')
    expect(result.current.stages).toHaveLength(1)

    act(() => result.current.submit('第二问'))
    // 新一轮的 reasoning 尚未到达：此刻必须什么都不显示
    expect(result.current.status).toBe('rewriting')
    expect(result.current.reasoningText).toBe('')
    expect(result.current.stages).toEqual([])
    expect(result.current.thinkingOpen).toBe(false)

    await act(async () => {
      push(DONE)
      close()
    })
    await waitFor(() => expect(result.current.status).toBe('idle'))
  })

  it('切换会话时清掉思考真值（不得把上一会话的思考带进新会话）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okResponse(REASONING('上一条会话的思考。'), DONE)),
    )
    let props = chatProps({ conversationId: 'c1' })
    const { result, rerender } = renderHook(() => useChat(props))
    act(() => result.current.submit('问'))
    await waitFor(() => expect(result.current.status).toBe('idle'))
    expect(result.current.reasoningText).toBe('上一条会话的思考。')

    props = chatProps({ conversationId: 'c2' })
    rerender()
    expect(result.current.reasoningText).toBe('')
    expect(result.current.stages).toEqual([])
    expect(result.current.thinkingOpen).toBe(false)
  })

  it('本轮结束时把思考摘要与耗时一并落盘', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse(
          REASONING('先核对证据。'),
          'event: stage\ndata: {"name":"reasoning","elapsed_ms":900}\n\n',
          DONE,
        ),
      ),
    )
    const persisted: ChatPersist[] = []
    const { result } = renderHook(() =>
      useChat(chatProps({ onPersist: (u) => persisted.push(u) })),
    )
    act(() => result.current.submit('问'))
    await waitFor(() => expect(result.current.status).toBe('idle'))

    // 终态那次落盘必须带摘要与耗时（其余字段照旧，故用 objectContaining 而非全等）
    const last = persistPayload(persisted.at(-1) as ChatPersist)
    expect(last).toEqual(
      expect.objectContaining({
        evidenceByRound: {},
        reasoningSummary: '先核对证据。',
        reasoningMs: 900,
      }),
    )
  })

  it('没有思考时不落摘要与耗时（不写空串、不写 0）', async () => {
    // 「没有思考」必须与「思考了 0ms」可区分：写 0 会让刷新后的界面显示
    // 「思考 · 0ms」，把一次**缺失**说成一次**测量**。
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(DONE)))
    const persisted: ChatPersist[] = []
    const { result } = renderHook(() =>
      useChat(chatProps({ onPersist: (u) => persisted.push(u) })),
    )
    act(() => result.current.submit('问'))
    await waitFor(() => expect(result.current.status).toBe('idle'))

    const last = persistPayload(persisted.at(-1) as ChatPersist)
    expect(last.reasoningSummary).toBeUndefined()
    expect(last.reasoningMs).toBeUndefined()
  })

  // ---- 复审 Important 2/3：留存字段的**清除路径** ---------------------------------
  //
  // 两个字段是可选字段，而 App 侧写回是 `{ ...c, ...patch }` 合并：
  // **缺键 = 保留旧值**。故「清掉」不能靠省略，必须显式给出 `undefined`。
  // 少了这一步，上一轮的摘要会留在一个已经清空的会话上（reset），或者在新一轮的
  // 整个检索等待期挂在面板上——用上一轮的进展冒充本轮（宪法 §4.3 零静默失败的另一面）。
  it('提交新一轮时清掉上一轮留存的摘要与耗时（键须在场，值须为 undefined）', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        // 每轮一条独立响应：同一个 ReadableStream 不能被两个请求复用。
        .mockResolvedValueOnce(
          okResponse(
            REASONING('先核对证据。'),
            'event: stage\ndata: {"name":"reasoning","elapsed_ms":900}\n\n',
            DONE,
          ),
        )
        .mockResolvedValueOnce(okResponse(DONE)),
    )
    const persisted: ChatPersist[] = []
    const { result } = renderHook(() =>
      useChat(chatProps({ onPersist: (u) => persisted.push(u) })),
    )
    act(() => result.current.submit('第一问'))
    await waitFor(() => expect(result.current.status).toBe('idle'))
    expect(persistPayload(persisted.at(-1) as ChatPersist)).toEqual(
      expect.objectContaining({ reasoningSummary: '先核对证据。', reasoningMs: 900 }),
    )

    act(() => result.current.submit('第二问'))
    const submitPayload = persistPayload(persisted.at(-1) as ChatPersist)
    expect('reasoningSummary' in submitPayload).toBe(true)
    expect('reasoningMs' in submitPayload).toBe(true)
    expect(submitPayload.reasoningSummary).toBeUndefined()
    expect(submitPayload.reasoningMs).toBeUndefined()

    // 收口到终态：流还在飞时结束用例，setState 会落在测试之外（act 警告）。
    await waitFor(() => expect(result.current.status).toBe('idle'))
  })

  it('reset 的落盘载荷必须把留存的摘要与耗时一并清掉', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse(
          REASONING('先核对证据。'),
          'event: stage\ndata: {"name":"reasoning","elapsed_ms":900}\n\n',
          DONE,
        ),
      ),
    )
    const persisted: ChatPersist[] = []
    const { result } = renderHook(() =>
      useChat(chatProps({ onPersist: (u) => persisted.push(u) })),
    )
    act(() => result.current.submit('问'))
    await waitFor(() => expect(result.current.status).toBe('idle'))

    act(() => result.current.reset())
    const payload = persisted.at(-1) as ChatPersist
    expect(payload.messages).toEqual([])
    expect(payload.evidenceByRound).toEqual({})
    // 键在场是**承重**的：App 侧为合并写回，缺键等于把上一轮的思考留在空会话上。
    expect('reasoningSummary' in payload).toBe(true)
    expect('reasoningMs' in payload).toBe(true)
    expect(payload.reasoningSummary).toBeUndefined()
    expect(payload.reasoningMs).toBeUndefined()
  })
})

/**
 * T56：答案里的 [编号] 跳转 —— 控制器侧的**成员守卫**。
 *
 * 编号的定位规则在 `lib/citations.ts`（纯函数），渲染在 `AnswerMarkdown`，整机在
 * `app-citations.spec.tsx`。这里钉的是那条唯一可能**指错篇目**的路径：拿到一个不属于
 * 该轮的 rowid 时必须是空操作，而不是把显示切过去、选中一条不该选的命中 ——
 * 选中态是文献卡的取文依据，误选 = 打开一篇用户没指的笔记。
 *
 * 守卫的判据是**本轮命中集**（`evidenceByRound[round]`），不是当前显示集合：
 * 跳转本身会切换显示集合，拿切换前的集合比对会把每一次跨轮跳转都误判成越界。
 */
describe('useChat 引用跳转的成员守卫（T56）', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const hit = (rowid: number): Hit => ({
    rowid,
    source: 'vault:note',
    ref: `01-Literature/${rowid}.md`,
    title: `依据 ${rowid}`,
    category: '',
    extra: '',
    snippet: '…',
    score: 0.8,
  })
  const evidenceFrame = (...hits: Hit[]) =>
    `event: evidence\ndata: ${JSON.stringify({ lib: 'ai4s', query: 'q', hits })}\n\n`
  const DONE = 'event: done\ndata: {}\n\n'
  const roundsFetch = (...rounds: Hit[][]) => {
    const mock = vi.fn()
    for (const hits of rounds) {
      mock.mockResolvedValueOnce(okResponse(evidenceFrame(...hits), DONE))
    }
    return mock
  }

  /** 两轮：第一轮 [1,2]，第二轮 [3]；返回时显示集合是**第二轮**（跟随最新一轮）。 */
  async function twoRounds() {
    vi.stubGlobal('fetch', roundsFetch([hit(1), hit(2)], [hit(3)]))
    const rendered = renderHook(() => useChat(chatProps()))
    act(() => rendered.result.current.submit('第一问'))
    await waitFor(() => expect(rendered.result.current.status).toBe('idle'))
    act(() => rendered.result.current.submit('第二问'))
    await waitFor(() => expect(rendered.result.current.status).toBe('idle'))
    expect(rendered.result.current.evidence.map((h) => h.rowid)).toEqual([3])
    return rendered
  }

  it('跳到某一轮的命中：受理并选中它，同时把显示集合切到那一轮（卡片才会在屏上）', async () => {
    const { result } = await twoRounds()

    let selected = false
    act(() => {
      selected = result.current.selectCitedHit(0, hit(2))
    })

    // 返回值是调用方（App）决定**要不要取文**的唯一依据：见 app-citations.spec.tsx
    expect(selected).toBe(true)
    expect(result.current.selectedRowid).toBe(2)
    expect(result.current.selectedRound).toBe(0)
    expect(result.current.evidence.map((h) => h.rowid)).toEqual([1, 2])
  })

  it('该轮没有这个 rowid 时是**空操作**且返回 false（不切显示、不选中、不得据此取文）', async () => {
    const { result } = await twoRounds()

    let accepted = true
    act(() => {
      accepted = result.current.selectCitedHit(0, hit(999))
    })

    expect(accepted).toBe(false)
    expect(result.current.selectedRowid).toBeNull()
    expect(result.current.selectedRound).toBeNull()
    expect(result.current.evidence.map((h) => h.rowid)).toEqual([3])
  })

  it('不存在的轮次同样是空操作且返回 false', async () => {
    const { result } = await twoRounds()

    let accepted = true
    act(() => {
      accepted = result.current.selectCitedHit(7, hit(1))
    })

    expect(accepted).toBe(false)
    expect(result.current.selectedRowid).toBeNull()
    expect(result.current.selectedRound).toBeNull()
    expect(result.current.evidence.map((h) => h.rowid)).toEqual([3])
  })

  it('再次跳转同一条 = 取消选中，且返回 false（这一次没有选中任何一条）', async () => {
    const { result } = await twoRounds()

    act(() => {
      result.current.selectCitedHit(0, hit(2))
    })
    let selectedAgain = true
    act(() => {
      selectedAgain = result.current.selectCitedHit(0, hit(2))
    })

    expect(selectedAgain).toBe(false)
    expect(result.current.selectedRowid).toBeNull()
    expect(result.current.selectedRound).toBe(0)
  })
})
