import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDoc } from '../hooks/useDoc'

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as unknown as Response
}

const note = (over: Record<string, unknown> = {}) => ({
  lib: 'ai4s',
  ref: 'a.md',
  title: 'A',
  content: '正文 A',
  mtime: 1,
  ...over,
})

/**
 * 手动可控的 fetch：既能立刻给出响应，也能把响应挂起，用来构造「A 先发、B 后发、
 * A 后到」的竞态——那是本任务的第一条控制器决议。
 */
function deferredFetch() {
  const pending: Array<{
    url: string
    resolve: (r: Response) => void
    reject: (e: unknown) => void
  }> = []
  const mock = vi.fn(
    (input: unknown) =>
      new Promise<Response>((resolve, reject) => {
        pending.push({ url: String(input), resolve, reject })
      }),
  )
  return { mock, pending }
}

/** 只关心「请求在飞」的测试用它：返回永远不落地的响应。 */
function neverResolving() {
  const signals: AbortSignal[] = []
  const mock = vi.fn((_input: unknown, init?: RequestInit) => {
    signals.push(init?.signal as AbortSignal)
    return new Promise<Response>(() => {})
  })
  return { mock, signals }
}

describe('useDoc', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('starts idle with nothing selected', () => {
    const { result } = renderHook(() => useDoc())

    expect(result.current.state).toBe('idle')
    expect(result.current.doc).toBeNull()
    expect(result.current.error).toBeNull()
  })

  it('walks idle → loading → ready and exposes the payload', async () => {
    const { mock, pending } = deferredFetch()
    vi.stubGlobal('fetch', mock)

    const { result } = renderHook(() => useDoc())
    act(() => result.current.open('ai4s', 'a.md'))

    expect(result.current.state).toBe('loading')
    expect(mock).toHaveBeenCalledTimes(1)

    await act(async () => {
      pending[0].resolve(jsonResponse(200, note()))
    })

    await waitFor(() => expect(result.current.state).toBe('ready'))
    expect(result.current.doc?.title).toBe('A')
    expect(result.current.error).toBeNull()
  })

  it('ignores a late response for A when B was opened after it', async () => {
    const { mock, pending } = deferredFetch()
    vi.stubGlobal('fetch', mock)

    const { result } = renderHook(() => useDoc())
    act(() => result.current.open('ai4s', 'a.md'))
    act(() => result.current.open('ai4s', 'b.md'))
    expect(mock).toHaveBeenCalledTimes(2)

    // B 先回、A 后回：若没有 abort/令牌守卫，A 的迟到响应会覆盖 B。
    await act(async () => {
      pending[1].resolve(
        jsonResponse(200, note({ ref: 'b.md', title: 'B', content: '正文 B' })),
      )
    })
    await waitFor(() => expect(result.current.doc?.title).toBe('B'))

    await act(async () => {
      pending[0].resolve(
        jsonResponse(200, note({ ref: 'a.md', title: 'A', content: '正文 A' })),
      )
    })

    expect(result.current.doc?.title).toBe('B')
    expect(result.current.doc?.content).toBe('正文 B')
    expect(result.current.state).toBe('ready')
  })

  it('ignores a late failure for A after B is ready', async () => {
    const { mock, pending } = deferredFetch()
    vi.stubGlobal('fetch', mock)

    const { result } = renderHook(() => useDoc())
    act(() => result.current.open('ai4s', 'a.md'))
    act(() => result.current.open('ai4s', 'b.md'))

    await act(async () => {
      pending[1].resolve(
        jsonResponse(200, note({ ref: 'b.md', title: 'B', content: '正文 B' })),
      )
    })
    await waitFor(() => expect(result.current.state).toBe('ready'))

    await act(async () => {
      pending[0].resolve(jsonResponse(404, { error: 'gone' }))
    })

    expect(result.current.state).toBe('ready')
    expect(result.current.doc?.title).toBe('B')
  })

  it('aborts the in-flight request when another note is opened', () => {
    const { mock, signals } = neverResolving()
    vi.stubGlobal('fetch', mock)

    const { result } = renderHook(() => useDoc())
    act(() => result.current.open('ai4s', 'a.md'))
    act(() => result.current.open('ai4s', 'b.md'))

    expect(mock).toHaveBeenCalledTimes(2)
    expect(signals[0].aborted).toBe(true)
    expect(signals[1].aborted).toBe(false)
  })

  it('does not refetch when the same (lib, ref) is opened again', async () => {
    const { mock, pending } = deferredFetch()
    vi.stubGlobal('fetch', mock)

    const { result } = renderHook(() => useDoc())
    act(() => result.current.open('ai4s', 'a.md'))
    await act(async () => {
      pending[0].resolve(jsonResponse(200, note()))
    })
    await waitFor(() => expect(result.current.state).toBe('ready'))

    // 重复点选同一条：不得再打一次 /doc。
    act(() => result.current.open('ai4s', 'a.md'))
    act(() => result.current.open('ai4s', 'a.md'))

    expect(mock).toHaveBeenCalledTimes(1)
    expect(result.current.state).toBe('ready')
  })

  it('refetches when the ref changes but the lib stays the same', async () => {
    const { mock, pending } = deferredFetch()
    vi.stubGlobal('fetch', mock)

    const { result } = renderHook(() => useDoc())
    act(() => result.current.open('ai4s', 'a.md'))
    await act(async () => {
      pending[0].resolve(jsonResponse(200, note()))
    })
    await waitFor(() => expect(result.current.state).toBe('ready'))

    act(() => result.current.open('ai4s', 'b.md'))

    expect(mock).toHaveBeenCalledTimes(2)
    expect(result.current.state).toBe('loading')
  })

  it('refetches when only the lib changes', async () => {
    const { mock, pending } = deferredFetch()
    vi.stubGlobal('fetch', mock)

    const { result } = renderHook(() => useDoc())
    act(() => result.current.open('ai4s', 'a.md'))
    await act(async () => {
      pending[0].resolve(jsonResponse(200, note()))
    })
    await waitFor(() => expect(result.current.state).toBe('ready'))

    act(() => result.current.open('mito', 'a.md'))

    expect(mock).toHaveBeenCalledTimes(2)
    expect(String(mock.mock.calls[1][0])).toContain('lib=mito')
  })

  it('maps a 404 to missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(404, { error: 'note not found in library vault' }),
        ),
    )

    const { result } = renderHook(() => useDoc())
    act(() => result.current.open('ai4s', 'gone.md'))

    await waitFor(() => expect(result.current.state).toBe('missing'))
    expect(result.current.doc).toBeNull()
  })

  it('maps a 400 to denied and keeps the server reason visible', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(400, { error: 'ref points outside the library vault' }),
        ),
    )

    const { result } = renderHook(() => useDoc())
    act(() => result.current.open('ai4s', '../x.md'))

    await waitFor(() => expect(result.current.state).toBe('denied'))
    expect(result.current.error).toContain('outside the library vault')
  })

  it('maps a rejected fetch to a visible error, never to a blank panel', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
    )

    const { result } = renderHook(() => useDoc())
    act(() => result.current.open('ai4s', 'a.md'))

    await waitFor(() => expect(result.current.state).toBe('error'))
    expect(result.current.error).toBeTruthy()
    expect(result.current.error).not.toBe('')
  })

  it('maps a 500 to a visible server error', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(500, { error: 'note exists but the server could not read it' }),
        ),
    )

    const { result } = renderHook(() => useDoc())
    act(() => result.current.open('ai4s', 'a.md'))

    await waitFor(() => expect(result.current.state).toBe('error'))
    expect(result.current.error).toContain('could not read it')
  })

  // Minor 复审：200 + 空正文 = **空文档**，是一个独立于 `ready` 与 `error` 的呈现态。
  // 归 `error` 会把「文档确实是空的」谎报成「载入原文失败」（错误归因）。
  it('goes to a distinct empty state for a 200 with blank content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, note({ content: '  \n\t' }))),
    )

    const { result } = renderHook(() => useDoc())
    act(() => result.current.open('ai4s', 'blank.md'))

    await waitFor(() => expect(result.current.state).toBe('empty'))
    // 篇目拿到了（标题要能显示），只是没有正文；且不是错误
    expect(result.current.doc?.title).toBe('A')
    expect(result.current.error).toBeNull()
  })

  it('returns to idle on close and drops content from a superseded request', async () => {
    const { mock, pending } = deferredFetch()
    vi.stubGlobal('fetch', mock)

    const { result } = renderHook(() => useDoc())
    act(() => result.current.open('ai4s', 'a.md'))
    act(() => result.current.close())

    expect(result.current.state).toBe('idle')
    expect(result.current.doc).toBeNull()

    await act(async () => {
      pending[0].resolve(jsonResponse(200, note()))
    })

    expect(result.current.state).toBe('idle')
    expect(result.current.doc).toBeNull()
  })

  it('goes back to idle when opened with an empty ref', async () => {
    const { mock, pending } = deferredFetch()
    vi.stubGlobal('fetch', mock)

    const { result } = renderHook(() => useDoc())
    act(() => result.current.open('ai4s', 'a.md'))
    await act(async () => {
      pending[0].resolve(jsonResponse(200, note()))
    })
    await waitFor(() => expect(result.current.state).toBe('ready'))

    act(() => result.current.open('ai4s', ''))

    expect(result.current.state).toBe('idle')
    expect(mock).toHaveBeenCalledTimes(1)
  })

  it('aborts the in-flight request on unmount', () => {
    const { mock, signals } = neverResolving()
    vi.stubGlobal('fetch', mock)

    const { result, unmount } = renderHook(() => useDoc())
    act(() => result.current.open('ai4s', 'a.md'))
    expect(mock).toHaveBeenCalledTimes(1)

    unmount()

    // 卸载必须**真正中断**在飞请求，而不只是让迟到的响应写不进状态。
    // 这里断言 AbortSignal 而不是「console.error 没被调用」：React 19 已移除
    // 「卸载后 setState」的警告，只盯警告的话，把 cleanup 里的 abort 删掉也不会红。
    expect(signals[0].aborted).toBe(true)
  })
})
