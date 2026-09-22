import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocError, fetchDoc } from '../lib/doc'

/** 网络边界（`fetch`）被桩掉：本文件测的是 `fetchDoc` 对真实 HTTP 形状的解读。 */
function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as unknown as Response
}

describe('fetchDoc', () => {
  // `vi.restoreAllMocks()` 撤不掉 `vi.stubGlobal`（它只还原 spy），桩掉的 `fetch`
  // 会漏给下一个用例。本文件全部用 `stubGlobal`，故用配对的 `unstubAllGlobals()`。
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns the note payload on 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          lib: 'ai4s',
          ref: '01-Literature/自噬.md',
          title: '自噬',
          content: '# 标题\n\n正文',
          mtime: 1732000000.5,
        }),
      ),
    )

    const doc = await fetchDoc('ai4s', '01-Literature/自噬.md')

    expect(doc).toEqual({
      lib: 'ai4s',
      ref: '01-Literature/自噬.md',
      title: '自噬',
      content: '# 标题\n\n正文',
      mtime: 1732000000.5,
    })
  })

  it('percent-encodes a CJK/space ref and leaves no raw CJK in the outgoing URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        lib: 'mito',
        ref: '01-Literature/a b/线粒体 自噬.md',
        title: '线粒体 自噬',
        content: 'x',
        mtime: 1,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await fetchDoc('mito', '01-Literature/a b/线粒体 自噬.md')

    const url = String(fetchMock.mock.calls[0][0])
    // 原样的「请求形状」由 URLSearchParams 生成（`/` 走 %2F、空格走 `+`），
    // 而不是被 encodeURIComponent 再套一层。
    expect(url).toBe(
      '/doc?lib=mito&ref=01-Literature%2Fa+b%2F%E7%BA%BF%E7%B2%92%E4%BD%93+%E8%87%AA%E5%99%AC.md',
    )
    // 真正要钉住的是：URL 上不出现裸中文、也不出现未编码的空格。
    expect(url).not.toMatch(/[\u4e00-\u9fff]/)
    expect(url).not.toContain(' ')
    // 服务器按 URL 解码取回的原值必须一字不差（`+` 解成空格）。
    expect(new URLSearchParams(url.slice(url.indexOf('?'))).get('ref')).toBe(
      '01-Literature/a b/线粒体 自噬.md',
    )
  })

  it('maps 404 to a missing error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(404, { error: 'note not found in library vault' }),
      ),
    )

    await expect(fetchDoc('ai4s', 'gone.md')).rejects.toMatchObject({
      kind: 'missing',
      status: 404,
    })
  })

  it('maps 400 to a denied error, distinct from missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(400, { error: 'ref must not contain .. path segments' }),
      ),
    )

    await expect(fetchDoc('ai4s', '../secret.md')).rejects.toMatchObject({
      kind: 'denied',
      status: 400,
    })
  })

  it('maps 500 to a server error carrying the server message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(500, {
          error:
            'note exists but the server could not read it (bad encoding or permission)',
        }),
      ),
    )

    const err = await fetchDoc('ai4s', 'broken.md').then(
      () => null,
      (e: unknown) => e as DocError,
    )
    expect(err?.kind).toBe('server')
    expect(err?.status).toBe(500)
    expect(err?.message).toContain('bad encoding or permission')
  })

  it('reports a server error even when a 500 has an unreadable body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => {
          throw new SyntaxError('Unexpected token <')
        },
      } as unknown as Response),
    )

    await expect(fetchDoc('ai4s', 'broken.md')).rejects.toMatchObject({
      kind: 'server',
      status: 500,
    })
  })

  it('reports a network failure instead of pretending success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
    )

    await expect(fetchDoc('ai4s', 'note.md')).rejects.toMatchObject({
      kind: 'network',
    })
  })

  it('reports a 200 whose body has no text content as a failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { title: '无正文' })),
    )

    await expect(fetchDoc('ai4s', 'note.md')).rejects.toBeInstanceOf(DocError)
  })

  // 篇目存在但文件是空的（或只有空白）：200 的 `content` 是 '' 或纯空白。
  // **这不是失败**（Minor 复审）：请求成功、篇目在、只是没有正文。原先抛
  // `DocError('server')` 会让面板显示「载入原文失败」——把「空文档」谎报成故障。
  // 现在返回它，由 DocPanel 用**空文档**这一独立呈现（不是 `ready` 的正文、也不是 `error`）。
  it.each(['', '   ', ' \n\t '])(
    'returns a 200 whose content is empty or whitespace-only (%j) as an empty note',
    async (content) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          jsonResponse(200, {
            lib: 'ai4s',
            ref: 'blank.md',
            title: '空白篇目',
            content,
            mtime: 1,
          }),
        ),
      )

      const doc = await fetchDoc('ai4s', 'blank.md')

      expect(doc).toEqual({
        lib: 'ai4s',
        ref: 'blank.md',
        title: '空白篇目',
        content,
        mtime: 1,
      })
    },
  )
})
